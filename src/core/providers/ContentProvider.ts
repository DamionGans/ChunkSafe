import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { ContentKind, DiscoveredWorld, ProviderInfo } from '../../shared/types';
import { pathExists, quickDirectoryStats } from '../utils/fsUtils';
import { readMinecraftWorldMeta } from '../utils/nbt';

/**
 * Extensible provider interface allowing ChunkSafe to support:
 * - Vanilla Minecraft saves (active)
 * - Modded launcher saves (Prism, Modrinth, MultiMC, CurseForge instances)
 * - CurseForge addon packs / modpack manifests (future)
 */
export interface ContentProvider {
  readonly id: string;
  readonly kind: ContentKind;
  readonly name: string;
  readonly description: string;
  readonly status: 'active' | 'planned';
  readonly capabilities: string[];

  /** Detects standard OS-specific directories for this content type */
  detectDefaultRoots(): Promise<string[]>;

  /** Scans a root directory and returns discovered syncable items */
  discover(rootPath: string): Promise<DiscoveredWorld[]>;

  /** Returns provider metadata for UI display */
  getInfo(): Promise<ProviderInfo>;
}

/**
 * Active provider for standard Minecraft Java Edition worlds
 * across Windows, macOS, and Linux.
 */
export class VanillaMinecraftProvider implements ContentProvider {
  readonly id = 'vanilla-minecraft';
  readonly kind: ContentKind = 'vanilla-save';
  readonly name = 'Minecraft Java Saves';
  readonly description =
    'Standard Minecraft Java Edition world saves (Windows, macOS, and Linux). Reads level.dat metadata and world icons automatically.';
  readonly status = 'active' as const;
  readonly capabilities = [
    'Auto-detect OS saves folder',
    'level.dat NBT metadata & icons',
    'Deduplicated chunk/region versioning',
    'Single & multi-version management',
  ];

  async detectDefaultRoots(): Promise<string[]> {
    const candidates: string[] = [];
    const platform = process.platform;
    const home = os.homedir();

    if (platform === 'win32') {
      const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
      candidates.push(path.join(appData, '.minecraft', 'saves'));
    } else if (platform === 'darwin') {
      candidates.push(path.join(home, 'Library', 'Application Support', 'minecraft', 'saves'));
    } else {
      // Linux & other UNIX
      candidates.push(path.join(home, '.minecraft', 'saves'));
      // Flatpak Minecraft Launcher
      candidates.push(
        path.join(home, '.var', 'app', 'com.mojang.Minecraft', '.minecraft', 'saves'),
      );
    }

    const existing: string[] = [];
    for (const c of candidates) {
      if (await pathExists(c)) {
        existing.push(c);
      }
    }
    return existing.length > 0 ? existing : [candidates[0]];
  }

  async discover(rootPath: string): Promise<DiscoveredWorld[]> {
    if (!(await pathExists(rootPath))) return [];

    const results: DiscoveredWorld[] = [];
    let entries;
    try {
      entries = await fs.readdir(rootPath, { withFileTypes: true });
    } catch {
      return [];
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const worldDir = path.join(rootPath, entry.name);
      // Verify it looks like a Minecraft save (contains level.dat or level.dat_old)
      const hasLevelDat =
        (await pathExists(path.join(worldDir, 'level.dat'))) ||
        (await pathExists(path.join(worldDir, 'level.dat_old')));
      if (!hasLevelDat) continue;

      const [meta, stats] = await Promise.all([
        readMinecraftWorldMeta(worldDir),
        quickDirectoryStats(worldDir),
      ]);

      results.push({
        localPath: worldDir,
        localRootPath: rootPath,
        folderName: entry.name,
        providerId: this.id,
        contentKind: this.kind,
        totalSize: stats.totalSize,
        fileCount: stats.fileCount,
        lastModifiedAt: meta.lastPlayedAt || stats.lastModifiedAt,
        meta,
      });
    }

    results.sort((a, b) => b.lastModifiedAt - a.lastModifiedAt);
    return results;
  }

  async getInfo(): Promise<ProviderInfo> {
    return {
      id: this.id,
      kind: this.kind,
      name: this.name,
      description: this.description,
      status: this.status,
      detectedRoots: await this.detectDefaultRoots(),
      capabilities: this.capabilities,
    };
  }
}

/**
 * Planned provider scaffold for modded Minecraft instances
 * (Prism Launcher, Modrinth App, MultiMC, CurseForge instances).
 */
