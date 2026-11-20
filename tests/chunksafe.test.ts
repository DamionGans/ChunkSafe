import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMinimalLevelDat, readMinecraftWorldMeta } from '../src/core/utils/nbt';
import { ProviderRegistry } from '../src/core/providers/ContentProvider';
import { FolderTransport } from '../src/core/transports/FolderTransport';
import { P2PClientTransport, P2PServer } from '../src/core/transports/P2PTransport';
import { SyncEngine } from '../src/core/sync/SyncEngine';
import { AppSettings } from '../src/shared/types';

async function createFakeWorld(
  savesDir: string,
  folderName: string,
  opts: { levelName: string; regionContent: string; mcVersion?: string; lastPlayed?: number },
): Promise<string> {
  const worldDir = path.join(savesDir, folderName);
  await fs.mkdir(path.join(worldDir, 'region'), { recursive: true });
  const levelDat = createMinimalLevelDat({
    levelName: opts.levelName,
    mcVersion: opts.mcVersion || '1.21.4',
    gameType: 0,
    lastPlayed: opts.lastPlayed || Date.now(),
  });
  await fs.writeFile(path.join(worldDir, 'level.dat'), levelDat);
  await fs.writeFile(path.join(worldDir, 'region', 'r.0.0.mca'), opts.regionContent, 'utf8');
  return worldDir;
}

function makeDeviceEngine(
  deviceId: string,
  deviceName: string,
  savesDir: string,
  localRepoDir: string,
  backupDir: string,
) {
  const providers = new ProviderRegistry();
  const localStore = new FolderTransport(localRepoDir, `${deviceName} Repo`);
  let settings: AppSettings = {
    deviceId,
    deviceName,
    saveRoots: [
      {
        path: savesDir,
        providerId: 'vanilla-minecraft',
        label: 'Test Saves',
        isDefault: true,
      },
    ],
    activeDestination: 'folder',
    folderSyncPath: '',
    selectedPeerId: null,
    p2pEnabled: false,
    p2pPort: 0,
    p2pDiscoveryPort: 0,
    p2pPairingCode: 'TEST99',
    savedPeers: [],
    autoBackupBeforeOverwrite: true,
    worlds: {},
  };

  const engine = new SyncEngine(
    providers,
    localStore,
    backupDir,
    () => settings,
    async (next) => {
      settings = next;
    },
  );

  return { engine, localStore, getSettings: () => settings };
}

