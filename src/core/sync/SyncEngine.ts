import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  AppSettings,
  ApplyVersionOptions,
  DiscoveredWorld,
  SyncResult,
  SyncStatus,
  VersionMode,
  VersionRecord,
  VersionSummary,
  WorldManifest,
  WorldSyncConfig,
  WorldViewModel,
} from '../../shared/types';
import { ProviderRegistry } from '../providers/ContentProvider';
import { FolderTransport } from '../transports/FolderTransport';
import { SyncTransport } from '../transports/SyncTransport';
import {
  computeTreeHash,
  copyDirectoryRecursive,
  fromPosixPath,
  pathExists,
  sanitizeFolderName,
  scanDirectoryFiles,
} from '../utils/fsUtils';
import { readMinecraftWorldMeta } from '../utils/nbt';

function toSummary(v: VersionRecord): VersionSummary {
  return {
    versionId: v.versionId,
    parentVersionId: v.parentVersionId,
    branch: v.branch,
    label: v.label,
    notes: v.notes,
    createdAt: v.createdAt,
    lastPlayedAt: v.lastPlayedAt,
    deviceId: v.deviceId,
    deviceName: v.deviceName,
    isConflict: v.isConflict,
    totalSize: v.totalSize,
    fileCount: v.fileCount,
    treeHash: v.treeHash,
    levelName: v.minecraftMeta.levelName,
    mcVersion: v.minecraftMeta.mcVersion,
    gameType: v.minecraftMeta.gameType,
  };
}

function generateVersionId(): string {
  const ts = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const rand = crypto.randomBytes(3).toString('hex');
  return `v-${ts}-${rand}`;
}

function generateWorldId(folderName: string): string {
  const slug = folderName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 24);
  const rand = crypto.randomBytes(4).toString('hex');
  return `${slug || 'world'}-${rand}`;
}

export function mergeManifests(a: WorldManifest, b: WorldManifest): WorldManifest {
  const versionMap = new Map<string, VersionSummary>();
  for (const v of a.versions) versionMap.set(v.versionId, v);
  for (const v of b.versions) versionMap.set(v.versionId, v);

  const versions = Array.from(versionMap.values()).sort((x, y) =>
    y.createdAt.localeCompare(x.createdAt),
  );

  const branches: Record<string, string> = { ...a.branches };
  for (const [branch, verId] of Object.entries(b.branches)) {
    const existingId = branches[branch];
    if (!existingId) {
      branches[branch] = verId;
    } else {
      const va = versionMap.get(existingId);
      const vb = versionMap.get(verId);
      if (vb && (!va || vb.createdAt > va.createdAt)) {
        branches[branch] = verId;
      }
    }
  }

  const defaultBranch = a.defaultBranch || b.defaultBranch || 'main';
  const latestVersionId = branches[defaultBranch] || versions[0]?.versionId || null;
  const updatedAt = a.updatedAt >= b.updatedAt ? a.updatedAt : b.updatedAt;

  return {
    worldId: a.worldId,
    displayName: b.updatedAt > a.updatedAt ? b.displayName : a.displayName,
    folderName: a.folderName || b.folderName,
    contentKind: a.contentKind || b.contentKind,
    providerId: a.providerId || b.providerId,
    defaultBranch,
    branches,
    latestVersionId,
    versions,
    updatedAt,
  };
}

export class SyncEngine {
  constructor(
    private readonly providers: ProviderRegistry,
    private readonly localStore: FolderTransport,
    private readonly backupRoot: string,
    private readonly getSettings: () => AppSettings,
    private readonly saveSettings: (next: AppSettings) => Promise<void>,
  ) {}

  /** Scans all configured save roots across active content providers */
  async discoverLocalWorlds(): Promise<DiscoveredWorld[]> {
    const settings = this.getSettings();
    const discovered: DiscoveredWorld[] = [];
    const seenPaths = new Set<string>();

    for (const root of settings.saveRoots) {
      const provider = this.providers.get(root.providerId);
      if (!provider || provider.status !== 'active') continue;
      const items = await provider.discover(root.path);
      for (const item of items) {
        const key = path.resolve(item.localPath).toLowerCase();
        if (seenPaths.has(key)) continue;
        seenPaths.add(key);
        discovered.push(item);
      }
    }
    return discovered;
  }