export class ModdedSavesProvider implements ContentProvider {
  readonly id = 'modded-saves';
  readonly kind: ContentKind = 'modded-save';
  readonly name = 'Modded Game Saves';
  readonly description =
    'Extensible provider for modded Minecraft instance saves (Prism Launcher, Modrinth App, MultiMC, CurseForge) with mod-loader version tracking.';
  readonly status = 'planned' as const;
  readonly capabilities = [
    'Instance-aware world discovery',
    'Mod loader & version compatibility checks',
    'Config & kubejs/datapack co-sync',
    'Uses the same ChunkSafe version store & P2P/Folder transports',
  ];

  async detectDefaultRoots(): Promise<string[]> {
    const home = os.homedir();
    const candidates: string[] = [];
    if (process.platform === 'win32') {
      const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
      candidates.push(
        path.join(appData, 'PrismLauncher', 'instances'),
        path.join(appData, 'ModrinthApp', 'profiles'),
        path.join(home, 'curseforge', 'minecraft', 'Instances'),
      );
    } else if (process.platform === 'darwin') {
      const appSupport = path.join(home, 'Library', 'Application Support');
      candidates.push(
        path.join(appSupport, 'PrismLauncher', 'instances'),
        path.join(appSupport, 'ModrinthApp', 'profiles'),
        path.join(home, 'Documents', 'curseforge', 'minecraft', 'Instances'),
      );
    } else {
      candidates.push(
        path.join(home, '.local', 'share', 'PrismLauncher', 'instances'),
        path.join(home, '.config', 'ModrinthApp', 'profiles'),
      );
    }

    const existing: string[] = [];
    for (const c of candidates) {
      if (await pathExists(c)) existing.push(c);
    }
    return existing;
  }

  async discover(_rootPath: string): Promise<DiscoveredWorld[]> {
    // Future implementation: iterate launcher instance folders, read instance.cfg / profile.json,
    // attach modLoader metadata, and yield each instance's saves/* as DiscoveredWorld.
    return [];
  }

  async getInfo(): Promise<ProviderInfo> {
    return {
      id: this.id,
      kind: this.kind,
      name: this.name,
      description: this.description,
      status: this.status,
      detectedRoots: await this.detectDefaultRoots(),
      capabilities: this.capabilities,
    };
  }
}

/**
 * Planned provider scaffold for CurseForge addon packs / modpacks.
 */
export class CurseForgePackProvider implements ContentProvider {
  readonly id = 'curseforge-packs';
  readonly kind: ContentKind = 'curseforge-pack';
  readonly name = 'CurseForge Addon Packs';
  readonly description =
    'Extensible provider for synchronising CurseForge modpacks (manifest.json, mod lists, overrides, configs, and resource packs) alongside worlds.';
  readonly status = 'planned' as const;
  readonly capabilities = [
    'CurseForge manifest.json & modlist sync',
    'Custom config & overrides delta sync',
    'Version-pinned modpack snapshots',
    'Peer-to-peer & network folder distribution',
  ];

  async detectDefaultRoots(): Promise<string[]> {
    const home = os.homedir();
    const candidates =
      process.platform === 'win32'
        ? [path.join(home, 'curseforge', 'minecraft', 'Instances')]
        : process.platform === 'darwin'
          ? [path.join(home, 'Documents', 'curseforge', 'minecraft', 'Instances')]
          : [path.join(home, 'curseforge', 'minecraft', 'Instances')];
    const existing: string[] = [];
    for (const c of candidates) {
      if (await pathExists(c)) existing.push(c);
    }
    return existing;
  }

  async discover(_rootPath: string): Promise<DiscoveredWorld[]> {
    // Future implementation: parse minecraftinstance.json / manifest.json in CurseForge instances
    // and treat each pack (mods + config + overrides) as a versioned syncable package.
    return [];
  }

  async getInfo(): Promise<ProviderInfo> {
    return {
      id: this.id,
      kind: this.kind,
      name: this.name,
      description: this.description,
      status: this.status,
      detectedRoots: await this.detectDefaultRoots(),
      capabilities: this.capabilities,
    };
  }
}

export class ProviderRegistry {
  private readonly providers = new Map<string, ContentProvider>();

  constructor() {
    this.register(new VanillaMinecraftProvider());
    this.register(new ModdedSavesProvider());
    this.register(new CurseForgePackProvider());
  }

  register(provider: ContentProvider): void {
    this.providers.set(provider.id, provider);
  }

  get(id: string): ContentProvider | undefined {
    return this.providers.get(id);
  }

  getAll(): ContentProvider[] {
    return Array.from(this.providers.values());
  }

  getActive(): ContentProvider[] {
    return this.getAll().filter((p) => p.status === 'active');
  }

  async listInfo(): Promise<ProviderInfo[]> {
    return Promise.all(this.getAll().map((p) => p.getInfo()));
  }
}
