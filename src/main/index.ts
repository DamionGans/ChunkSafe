import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import crypto from 'node:crypto';
import path from 'node:path';
import { SettingsStore } from '../core/config/SettingsStore';
import { ProviderRegistry } from '../core/providers/ContentProvider';
import { SyncEngine } from '../core/sync/SyncEngine';
import { FolderTransport } from '../core/transports/FolderTransport';
import {
  getLocalIPv4Addresses,
  P2PClientTransport,
  P2PDiscovery,
  P2PServer,
} from '../core/transports/P2PTransport';
import { SyncTransport } from '../core/transports/SyncTransport';
import {
  ActivityLogEntry,
  AppSettings,
  ApplyVersionOptions,
  DestinationStatus,
  PeerInfo,
  VersionMode,
} from '../shared/types';

let mainWindow: BrowserWindow | null = null;
let settingsStore: SettingsStore;
let providers: ProviderRegistry;
let localStore: FolderTransport;
let syncEngine: SyncEngine;
let p2pServer: P2PServer | null = null;
let p2pDiscovery: P2PDiscovery | null = null;
const activityLog: ActivityLogEntry[] = [];

function logActivity(
  level: ActivityLogEntry['level'],
  message: string,
  worldId?: string,
): void {
  activityLog.unshift({
    id: crypto.randomBytes(6).toString('hex'),
    timestamp: new Date().toISOString(),
    level,
    message,
    worldId,
  });
  if (activityLog.length > 200) {
    activityLog.length = 200;
  }
}

function getAllKnownPeers(): PeerInfo[] {
  const settings = settingsStore.get();
  const discovered = p2pDiscovery?.getDiscoveredPeers() || [];
  const merged = new Map<string, PeerInfo>();

  for (const p of settings.savedPeers) {
    merged.set(p.peerId, { ...p, online: p.source === 'manual' ? p.online : false });
  }
  for (const d of discovered) {
    const existing = merged.get(d.peerId);
    merged.set(d.peerId, {
      ...d,
      pairingCode: existing?.pairingCode,
      online: true,
    });
  }
  return Array.from(merged.values());
}

function getActiveRemoteTransport(): SyncTransport | null {
  const settings = settingsStore.get();
  if (settings.activeDestination === 'folder') {
    if (!settings.folderSyncPath) return null;
    return new FolderTransport(settings.folderSyncPath, path.basename(settings.folderSyncPath) || settings.folderSyncPath);
  }

  // P2P destination
  const peers = getAllKnownPeers();
  const selected = peers.find((p) => p.peerId === settings.selectedPeerId);
  if (!selected) return null;
  const code = selected.pairingCode || settings.p2pPairingCode;
  return new P2PClientTransport(selected.host, selected.port, code, selected.deviceName);
}

