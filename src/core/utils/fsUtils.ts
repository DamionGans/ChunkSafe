import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { FileEntry } from '../../shared/types';

const IGNORED_FILES = new Set(['session.lock', '.DS_Store', 'Thumbs.db', 'desktop.ini']);

export function toPosixPath(p: string): string {
  return p.split(path.sep).join('/');
}

export function fromPosixPath(p: string): string {
  return p.split('/').join(path.sep);
}

export async function sha256File(filePath: string): Promise<{ sha256: string; size: number; mtimeMs: number }> {
  const [buf, stat] = await Promise.all([fs.readFile(filePath), fs.stat(filePath)]);
  const hash = crypto.createHash('sha256').update(buf).digest('hex');
  return { sha256: hash, size: stat.size, mtimeMs: stat.mtimeMs };
}

export function computeTreeHash(files: FileEntry[]): string {
  const sorted = [...files].sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  const hash = crypto.createHash('sha256');
  for (const f of sorted) {
    hash.update(`${f.relativePath}:${f.sha256}:${f.size}\n`);
  }
  return hash.digest('hex');
}

export async function scanDirectoryFiles(rootDir: string): Promise<{
  files: FileEntry[];
  totalSize: number;
  lastModifiedAt: number;
}> {
  const files: FileEntry[] = [];
  let totalSize = 0;
  let lastModifiedAt = 0;

  async function walk(currentDir: string): Promise<void> {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (IGNORED_FILES.has(entry.name)) continue;
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        const rel = toPosixPath(path.relative(rootDir, fullPath));
        const { sha256, size, mtimeMs } = await sha256File(fullPath);
        files.push({ relativePath: rel, sha256, size, mtimeMs });
        totalSize += size;
        if (mtimeMs > lastModifiedAt) lastModifiedAt = mtimeMs;
      }
    }
  }

  await walk(rootDir);
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return { files, totalSize, lastModifiedAt };
}

export async function quickDirectoryStats(rootDir: string): Promise<{
  totalSize: number;
  fileCount: number;
  lastModifiedAt: number;
}> {
  let totalSize = 0;
  let fileCount = 0;
  let lastModifiedAt = 0;

  async function walk(currentDir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (IGNORED_FILES.has(entry.name)) continue;
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        try {
          const stat = await fs.stat(fullPath);
          totalSize += stat.size;
          fileCount += 1;
          if (stat.mtimeMs > lastModifiedAt) lastModifiedAt = stat.mtimeMs;
        } catch {
          // Ignore transient read errors
        }
      }
    }
  }

  await walk(rootDir);
  return { totalSize, fileCount, lastModifiedAt };
}

export async function atomicWriteFile(filePath: string, data: Buffer | string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  await fs.writeFile(tmpPath, data);
  try {
    await fs.rename(tmpPath, filePath);
  } catch (err) {
    // On Windows/SMB shares, rename over an existing file can occasionally fail; fall back safely
    try {
      await fs.copyFile(tmpPath, filePath);
    } finally {
      await fs.rm(tmpPath, { force: true }).catch(() => {});
    }
    if (!await pathExists(filePath)) {
      throw err;
    }
  }
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function copyDirectoryRecursive(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    if (IGNORED_FILES.has(entry.name)) continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDirectoryRecursive(srcPath, destPath);
    } else if (entry.isFile()) {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

export function sanitizeFolderName(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'World';
}