  /**
   * Produces a unified view of all local + remote worlds, their sync status,
   * available versions, branches, and conflicts.
   */
  async listWorldViewModels(remote: SyncTransport | null): Promise<WorldViewModel[]> {
    const settings = this.getSettings();
    const discovered = await this.discoverLocalWorlds();

    const localManifests = await this.localStore.listWorlds();
    let remoteManifests: WorldManifest[] = [];
    if (remote) {
      try {
        remoteManifests = await remote.listWorlds();
      } catch {
        remoteManifests = [];
      }
    }

    const manifestById = new Map<string, WorldManifest>();
    for (const m of localManifests) manifestById.set(m.worldId, m);
    for (const m of remoteManifests) {
      const existing = manifestById.get(m.worldId);
      manifestById.set(m.worldId, existing ? mergeManifests(existing, m) : m);
    }

    const remoteIds = new Set(remoteManifests.map((m) => m.worldId));
    const remoteManifestMap = new Map(remoteManifests.map((m) => [m.worldId, m]));

    // Map local discovered worlds to WorldSyncConfig or match by folderName
    const localByWorldId = new Map<string, DiscoveredWorld>();
    let settingsChanged = false;
    const nextWorlds = { ...settings.worlds };

    for (const d of discovered) {
      // 1. Check existing config by localPath or folderName
      let matchedConfig = Object.values(nextWorlds).find(
        (c) =>
          path.resolve(c.localRootPath, c.localFolderName).toLowerCase() ===
          path.resolve(d.localPath).toLowerCase(),
      );

      // 2. If not configured yet, check if a remote/local manifest shares the same folderName + providerId
      if (!matchedConfig) {
        const matchingManifest = Array.from(manifestById.values()).find(
          (m) =>
            m.folderName.toLowerCase() === d.folderName.toLowerCase() &&
            m.providerId === d.providerId &&
            !nextWorlds[m.worldId],
        );

        const worldId = matchingManifest ? matchingManifest.worldId : generateWorldId(d.folderName);
        matchedConfig = {
          worldId,
          localFolderName: d.folderName,
          localRootPath: d.localRootPath,
          providerId: d.providerId,
          contentKind: d.contentKind,
          syncEnabled: false,
          versionMode: 'single',
          activeVersionId: null,
          lastSyncedVersionId: null,
          lastSyncedTreeHash: null,
          lastSyncedAt: null,
        };
        nextWorlds[worldId] = matchedConfig;
        settingsChanged = true;
      }

      localByWorldId.set(matchedConfig.worldId, d);
    }

    if (settingsChanged) {
      await this.saveSettings({ ...settings, worlds: nextWorlds });
    }

    const allWorldIds = new Set<string>([
      ...localByWorldId.keys(),
      ...manifestById.keys(),
    ]);

    const models: WorldViewModel[] = [];

    for (const worldId of allWorldIds) {
      const local = localByWorldId.get(worldId) || null;
      const manifest = manifestById.get(worldId) || null;
      const remoteManifest = remoteManifestMap.get(worldId) || null;
      const cfg = nextWorlds[worldId];

      const hasLocal = local !== null;
      const hasRemote = remoteIds.has(worldId);
      const syncEnabled = cfg?.syncEnabled ?? false;
      const versionMode: VersionMode = cfg?.versionMode ?? 'single';

      const versions = manifest?.versions || [];
      const branches = manifest?.branches || {};
      const conflictVersionIds = versions.filter((v) => v.isConflict).map((v) => v.versionId);

      // Determine sync status
      let status: SyncStatus = 'untracked';
      const latestRemoteVersionId = remoteManifest?.latestVersionId ?? manifest?.latestVersionId ?? null;

      if (!hasLocal && hasRemote) {
        status = 'remote-only';
      } else if (hasLocal && !hasRemote) {
        status = syncEnabled ? 'local-only' : 'untracked';
      } else if (hasLocal && hasRemote) {
        // Quick heuristic based on lastSyncedAt vs localLastModified & remote latestVersionId
        const localChanged =
          !cfg?.lastSyncedAt ||
          (local.lastModifiedAt > new Date(cfg.lastSyncedAt).getTime() + 1500);
        const remoteChanged =
          latestRemoteVersionId !== null && latestRemoteVersionId !== cfg?.lastSyncedVersionId;

        if (conflictVersionIds.length > 0 || (localChanged && remoteChanged && cfg?.lastSyncedVersionId)) {
          status = 'conflict';
        } else if (localChanged && remoteChanged && !cfg?.lastSyncedVersionId) {
          // Both exist independently without a shared base
          status = 'conflict';
        } else if (localChanged) {
          status = 'local-ahead';
        } else if (remoteChanged) {
          status = 'remote-ahead';
        } else {
          status = 'synced';
        }
      }

      models.push({
        worldId,
        displayName: local?.meta.levelName || manifest?.displayName || cfg?.localFolderName || worldId,
        folderName: local?.folderName || manifest?.folderName || cfg?.localFolderName || worldId,
        contentKind: local?.contentKind || manifest?.contentKind || cfg?.contentKind || 'vanilla-save',
        providerId: local?.providerId || manifest?.providerId || cfg?.providerId || 'vanilla-minecraft',
        localPath: local?.localPath || null,
        localRootPath: local?.localRootPath || cfg?.localRootPath || null,
        hasLocal,
        hasRemote,
        syncEnabled,
        versionMode,
        status,
        activeVersionId: cfg?.activeVersionId ?? null,
        latestRemoteVersionId,
        lastSyncedAt: cfg?.lastSyncedAt ?? null,
        localMeta: local?.meta,
        localSize: local?.totalSize,
        localFileCount: local?.fileCount,
        localLastModified: local?.lastModifiedAt,
        versions,
        branches,
        hasConflicts: conflictVersionIds.length > 0 || status === 'conflict',
        conflictVersionIds,
      });
    }

    models.sort((a, b) => {
      if (a.hasConflicts !== b.hasConflicts) return a.hasConflicts ? -1 : 1;
      if (a.syncEnabled !== b.syncEnabled) return a.syncEnabled ? -1 : 1;
      return a.displayName.localeCompare(b.displayName);
    });

    return models;
  }

