import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { DestinationStatus, VersionRecord, WorldManifest } from '../../shared/types';
import { atomicWriteFile, pathExists } from '../utils/fsUtils';
import { SyncTransport } from './SyncTransport';

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

/**
 * Content-addressed, deduplicated repository stored in any local folder,
 * external drive, NAS / SMB network share, or cloud-synced directory.
 *
 * Repository layout:
 *   <repoRoot>/
 *     chunksafe.repo.json
 *     objects/<aa>/<sha256>.gz
 *     worlds/<worldId>/manifest.json
 *     worlds/<worldId>/versions/<versionId>.json
 */
export class FolderTransport implements SyncTransport {
  readonly kind = 'folder' as const;
  readonly label: string;

  constructor(private readonly repoRoot: string, label?: string) {
    this.label = label || repoRoot;
  }

  get rootPath(): string {
    return this.repoRoot;
  }

  private objectsDir(): string {
    return path.join(this.repoRoot, 'objects');
  }

  private objectPath(sha256: string): string {
    const clean = sha256.toLowerCase().replace(/[^a-f0-9]/g, '');
    return path.join(this.objectsDir(), clean.slice(0, 2), `${clean}.gz`);
  }

  private worldsDir(): string {
    return path.join(this.repoRoot, 'worlds');
  }

  private worldDir(worldId: string): string {
    const safe = worldId.replace(/[^a-zA-Z0-9_-]/g, '');
    return path.join(this.worldsDir(), safe);
  }

  private manifestPath(worldId: string): string {
    return path.join(this.worldDir(worldId), 'manifest.json');
  }

  private versionPath(worldId: string, versionId: string): string {
    const safeVer = versionId.replace(/[^a-zA-Z0-9_.-]/g, '');
    return path.join(this.worldDir(worldId), 'versions', `${safeVer}.json`);
  }

  async ensureInitialized(): Promise<void> {
    await fs.mkdir(this.objectsDir(), { recursive: true });
    await fs.mkdir(this.worldsDir(), { recursive: true });
    const markerPath = path.join(this.repoRoot, 'chunksafe.repo.json');
    if (!(await pathExists(markerPath))) {
      await atomicWriteFile(
        markerPath,
        JSON.stringify(
          {
            formatVersion: 1,
            createdAt: new Date().toISOString(),
            app: 'ChunkSafe',
          },
          null,
          2,
        ),
      );
    }
  }

  async getStatus(): Promise<DestinationStatus> {
    if (!this.repoRoot || this.repoRoot.trim().length === 0) {
      return {
        type: 'folder',
        connected: false,
        label: 'No sync folder configured',
        detail: 'Choose a local folder or network share to start syncing.',
        worldCount: 0,
      };
    }

    try {
      await this.ensureInitialized();
      const worlds = await this.listWorlds();
      let objectCount = 0;
      let totalStorageBytes = 0;

      const objRoot = this.objectsDir();
      if (await pathExists(objRoot)) {
        const shards = await fs.readdir(objRoot, { withFileTypes: true });
        for (const shard of shards) {
          if (!shard.isDirectory()) continue;
          const shardPath = path.join(objRoot, shard.name);
          const objs = await fs.readdir(shardPath, { withFileTypes: true });
          for (const obj of objs) {
            if (!obj.isFile()) continue;
            objectCount += 1;
            const st = await fs.stat(path.join(shardPath, obj.name));
            totalStorageBytes += st.size;
          }
        }
      }

      return {
        type: 'folder',
        connected: true,
        label: this.label,
        detail: this.repoRoot,
        worldCount: worlds.length,
        objectCount,
        totalStorageBytes,
      };
    } catch (err) {
      return {
        type: 'folder',
        connected: false,
        label: this.label,
        detail: err instanceof Error ? err.message : String(err),
        worldCount: 0,
      };
    }
  }

  async listWorlds(): Promise<WorldManifest[]> {
    await this.ensureInitialized();
    const root = this.worldsDir();
    if (!(await pathExists(root))) return [];
    const entries = await fs.readdir(root, { withFileTypes: true });
    const manifests: WorldManifest[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const m = await this.getWorldManifest(entry.name);
      if (m) manifests.push(m);
    }
    manifests.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return manifests;
  }

  async getWorldManifest(worldId: string): Promise<WorldManifest | null> {
    const p = this.manifestPath(worldId);
    if (!(await pathExists(p))) return null;
    try {
      const text = await fs.readFile(p, 'utf8');
      return JSON.parse(text) as WorldManifest;
    } catch {
      return null;
    }
  }

  async putWorldManifest(manifest: WorldManifest): Promise<void> {
    await this.ensureInitialized();
    await atomicWriteFile(this.manifestPath(manifest.worldId), JSON.stringify(manifest, null, 2));
  }

  async getVersion(worldId: string, versionId: string): Promise<VersionRecord | null> {
    const p = this.versionPath(worldId, versionId);
    if (!(await pathExists(p))) return null;
    try {
      const text = await fs.readFile(p, 'utf8');
      return JSON.parse(text) as VersionRecord;
    } catch {
      return null;
    }
  }

  async putVersion(version: VersionRecord): Promise<void> {
    await this.ensureInitialized();
    await atomicWriteFile(
      this.versionPath(version.worldId, version.versionId),
      JSON.stringify(version, null, 2),
    );
  }

  async findMissingObjects(hashes: string[]): Promise<string[]> {
    await this.ensureInitialized();
    const unique = Array.from(new Set(hashes));
    const missing: string[] = [];
    for (const h of unique) {
      if (!(await pathExists(this.objectPath(h)))) {
        missing.push(h);
      }
    }
    return missing;
  }

  async putObject(sha256: string, rawData: Buffer): Promise<void> {
    await this.ensureInitialized();
    const target = this.objectPath(sha256);
    if (await pathExists(target)) return; // Already deduplicated
    const compressed = await gzip(rawData);
    await atomicWriteFile(target, compressed);
  }

  async getObject(sha256: string): Promise<Buffer> {
    const target = this.objectPath(sha256);
    const compressed = await fs.readFile(target);
    return gunzip(compressed);
  }
}
