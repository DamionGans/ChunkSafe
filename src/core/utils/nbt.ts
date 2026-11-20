import zlib from 'node:zlib';
import fs from 'node:fs/promises';
import path from 'node:path';
import { MinecraftWorldMeta } from '../../shared/types';

// NBT Tag IDs
const TAG_END = 0;
const TAG_BYTE = 1;
const TAG_SHORT = 2;
const TAG_INT = 3;
const TAG_LONG = 4;
const TAG_FLOAT = 5;
const TAG_DOUBLE = 6;
const TAG_BYTE_ARRAY = 7;
const TAG_STRING = 8;
const TAG_LIST = 9;
const TAG_COMPOUND = 10;
const TAG_INT_ARRAY = 11;
const TAG_LONG_ARRAY = 12;

type NbtValue =
  | number
  | bigint
  | string
  | Buffer
  | NbtValue[]
  | { [key: string]: NbtValue };

class BufferReader {
  offset = 0;
  constructor(private readonly buf: Buffer) {}

  readByte(): number {
    const v = this.buf.readInt8(this.offset);
    this.offset += 1;
    return v;
  }

  readUByte(): number {
    const v = this.buf.readUInt8(this.offset);
    this.offset += 1;
    return v;
  }

  readShort(): number {
    const v = this.buf.readInt16BE(this.offset);
    this.offset += 2;
    return v;
  }

  readUShort(): number {
    const v = this.buf.readUInt16BE(this.offset);
    this.offset += 2;
    return v;
  }

  readInt(): number {
    const v = this.buf.readInt32BE(this.offset);
    this.offset += 4;
    return v;
  }

  readLong(): bigint {
    const v = this.buf.readBigInt64BE(this.offset);
    this.offset += 8;
    return v;
  }

  readFloat(): number {
    const v = this.buf.readFloatBE(this.offset);
    this.offset += 4;
    return v;
  }

  readDouble(): number {
    const v = this.buf.readDoubleBE(this.offset);
    this.offset += 8;
    return v;
  }

  readString(): string {
    const len = this.readUShort();
    const str = this.buf.subarray(this.offset, this.offset + len).toString('utf8');
    this.offset += len;
    return str;
  }

  skip(bytes: number): void {
    this.offset += bytes;
  }
}

function readTagPayload(reader: BufferReader, tagType: number): NbtValue {
  switch (tagType) {
    case TAG_BYTE:
      return reader.readByte();
    case TAG_SHORT:
      return reader.readShort();
    case TAG_INT:
      return reader.readInt();
    case TAG_LONG:
      return reader.readLong();
    case TAG_FLOAT:
      return reader.readFloat();
    case TAG_DOUBLE:
      return reader.readDouble();
    case TAG_BYTE_ARRAY: {
      const len = reader.readInt();
      reader.skip(len);
      return Buffer.alloc(0);
    }
    case TAG_STRING:
      return reader.readString();
    case TAG_LIST: {
      const elemType = reader.readUByte();
      const len = reader.readInt();
      const arr: NbtValue[] = [];
      for (let i = 0; i < len; i++) {
        arr.push(readTagPayload(reader, elemType));
      }
      return arr;
    }
    case TAG_COMPOUND: {
      const obj: { [key: string]: NbtValue } = {};
      while (true) {
        const type = reader.readUByte();
        if (type === TAG_END) break;
        const name = reader.readString();
        obj[name] = readTagPayload(reader, type);
      }
      return obj;
    }
    case TAG_INT_ARRAY: {
      const len = reader.readInt();
      reader.skip(len * 4);
      return [];
    }
    case TAG_LONG_ARRAY: {
      const len = reader.readInt();
      reader.skip(len * 8);
      return [];
    }
    default:
      throw new Error(`Unsupported NBT tag type: ${tagType}`);
  }
}

/**
 * Parses a gzipped or uncompressed Minecraft NBT buffer (e.g., level.dat).
 */
export function parseNbtBuffer(raw: Buffer): Record<string, NbtValue> {
  const isGzip = raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b;
  const buf = isGzip ? zlib.gunzipSync(raw) : raw;
  const reader = new BufferReader(buf);
  const rootType = reader.readUByte();
  if (rootType !== TAG_COMPOUND) {
    throw new Error(`Expected root TAG_Compound, got ${rootType}`);
  }
  reader.readString(); // root name (usually empty)
  return readTagPayload(reader, TAG_COMPOUND) as Record<string, NbtValue>;
}