  /** Toggle whether a world participates in sync */
  async setWorldSyncEnabled(worldId: string, enabled: boolean): Promise<void> {
    const settings = this.getSettings();
    const existing = settings.worlds[worldId];
    if (!existing) return;
    await this.saveSettings({
      ...settings,
      worlds: {
        ...settings.worlds,
        [worldId]: { ...existing, syncEnabled: enabled },
      },
    });
  }

  /** Switch a world between single-version (auto-latest) and multi-version management */
  async setWorldVersionMode(worldId: string, mode: VersionMode): Promise<void> {
    const settings = this.getSettings();
    const existing = settings.worlds[worldId];
    if (!existing) return;
    await this.saveSettings({
      ...settings,
      worlds: {
        ...settings.worlds,
        [worldId]: { ...existing, versionMode: mode },
      },
    });
  }

  /**
   * Creates a local snapshot (VersionRecord) of a local world and saves it into localStore.
   */
  async createLocalSnapshot(
    worldId: string,
    opts?: {
      branch?: string;
      label?: string;
      notes?: string;
      isConflict?: boolean;
      parentVersionId?: string | null;
      remote?: SyncTransport | null;
    },
  ): Promise<{ version: VersionRecord; bytesWritten: number; filesWritten: number }> {
    const settings = this.getSettings();
    const cfg = settings.worlds[worldId];
    if (!cfg) {
      throw new Error(`World ${worldId} is not configured locally.`);
    }

    const worldPath = path.join(cfg.localRootPath, cfg.localFolderName);
    if (!(await pathExists(worldPath))) {
      throw new Error(`Local world folder not found: ${worldPath}`);
    }

    const meta = await readMinecraftWorldMeta(worldPath);
    if (meta.isLocked) {
      throw new Error(
        `World "${meta.levelName}" appears to be open in Minecraft (session.lock is locked). Close the world before syncing.`,
      );
    }

    const { files, totalSize, lastModifiedAt } = await scanDirectoryFiles(worldPath);
    const treeHash = computeTreeHash(files);

    const existingManifest = await this.localStore.getWorldManifest(worldId);
    const branch = opts?.branch || existingManifest?.defaultBranch || 'main';
    const parentVersionId =
      opts?.parentVersionId !== undefined
        ? opts.parentVersionId
        : cfg.activeVersionId || existingManifest?.branches[branch] || null;

    const version: VersionRecord = {
      versionId: generateVersionId(),
      worldId,
      parentVersionId,
      branch,
      label: opts?.label,
      notes: opts?.notes,
      createdAt: new Date().toISOString(),
      lastPlayedAt: meta.lastPlayedAt || lastModifiedAt || Date.now(),
      deviceId: settings.deviceId,
      deviceName: settings.deviceName,
      isConflict: opts?.isConflict ?? false,
      contentKind: cfg.contentKind,
      totalSize,
      fileCount: files.length,
      treeHash,
      files,
      minecraftMeta: meta,
    };

    // Store missing objects in localStore
    const hashes = files.map((f) => f.sha256);
    const missingLocal = new Set(await this.localStore.findMissingObjects(hashes));
    let bytesWritten = 0;
    let filesWritten = 0;

    for (const f of files) {
      if (missingLocal.has(f.sha256)) {
        const raw = await fs.readFile(path.join(worldPath, fromPosixPath(f.relativePath)));
        await this.localStore.putObject(f.sha256, raw);
        missingLocal.delete(f.sha256);
        bytesWritten += raw.length;
        filesWritten += 1;
      }
    }

    await this.localStore.putVersion(version);

    const updatedManifest = this.addVersionToManifest(existingManifest, version, cfg);
    await this.localStore.putWorldManifest(updatedManifest);

    // Update local config
    const nextCfg: WorldSyncConfig = {
      ...cfg,
      activeVersionId: version.versionId,
      lastSyncedTreeHash: treeHash,
    };
    await this.saveSettings({
      ...settings,
      worlds: { ...settings.worlds, [worldId]: nextCfg },
    });

    // If a remote transport was passed, push immediately too
    if (opts?.remote) {
      await this.pushVersionToTransport(version, opts.remote);
      const remoteManifest = await opts.remote.getWorldManifest(worldId);
      const merged = remoteManifest
        ? mergeManifests(remoteManifest, updatedManifest)
        : updatedManifest;
      await opts.remote.putWorldManifest(merged);
      await this.localStore.putWorldManifest(merged);
    }

    return { version, bytesWritten, filesWritten };
  }