describe('ChunkSafe Core Engine', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'chunksafe-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('parses gzipped Minecraft level.dat NBT metadata accurately', async () => {
    const saves = path.join(tmpRoot, 'saves');
    const worldDir = await createFakeWorld(saves, 'MySurvival', {
      levelName: 'Overworld Prime',
      regionContent: 'chunk-data-v1',
      mcVersion: '1.21.4',
      lastPlayed: 1730000000000,
    });

    const meta = await readMinecraftWorldMeta(worldDir);
    expect(meta.levelName).toBe('Overworld Prime');
    expect(meta.mcVersion).toBe('1.21.4');
    expect(meta.gameType).toBe('Survival');
    expect(meta.lastPlayedAt).toBe(1730000000000);
  });

  it('syncs only selected worlds via FolderTransport and auto-updates single version to latest', async () => {
    const savesA = path.join(tmpRoot, 'pcA', 'saves');
    const savesB = path.join(tmpRoot, 'pcB', 'saves');
    const sharedRepoDir = path.join(tmpRoot, 'shared-nas-folder');
    await fs.mkdir(savesA, { recursive: true });
    await fs.mkdir(savesB, { recursive: true });

    await createFakeWorld(savesA, 'SurvivalMain', {
      levelName: 'Survival Main',
      regionContent: 'base-house-v1',
    });
    await createFakeWorld(savesA, 'PrivateTest', {
      levelName: 'Private Test',
      regionContent: 'do-not-sync',
    });

    const shared = new FolderTransport(sharedRepoDir, 'NAS Share');
    const devA = makeDeviceEngine(
      'dev-a',
      'Desktop-A',
      savesA,
      path.join(tmpRoot, 'pcA', 'repo'),
      path.join(tmpRoot, 'pcA', 'backups'),
    );
    const devB = makeDeviceEngine(
      'dev-b',
      'Laptop-B',
      savesB,
      path.join(tmpRoot, 'pcB', 'repo'),
      path.join(tmpRoot, 'pcB', 'backups'),
    );

    // PC A discovers both worlds, enables sync ONLY for SurvivalMain
    const worldsA = await devA.engine.listWorldViewModels(shared);
    expect(worldsA.length).toBe(2);
    const mainWorld = worldsA.find((w) => w.folderName === 'SurvivalMain')!;
    await devA.engine.setWorldSyncEnabled(mainWorld.worldId, true);

    const resultsA = await devA.engine.syncAllEnabled(shared);
    expect(resultsA.length).toBe(1);
    expect(resultsA[0].action).toBe('pushed');

    // Shared folder should contain ONLY SurvivalMain
    const remoteWorlds = await shared.listWorlds();
    expect(remoteWorlds.length).toBe(1);
    expect(remoteWorlds[0].folderName).toBe('SurvivalMain');

    // PC B sees remote-only world and syncs it to its PC
    const worldsB = await devB.engine.listWorldViewModels(shared);
    expect(worldsB.length).toBe(1);
    expect(worldsB[0].status).toBe('remote-only');

    const pullRes = await devB.engine.syncWorld(mainWorld.worldId, shared);
    expect(pullRes.action).toBe('pulled');
    const contentOnB = await fs.readFile(
      path.join(savesB, 'SurvivalMain', 'region', 'r.0.0.mca'),
      'utf8',
    );
    expect(contentOnB).toBe('base-house-v1');

    // PC B plays and modifies the world, then pushes v2
    await fs.writeFile(
      path.join(savesB, 'SurvivalMain', 'region', 'r.0.0.mca'),
      'castle-built-on-laptop-v2',
      'utf8',
    );
    const pushB = await devB.engine.syncWorld(mainWorld.worldId, shared);
    expect(pushB.action).toBe('pushed');

    // PC A syncs -> single-version mode automatically updates PC A to v2!
    const pullA = await devA.engine.syncWorld(mainWorld.worldId, shared);
    expect(pullA.action).toBe('pulled');
    const contentOnA = await fs.readFile(
      path.join(savesA, 'SurvivalMain', 'region', 'r.0.0.mca'),
      'utf8',
    );
    expect(contentOnA).toBe('castle-built-on-laptop-v2');
  });

  it('detects conflicts, preserves both versions, and lets user choose version or install side-by-side', async () => {
    const savesA = path.join(tmpRoot, 'pcA', 'saves');
    const savesB = path.join(tmpRoot, 'pcB', 'saves');
    const sharedRepoDir = path.join(tmpRoot, 'shared-folder');
    await fs.mkdir(savesA, { recursive: true });
    await fs.mkdir(savesB, { recursive: true });

    await createFakeWorld(savesA, 'SharedRealm', {
      levelName: 'Shared Realm',
      regionContent: 'v1-shared-base',
    });

    const shared = new FolderTransport(sharedRepoDir);
    const devA = makeDeviceEngine(
      'dev-a',
      'Desktop-A',
      savesA,
      path.join(tmpRoot, 'pcA', 'repo'),
      path.join(tmpRoot, 'pcA', 'backups'),
    );
    const devB = makeDeviceEngine(
      'dev-b',
      'Laptop-B',
      savesB,
      path.join(tmpRoot, 'pcB', 'repo'),
      path.join(tmpRoot, 'pcB', 'backups'),
    );

    const [w] = await devA.engine.listWorldViewModels(shared);
    await devA.engine.setWorldSyncEnabled(w.worldId, true);
    await devA.engine.syncWorld(w.worldId, shared);
    await devB.engine.syncWorld(w.worldId, shared);

    // Both PC A and PC B edit offline!
    await fs.writeFile(
      path.join(savesA, 'SharedRealm', 'region', 'r.0.0.mca'),
      'desktop-nether-hub',
      'utf8',
    );
    await fs.writeFile(
      path.join(savesB, 'SharedRealm', 'region', 'r.0.0.mca'),
      'laptop-end-farm',
      'utf8',
    );

    // PC A pushes first
    const resA = await devA.engine.syncWorld(w.worldId, shared);
    expect(resA.action).toBe('pushed');

    // PC B syncs -> CONFLICT! Both versions preserved
    const resB = await devB.engine.syncWorld(w.worldId, shared);
    expect(resB.action).toBe('conflict');
    expect(resB.conflictVersionId).toBeTruthy();
    expect(resB.newVersionId).toBeTruthy();

    // User on PC B can install PC A's version side-by-side AND keep their own version!
    await devB.engine.applyVersionToLocal(
      {
        worldId: w.worldId,
        versionId: resB.newVersionId!,
        installAsNewFolderName: 'SharedRealm_FromDesktop',
      },
      shared,
    );
    const sideBySideContent = await fs.readFile(
      path.join(savesB, 'SharedRealm_FromDesktop', 'region', 'r.0.0.mca'),
      'utf8',
    );
    expect(sideBySideContent).toBe('desktop-nether-hub');

    // And user can resolve conflict by promoting their Laptop conflict version to main
    await devB.engine.applyVersionToLocal(
      {
        worldId: w.worldId,
        versionId: resB.conflictVersionId!,
        promoteToMain: true,
      },
      shared,
    );
    const manifestAfter = await shared.getWorldManifest(w.worldId);
    expect(manifestAfter?.latestVersionId).toBe(resB.conflictVersionId);
  });

  it('synchronises directly Peer-to-Peer over HTTP with pairing-code authentication', async () => {
    const savesHost = path.join(tmpRoot, 'host', 'saves');
    const savesPeer = path.join(tmpRoot, 'peer', 'saves');
    await fs.mkdir(savesHost, { recursive: true });
    await fs.mkdir(savesPeer, { recursive: true });

    await createFakeWorld(savesHost, 'P2PWorld', {
      levelName: 'LAN Adventure',
      regionContent: 'p2p-initial-chunks',
    });

    const hostDev = makeDeviceEngine(
      'host-1',
      'Gaming-PC',
      savesHost,
      path.join(tmpRoot, 'host', 'repo'),
      path.join(tmpRoot, 'host', 'backups'),
    );
    const peerDev = makeDeviceEngine(
      'peer-2',
      'MacBook-Air',
      savesPeer,
      path.join(tmpRoot, 'peer', 'repo'),
      path.join(tmpRoot, 'peer', 'backups'),
    );

    // Snapshot world into host's local repository so P2PServer can serve it
    const [hostWorld] = await hostDev.engine.listWorldViewModels(null);
    await hostDev.engine.createLocalSnapshot(hostWorld.worldId, {
      label: 'Initial LAN Share',
    });

    const server = new P2PServer({
      deviceId: 'host-1',
      deviceName: 'Gaming-PC',
      port: 0, // Ephemeral port
      pairingCode: 'SEC123',
      backingStore: hostDev.localStore,
    });
    const boundPort = await server.start();

    try {
      // Wrong pairing code must fail
      const badClient = new P2PClientTransport('127.0.0.1', boundPort, 'WRONG1', 'Gaming-PC');
      const badStatus = await badClient.getStatus();
      expect(badStatus.connected).toBe(false);

      // Correct pairing code connects and syncs
      const client = new P2PClientTransport('127.0.0.1', boundPort, 'SEC123', 'Gaming-PC');
      const goodStatus = await client.getStatus();
      expect(goodStatus.connected).toBe(true);
      expect(goodStatus.worldCount).toBe(1);

      // Peer pulls world directly from Host over P2P
      const pullRes = await peerDev.engine.syncWorld(hostWorld.worldId, client);
      expect(pullRes.action).toBe('pulled');

      const peerChunk = await fs.readFile(
        path.join(savesPeer, 'P2PWorld', 'region', 'r.0.0.mca'),
        'utf8',
      );
      expect(peerChunk).toBe('p2p-initial-chunks');

      // Peer edits and pushes back to Host directly over P2P
      await fs.writeFile(
        path.join(savesPeer, 'P2PWorld', 'region', 'r.0.0.mca'),
        'p2p-updated-by-macbook',
        'utf8',
      );
      const pushRes = await peerDev.engine.syncWorld(hostWorld.worldId, client);
      expect(pushRes.action).toBe('pushed');

      // Host now has the new version in its local repo and can apply it!
      const hostManifest = await hostDev.localStore.getWorldManifest(hostWorld.worldId);
      expect(hostManifest?.versions.length).toBe(2);
      expect(hostManifest?.latestVersionId).toBe(pushRes.newVersionId);
    } finally {
      await server.stop();
    }
  });
});