async function restartP2PServices(): Promise<void> {
  const settings = settingsStore.get();
  if (p2pDiscovery) {
    await p2pDiscovery.stop();
    p2pDiscovery = null;
  }
  if (p2pServer) {
    await p2pServer.stop();
    p2pServer = null;
  }

  if (!settings.p2pEnabled) {
    logActivity('info', 'Peer-to-Peer hosting stopped.');
    return;
  }

  p2pServer = new P2PServer({
    deviceId: settings.deviceId,
    deviceName: settings.deviceName,
    port: settings.p2pPort,
    pairingCode: settings.p2pPairingCode,
    backingStore: localStore,
  });

  try {
    const boundPort = await p2pServer.start();
    p2pDiscovery = new P2PDiscovery({
      deviceId: settings.deviceId,
      deviceName: settings.deviceName,
      httpPort: boundPort,
      discoveryPort: settings.p2pDiscoveryPort,
    });
    await p2pDiscovery.start();
    logActivity('info', `Peer-to-Peer server listening on port ${boundPort}.`);
  } catch (err) {
    logActivity(
      'error',
      `Failed to start P2P server: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function initCore(): Promise<void> {
  const dataDir = path.join(app.getPath('userData'), 'chunksafe-data');
  providers = new ProviderRegistry();
  settingsStore = new SettingsStore(dataDir, providers);
  await settingsStore.load();

  localStore = new FolderTransport(path.join(dataDir, 'local-repo'), 'Local Repository');
  await localStore.ensureInitialized();

  const backupRoot = path.join(dataDir, 'backups');
  syncEngine = new SyncEngine(
    providers,
    localStore,
    backupRoot,
    () => settingsStore.get(),
    (next) => settingsStore.save(next),
  );

  await restartP2PServices();
  logActivity('info', 'ChunkSafe initialized.');
}

function registerIpcHandlers(): void {
  ipcMain.handle('chunksafe:getSettings', () => settingsStore.get());

  ipcMain.handle('chunksafe:updateSettings', async (_event, partial: Partial<AppSettings>) => {
    const prev = settingsStore.get();
    const next: AppSettings = { ...prev, ...partial };
    await settingsStore.save(next);

    if (
      partial.p2pEnabled !== undefined ||
      partial.p2pPort !== undefined ||
      partial.p2pPairingCode !== undefined ||
      partial.deviceName !== undefined
    ) {
      await restartP2PServices();
    }
    return next;
  });

  ipcMain.handle('chunksafe:pickDirectory', async (_event, title?: string) => {
    const result = await dialog.showOpenDialog({
      title: title || 'Select Folder',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('chunksafe:openPath', async (_event, targetPath: string) => {
    await shell.openPath(targetPath);
  });

  ipcMain.handle('chunksafe:listProviders', () => providers.listInfo());

  ipcMain.handle('chunksafe:listWorlds', async () => {
    const remote = getActiveRemoteTransport();
    return syncEngine.listWorldViewModels(remote);
  });

  ipcMain.handle('chunksafe:getDestinationStatus', async (): Promise<DestinationStatus> => {
    const settings = settingsStore.get();
    const remote = getActiveRemoteTransport();
    if (!remote) {
      return {
        type: settings.activeDestination,
        connected: false,
        label:
          settings.activeDestination === 'folder'
            ? 'No folder selected'
            : 'No peer selected',
        detail:
          settings.activeDestination === 'folder'
            ? 'Choose a local folder or network share in Destinations.'
            : 'Select a discovered LAN peer or add a peer IP in Destinations.',
        worldCount: 0,
      };
    }
    return remote.getStatus();
  });

  ipcMain.handle(
    'chunksafe:setWorldSyncEnabled',
    async (_event, worldId: string, enabled: boolean) => {
      await syncEngine.setWorldSyncEnabled(worldId, enabled);
      logActivity(
        'info',
        `${enabled ? 'Enabled' : 'Disabled'} sync for world ${worldId}.`,
        worldId,
      );
    },
  );

  ipcMain.handle(
    'chunksafe:setWorldVersionMode',
    async (_event, worldId: string, mode: VersionMode) => {
      await syncEngine.setWorldVersionMode(worldId, mode);
      logActivity('info', `Switched world ${worldId} to ${mode}-version mode.`, worldId);
    },
  );

  ipcMain.handle('chunksafe:syncWorld', async (_event, worldId: string) => {
    const remote = getActiveRemoteTransport();
    if (!remote) {
      throw new Error('No sync destination configured. Set up a Folder or Peer first.');
    }
    const res = await syncEngine.syncWorld(worldId, remote);
    const level =
      res.action === 'error' ? 'error' : res.action === 'conflict' ? 'warn' : 'success';
    logActivity(level, res.message, worldId);
    return res;
  });

  ipcMain.handle('chunksafe:syncAll', async () => {
    const remote = getActiveRemoteTransport();
    if (!remote) {
      throw new Error('No sync destination configured. Set up a Folder or Peer first.');
    }
    const results = await syncEngine.syncAllEnabled(remote);
    for (const res of results) {
      const level =
        res.action === 'error' ? 'error' : res.action === 'conflict' ? 'warn' : 'success';
      logActivity(level, res.message, res.worldId);
    }
    return results;
  });

  ipcMain.handle(
    'chunksafe:createSnapshot',
    async (
      _event,
      worldId: string,
      opts: { label?: string; branch?: string; notes?: string },
    ) => {
      const remote = getActiveRemoteTransport();
      const { version } = await syncEngine.createLocalSnapshot(worldId, {
        ...opts,
        remote,
      });
      logActivity(
        'success',
        `Created snapshot ${version.versionId}${opts.label ? ` ("${opts.label}")` : ''} on branch "${version.branch}".`,
        worldId,
      );
      return version;
    },
  );

  ipcMain.handle('chunksafe:applyVersion', async (_event, options: ApplyVersionOptions) => {
    const remote = getActiveRemoteTransport();
    const res = await syncEngine.applyVersionToLocal(options, remote);
    logActivity(
      'success',
      `Applied version ${options.versionId} to ${res.appliedPath}${res.backupPath ? ` (backup saved)` : ''}.`,
      options.worldId,
    );
    return res;
  });

  ipcMain.handle('chunksafe:getP2PInfo', () => {
    const settings = settingsStore.get();
    return {
      running: p2pServer?.running ?? false,
      port: p2pServer?.port ?? settings.p2pPort,
      addresses: getLocalIPv4Addresses(),
      pairingCode: settings.p2pPairingCode,
      discoveredPeers: getAllKnownPeers(),
    };
  });

  ipcMain.handle(
    'chunksafe:addManualPeer',
    async (
      _event,
      input: { host: string; port: number; pairingCode: string; deviceName?: string },
    ) => {
      let peerId = `manual-${input.host}-${input.port}`;
      let deviceName = input.deviceName || `${input.host}:${input.port}`;
      let platform = 'unknown';
      let online = false;

      try {
        const res = await fetch(`http://${input.host}:${input.port}/api/ping`);
        if (res.ok) {
          const data = (await res.json()) as {
            peerId?: string;
            deviceName?: string;
            platform?: string;
          };
          if (data.peerId) peerId = data.peerId;
          if (data.deviceName) deviceName = data.deviceName;
          if (data.platform) platform = data.platform;
          online = true;
        }
      } catch {
        // Peer may be offline right now; still allow saving
      }

      const peer: PeerInfo = {
        peerId,
        deviceName,
        host: input.host.trim(),
        port: input.port,
        platform,
        pairingCode: input.pairingCode.trim(),
        lastSeenAt: Date.now(),
        source: 'manual',
        online,
      };

      const settings = settingsStore.get();
      const filtered = settings.savedPeers.filter((p) => p.peerId !== peer.peerId);
      await settingsStore.save({
        ...settings,
        savedPeers: [...filtered, peer],
        selectedPeerId: peer.peerId,
      });

      logActivity('info', `Added peer ${peer.deviceName} (${peer.host}:${peer.port}).`);
      return peer;
    },
  );

  ipcMain.handle('chunksafe:removePeer', async (_event, peerId: string) => {
    const settings = settingsStore.get();
    const savedPeers = settings.savedPeers.filter((p) => p.peerId !== peerId);
    const selectedPeerId = settings.selectedPeerId === peerId ? null : settings.selectedPeerId;
    await settingsStore.save({ ...settings, savedPeers, selectedPeerId });
  });

  ipcMain.handle('chunksafe:getActivityLog', () => activityLog);
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1220,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    title: 'ChunkSafe',
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const isDev = !app.isPackaged && (process.argv.includes('--dev') || Boolean(process.env.VITE_DEV_SERVER_URL));
  if (isDev) {
    void mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173');
  } else {
    void mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  await initCore();
  registerIpcHandlers();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', async () => {
  if (p2pDiscovery) await p2pDiscovery.stop();
  if (p2pServer) await p2pServer.stop();
});