  private addVersionToManifest(
    existing: WorldManifest | null,
    version: VersionRecord,
    cfg: WorldSyncConfig,
  ): WorldManifest {
    const summary = toSummary(version);
    const prevVersions = existing?.versions.filter((v) => v.versionId !== version.versionId) || [];
    const versions = [summary, ...prevVersions].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
    const defaultBranch = existing?.defaultBranch || 'main';
    const branches = {
      ...(existing?.branches || {}),
      [version.branch]: version.versionId,
    };
    const latestVersionId =
      branches[defaultBranch] || existing?.latestVersionId || version.versionId;

    return {
      worldId: version.worldId,
      displayName: version.minecraftMeta.levelName,
      folderName: cfg.localFolderName,
      contentKind: version.contentKind,
      providerId: cfg.providerId,
      defaultBranch,
      branches,
      latestVersionId,
      versions,
      updatedAt: version.createdAt,
    };
  }

  private async pushVersionToTransport(
    version: VersionRecord,
    remote: SyncTransport,
  ): Promise<{ bytesTransferred: number; filesTransferred: number }> {
    const hashes = version.files.map((f) => f.sha256);
    const missing = await remote.findMissingObjects(hashes);
    let bytesTransferred = 0;
    let filesTransferred = 0;

    for (const h of missing) {
      const raw = await this.localStore.getObject(h);
      await remote.putObject(h, raw);
      bytesTransferred += raw.length;
      filesTransferred += 1;
    }

    await remote.putVersion(version);
    return { bytesTransferred, filesTransferred };
  }

