import {
  ActivityLogEntry,
  AppSettings,
  ApplyVersionOptions,
  DestinationStatus,
  PeerInfo,
  ProviderInfo,
  SyncResult,
  VersionMode,
  VersionRecord,
  WorldViewModel,
} from './types';

export interface P2PStatusInfo {
  running: boolean;
  port: number;
  addresses: string[];
  pairingCode: string;
  discoveredPeers: PeerInfo[];
}

export interface ChunkSafeApi {
  getSettings(): Promise<AppSettings>;
  updateSettings(partial: Partial<AppSettings>): Promise<AppSettings>;
  pickDirectory(title?: string): Promise<string | null>;
  openPath(targetPath: string): Promise<void>;
  listProviders(): Promise<ProviderInfo[]>;
  listWorlds(): Promise<WorldViewModel[]>;
  getDestinationStatus(): Promise<DestinationStatus>;
  setWorldSyncEnabled(worldId: string, enabled: boolean): Promise<void>;
  setWorldVersionMode(worldId: string, mode: VersionMode): Promise<void>;
  syncWorld(worldId: string): Promise<SyncResult>;
  syncAll(): Promise<SyncResult[]>;
  createSnapshot(
    worldId: string,
    opts: { label?: string; branch?: string; notes?: string },
  ): Promise<VersionRecord>;
  applyVersion(
    options: ApplyVersionOptions,
  ): Promise<{ appliedPath: string; backupPath: string | null; version: VersionRecord }>;
  getP2PInfo(): Promise<P2PStatusInfo>;
  addManualPeer(input: {
    host: string;
    port: number;
    pairingCode: string;
    deviceName?: string;
  }): Promise<PeerInfo>;
  removePeer(peerId: string): Promise<void>;
  getActivityLog(): Promise<ActivityLogEntry[]>;
}

declare global {
  interface Window {
    chunkSafe: ChunkSafeApi;
  }
}