/**
 * Builds a minimal gzipped level.dat buffer (useful for tests & fixtures).
 */
export function createMinimalLevelDat(opts: {
  levelName: string;
  lastPlayed?: number;
  gameType?: number;
  mcVersion?: string;
  hardcore?: boolean;
}): Buffer {
  const parts: Buffer[] = [];
  const pushStr = (s: string) => {
    const b = Buffer.from(s, 'utf8');
    const len = Buffer.alloc(2);
    len.writeUInt16BE(b.length);
    parts.push(len, b);
  };
  const pushByte = (v: number) => parts.push(Buffer.from([v & 0xff]));
  const pushInt = (v: number) => {
    const b = Buffer.alloc(4);
    b.writeInt32BE(v);
    parts.push(b);
  };
  const pushLong = (v: bigint) => {
    const b = Buffer.alloc(8);
    b.writeBigInt64BE(v);
    parts.push(b);
  };

  // Root compound ""
  pushByte(TAG_COMPOUND);
  pushStr('');
  // Data compound
  pushByte(TAG_COMPOUND);
  pushStr('Data');

  pushByte(TAG_STRING);
  pushStr('LevelName');
  pushStr(opts.levelName);

  pushByte(TAG_INT);
  pushStr('GameType');
  pushInt(opts.gameType ?? 0);

  pushByte(TAG_LONG);
  pushStr('LastPlayed');
  pushLong(BigInt(opts.lastPlayed ?? Date.now()));

  pushByte(TAG_BYTE);
  pushStr('hardcore');
  pushByte(opts.hardcore ? 1 : 0);

  if (opts.mcVersion) {
    pushByte(TAG_COMPOUND);
    pushStr('Version');
    pushByte(TAG_STRING);
    pushStr('Name');
    pushStr(opts.mcVersion);
    pushByte(TAG_END);
  }

  // End Data
  pushByte(TAG_END);
  // End Root
  pushByte(TAG_END);

  return zlib.gzipSync(Buffer.concat(parts));
}

function mapGameType(gt: unknown): MinecraftWorldMeta['gameType'] {
  switch (gt) {
    case 0:
      return 'Survival';
    case 1:
      return 'Creative';
    case 2:
      return 'Adventure';
    case 3:
      return 'Spectator';
    default:
      return 'Unknown';
  }
}

export async function readMinecraftWorldMeta(worldDir: string): Promise<MinecraftWorldMeta> {
  const folderName = path.basename(worldDir);
  const meta: MinecraftWorldMeta = {
    levelName: folderName,
    folderName,
    gameType: 'Unknown',
  };

  const levelDatPath = path.join(worldDir, 'level.dat');
  try {
    const raw = await fs.readFile(levelDatPath);
    const parsed = parseNbtBuffer(raw);
    const data = parsed['Data'] as Record<string, NbtValue> | undefined;
    if (data && typeof data === 'object') {
      if (typeof data['LevelName'] === 'string' && data['LevelName'].trim().length > 0) {
        meta.levelName = data['LevelName'];
      }
      meta.gameType = mapGameType(data['GameType']);
      if (typeof data['LastPlayed'] === 'bigint') {
        meta.lastPlayedAt = Number(data['LastPlayed']);
      }
      if (typeof data['hardcore'] === 'number') {
        meta.hardcore = data['hardcore'] === 1;
      }
      const ver = data['Version'] as Record<string, NbtValue> | undefined;
      if (ver && typeof ver['Name'] === 'string') {
        meta.mcVersion = ver['Name'];
      }
    }
  } catch {
    // Fallback to folder name if level.dat is missing or unreadable
  }

  // Read optional icon.png
  const iconPath = path.join(worldDir, 'icon.png');
  try {
    const iconBuf = await fs.readFile(iconPath);
    meta.iconDataUrl = `data:image/png;base64,${iconBuf.toString('base64')}`;
  } catch {
    // No icon.png
  }

  // Check if session.lock is actively locked (best-effort)
  const lockPath = path.join(worldDir, 'session.lock');
  try {
    const stat = await fs.stat(lockPath);
    // Minecraft touches session.lock while playing; we expose existence as a soft hint only if locked
    if (stat.isFile()) {
      try {
        const fh = await fs.open(lockPath, 'r+');
        await fh.close();
        meta.isLocked = false;
      } catch {
        meta.isLocked = true;
      }
    }
  } catch {
    meta.isLocked = false;
  }

  return meta;
}