  private async pullVersionFromTransport(
    worldId: string,
    versionId: string,
    remote: SyncTransport,
  ): Promise<{ version: VersionRecord; bytesTransferred: number; filesTransferred: number }> {
    let version = await this.localStore.getVersion(worldId, versionId);
    if (!version) {
      version = await remote.getVersion(worldId, versionId);
      if (!version) {
        throw new Error(`Version ${versionId} not found on remote for world ${worldId}`);
      }
      await this.localStore.putVersion(version);
    }

    const hashes = version.files.map((f) => f.sha256);
    const missing = await this.localStore.findMissingObjects(hashes);
    let bytesTransferred = 0;
    let filesTransferred = 0;

    for (const h of missing) {
      const raw = await remote.getObject(h);
      await this.localStore.putObject(h, raw);
      bytesTransferred += raw.length;
      filesTransferred += 1;
    }

    return { version, bytesTransferred, filesTransferred };
  }

  /**
   * Synchronises a single world against the given remote transport (Folder or P2P).
   * - Single-version mode (default): updates to last-updated version automatically,
   *   and preserves BOTH versions as a conflict branch if both sides diverged.
   * - Multi-version mode: exchanges all versions/branches without overwriting local save
   *   automatically unless the user chooses a version to apply.
   */
  async syncWorld(worldId: string, remote: SyncTransport): Promise<SyncResult> {
    const settings = this.getSettings();
    const cfg = settings.worlds[worldId];
    const remoteManifest = await remote.getWorldManifest(worldId);

    // Case 1: World only exists remotely -> pull latest into localStore and apply to PC
    if (!cfg || !(await pathExists(path.join(cfg.localRootPath, cfg.localFolderName)))) {
      if (!remoteManifest || !remoteManifest.latestVersionId) {
        return {
          worldId,
          displayName: cfg?.localFolderName || worldId,
          action: 'skipped',
          message: 'World not found locally or remotely.',
          bytesTransferred: 0,
          filesTransferred: 0,
        };
      }

      const { version, bytesTransferred, filesTransferred } = await this.pullVersionFromTransport(
        worldId,
        remoteManifest.latestVersionId,
        remote,
      );
      await this.localStore.putWorldManifest(remoteManifest);

      const defaultRoot =
        cfg?.localRootPath || settings.saveRoots[0]?.path;
      if (!defaultRoot) {
        throw new Error('No local Minecraft saves folder configured.');
      }

      await this.applyVersionToLocal(
        {
          worldId,
          versionId: version.versionId,
          targetRootPath: defaultRoot,
        },
        remote,
      );

      return {
        worldId,
        displayName: remoteManifest.displayName,
        action: 'pulled',
        message: `Downloaded "${remoteManifest.displayName}" (${version.versionId}) to this PC.`,
        newVersionId: version.versionId,
        bytesTransferred,
        filesTransferred,
      };
    }

    const worldPath = path.join(cfg.localRootPath, cfg.localFolderName);
    const meta = await readMinecraftWorldMeta(worldPath);
    if (meta.isLocked) {
      return {
        worldId,
        displayName: meta.levelName,
        action: 'error',
        message: `World "${meta.levelName}" is currently locked by Minecraft. Close the world and retry.`,
        bytesTransferred: 0,
        filesTransferred: 0,
      };
    }

    // Compute exact current local tree hash
    const { files } = await scanDirectoryFiles(worldPath);
    const currentLocalTreeHash = computeTreeHash(files);

    const localChanged =
      !cfg.lastSyncedTreeHash || currentLocalTreeHash !== cfg.lastSyncedTreeHash;
    const remoteLatestId = remoteManifest?.latestVersionId || null;
    const remoteChanged =
      remoteLatestId !== null && remoteLatestId !== cfg.lastSyncedVersionId;

    // Check if local tree actually matches remote latest tree hash (identical content!)
    if (remoteManifest && remoteLatestId) {
      const remoteLatestSummary = remoteManifest.versions.find(
        (v) => v.versionId === remoteLatestId,
      );
      if (remoteLatestSummary && remoteLatestSummary.treeHash === currentLocalTreeHash) {
        // Content is identical! Just align metadata.
        const localManifest = await this.localStore.getWorldManifest(worldId);
        const merged = localManifest
          ? mergeManifests(localManifest, remoteManifest)
          : remoteManifest;
        await this.localStore.putWorldManifest(merged);
        await this.saveSettings({
          ...this.getSettings(),
          worlds: {
            ...this.getSettings().worlds,
            [worldId]: {
              ...cfg,
              activeVersionId: remoteLatestId,
              lastSyncedVersionId: remoteLatestId,
              lastSyncedTreeHash: currentLocalTreeHash,
              lastSyncedAt: new Date().toISOString(),
            },
          },
        });
        return {
          worldId,
          displayName: meta.levelName,
          action: 'up-to-date',
          message: `"${meta.levelName}" is already up to date.`,
          bytesTransferred: 0,
          filesTransferred: 0,
        };
      }
    }

    // Case 2: No remote yet, OR only local changed -> PUSH new version
    if (!remoteManifest || (localChanged && !remoteChanged)) {
      const branch = cfg.versionMode === 'single' ? 'main' : 'main';
      const { version } = await this.createLocalSnapshot(worldId, {
        branch,
        parentVersionId: cfg.lastSyncedVersionId,
      });

      const { bytesTransferred, filesTransferred } = await this.pushVersionToTransport(
        version,
        remote,
      );

      const localManifest = (await this.localStore.getWorldManifest(worldId))!;
      const merged = remoteManifest
        ? mergeManifests(remoteManifest, localManifest)
        : localManifest;
      await remote.putWorldManifest(merged);
      await this.localStore.putWorldManifest(merged);

      const latestSettings = this.getSettings();
      await this.saveSettings({
        ...latestSettings,
        worlds: {
          ...latestSettings.worlds,
          [worldId]: {
            ...latestSettings.worlds[worldId],
            activeVersionId: version.versionId,
            lastSyncedVersionId: version.versionId,
            lastSyncedTreeHash: version.treeHash,
            lastSyncedAt: new Date().toISOString(),
          },
        },
      });

      return {
        worldId,
        displayName: meta.levelName,
        action: 'pushed',
        message: `Pushed new version ${version.versionId} of "${meta.levelName}".`,
        newVersionId: version.versionId,
        bytesTransferred,
        filesTransferred,
      };
    }

    // Case 3: Only remote changed -> PULL
    if (!localChanged && remoteChanged && remoteLatestId) {
      const { version, bytesTransferred, filesTransferred } = await this.pullVersionFromTransport(
        worldId,
        remoteLatestId,
        remote,
      );
      const localManifest = await this.localStore.getWorldManifest(worldId);
      const merged = localManifest
        ? mergeManifests(localManifest, remoteManifest)
        : remoteManifest;
      await this.localStore.putWorldManifest(merged);

      if (cfg.versionMode === 'single') {
        await this.applyVersionToLocal(
          { worldId, versionId: version.versionId },
          remote,
        );
        return {
          worldId,
          displayName: meta.levelName,
          action: 'pulled',
          message: `Updated "${meta.levelName}" to latest version ${version.versionId} from ${version.deviceName}.`,
          newVersionId: version.versionId,
          bytesTransferred,
          filesTransferred,
        };
      } else {
        // Multi-version mode: fetch version into local store, let user choose when to apply
        return {
          worldId,
          displayName: meta.levelName,
          action: 'pulled',
          message: `Fetched new remote version ${version.versionId} into version history (Multi-Version mode: local save unchanged).`,
          newVersionId: version.versionId,
          bytesTransferred,
          filesTransferred,
        };
      }
    }

    // Case 4: BOTH local and remote changed -> CONFLICT! Preserve BOTH versions cleanly.
    if (localChanged && remoteChanged && remoteLatestId) {
      // 1. Pull remote latest into localStore so both are available locally
      const pulled = await this.pullVersionFromTransport(worldId, remoteLatestId, remote);

      // 2. Snapshot local changes onto a conflict branch so nothing is ever lost
      const conflictBranch = `conflict-${sanitizeFolderName(settings.deviceName).toLowerCase()}-${Date.now().toString(36).slice(-4)}`;
      const { version: conflictVer } = await this.createLocalSnapshot(worldId, {
        branch: conflictBranch,
        label: `Conflict from ${settings.deviceName}`,
        notes: `Diverged from base ${cfg.lastSyncedVersionId || 'initial'} while remote advanced to ${remoteLatestId}.`,
        isConflict: true,
        parentVersionId: cfg.lastSyncedVersionId,
      });

      const pushed = await this.pushVersionToTransport(conflictVer, remote);

      const localManifest = (await this.localStore.getWorldManifest(worldId))!;
      const merged = mergeManifests(remoteManifest, localManifest);
      // Keep remote's main branch as default latest until user resolves
      merged.branches[merged.defaultBranch] = remoteLatestId;
      merged.latestVersionId = remoteLatestId;

      await remote.putWorldManifest(merged);
      await this.localStore.putWorldManifest(merged);

      return {
        worldId,
        displayName: meta.levelName,
        action: 'conflict',
        message: `Conflict detected for "${meta.levelName}"! Both local (${conflictVer.versionId}) and remote (${remoteLatestId}) versions have been preserved. Choose which version to use on this PC.`,
        newVersionId: remoteLatestId,
        conflictVersionId: conflictVer.versionId,
        bytesTransferred: pulled.bytesTransferred + pushed.bytesTransferred,
        filesTransferred: pulled.filesTransferred + pushed.filesTransferred,
      };
    }

    return {
      worldId,
      displayName: meta.levelName,
      action: 'up-to-date',
      message: `"${meta.levelName}" is up to date.`,
      bytesTransferred: 0,
      filesTransferred: 0,
    };
  }

  /** Syncs all worlds that the user has enabled for synchronisation */
  async syncAllEnabled(remote: SyncTransport): Promise<SyncResult[]> {
    const worlds = await this.listWorldViewModels(remote);
    const results: SyncResult[] = [];

    for (const w of worlds) {
      if (!w.syncEnabled) continue;
      try {
        const res = await this.syncWorld(w.worldId, remote);
        results.push(res);
      } catch (err) {
        results.push({
          worldId: w.worldId,
          displayName: w.displayName,
          action: 'error',
          message: err instanceof Error ? err.message : String(err),
          bytesTransferred: 0,
          filesTransferred: 0,
        });
      }
    }
    return results;
  }

  /**
   * Applies ANY selected version of a world onto this computer's Minecraft saves folder.
   * Supports:
   * - Replacing the existing local save (with automatic safety backup)
   * - Installing side-by-side under a new folder name (multi-version play!)
   * - Promoting the selected version to `main` (resolving conflicts)
   */
  async applyVersionToLocal(
    options: ApplyVersionOptions,
    remote: SyncTransport | null,
  ): Promise<{ appliedPath: string; backupPath: string | null; version: VersionRecord }> {
    const settings = this.getSettings();
    let version = await this.localStore.getVersion(options.worldId, options.versionId);

    if (!version && remote) {
      const pulled = await this.pullVersionFromTransport(
        options.worldId,
        options.versionId,
        remote,
      );
      version = pulled.version;
    } else if (version && remote) {
      // Ensure all objects for this version exist in localStore
      const missing = await this.localStore.findMissingObjects(version.files.map((f) => f.sha256));
      for (const h of missing) {
        const raw = await remote.getObject(h);
        await this.localStore.putObject(h, raw);
      }
    }

    if (!version) {
      throw new Error(`Version ${options.versionId} not found for world ${options.worldId}.`);
    }

    const existingCfg = settings.worlds[options.worldId];
    const manifest =
      (await this.localStore.getWorldManifest(options.worldId)) ||
      (remote ? await remote.getWorldManifest(options.worldId) : null);

    const targetRoot =
      options.targetRootPath ||
      existingCfg?.localRootPath ||
      settings.saveRoots[0]?.path;

    if (!targetRoot) {
      throw new Error('No local Minecraft saves directory configured.');
    }

    const folderName = options.installAsNewFolderName
      ? sanitizeFolderName(options.installAsNewFolderName)
      : existingCfg?.localFolderName || manifest?.folderName || sanitizeFolderName(version.minecraftMeta.folderName);

    const targetPath = path.join(targetRoot, folderName);
    let backupPath: string | null = null;

    // Check lock & create safety backup if overwriting an existing world
    if (await pathExists(targetPath)) {
      const existingMeta = await readMinecraftWorldMeta(targetPath);
      if (existingMeta.isLocked) {
        throw new Error(
          `Cannot overwrite "${existingMeta.levelName}" while it is open in Minecraft.`,
        );
      }

      if (settings.autoBackupBeforeOverwrite && !options.installAsNewFolderName) {
        const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
        backupPath = path.join(this.backupRoot, `${folderName}-${stamp}`);
        await copyDirectoryRecursive(targetPath, backupPath);
      }
    }

    // Materialize version into a temporary staging directory first for atomic swap
    const stagingPath = `${targetPath}.chunksafe-staging-${crypto.randomBytes(4).toString('hex')}`;
    await fs.mkdir(stagingPath, { recursive: true });

    try {
      for (const f of version.files) {
        const raw = await this.localStore.getObject(f.sha256);
        const destFile = path.join(stagingPath, fromPosixPath(f.relativePath));
        await fs.mkdir(path.dirname(destFile), { recursive: true });
        await fs.writeFile(destFile, raw);
      }

      if (await pathExists(targetPath)) {
        await fs.rm(targetPath, { recursive: true, force: true });
      }
      await fs.rename(stagingPath, targetPath);
    } catch (err) {
      await fs.rm(stagingPath, { recursive: true, force: true }).catch(() => {});
      throw err;
    }

    // Optionally promote this version to `main` (resolving conflicts)
    if (options.promoteToMain && manifest) {
      const updatedVersions = manifest.versions.map((v) =>
        v.versionId === version!.versionId ? { ...v, isConflict: false } : v,
      );
      // Also clear conflict flags if user explicitly resolved via promoteToMain
      const resolvedManifest: WorldManifest = {
        ...manifest,
        branches: {
          ...manifest.branches,
          [manifest.defaultBranch || 'main']: version.versionId,
        },
        latestVersionId: version.versionId,
        versions: updatedVersions,
        updatedAt: new Date().toISOString(),
      };
      await this.localStore.putWorldManifest(resolvedManifest);
      if (remote) {
        await remote.putWorldManifest(resolvedManifest);
      }
    }

    // Update settings if we applied into the primary world folder (not a side-by-side copy)
    if (!options.installAsNewFolderName) {
      const latestSettings = this.getSettings();
      const updatedCfg: WorldSyncConfig = {
        worldId: options.worldId,
        localFolderName: folderName,
        localRootPath: targetRoot,
        providerId: existingCfg?.providerId || manifest?.providerId || 'vanilla-minecraft',
        contentKind: existingCfg?.contentKind || manifest?.contentKind || version.contentKind,
        syncEnabled: existingCfg?.syncEnabled ?? true,
        versionMode: existingCfg?.versionMode ?? 'single',
        activeVersionId: version.versionId,
        lastSyncedVersionId: options.promoteToMain
          ? version.versionId
          : manifest?.latestVersionId || version.versionId,
        lastSyncedTreeHash: version.treeHash,
        lastSyncedAt: new Date().toISOString(),
      };
      await this.saveSettings({
        ...latestSettings,
        worlds: {
          ...latestSettings.worlds,
          [options.worldId]: updatedCfg,
        },
      });
    }

    return { appliedPath: targetPath, backupPath, version };
  }
}
