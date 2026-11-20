export type ContentKind = 'vanilla-save' | 'modded-save' | 'curseforge-pack';

export type VersionMode = 'single' | 'multi';

export type SyncStatus =
  | 'synced'
  | 'local-ahead'
  | 'remote-ahead'
  | 'conflict'
  | 'local-only'
  | 'remote-only'
  | 'untracked';

export type SyncDestinationType = 'folder' | 'p2p';

export interface MinecraftWorldMeta {
  levelName: string;
  folderName: string;
  gameType?: 'Survival' | 'Creative' | 'Adventure' | 'Spectator' | 'Unknown';
  mcVersion?: string;
  hardcore?: boolean;
  lastPlayedAt?: number;
  iconDataUrl?: string;
  isLocked?: boolean;
  /** Future: mod loader info for modded saves / CurseForge packs */
  modLoader?: {
    type: 'forge' | 'neoforge' | 'fabric' | 'quilt';
    version: string;
    modpackName?: string;
    curseForgeProjectId?: number;
    curseForgeFileId?: number;
  };
}

export interface FileEntry {
  relativePath: string;
  sha256: string;
  size: number;
  mtimeMs: number;
}

export interface VersionRecord {
  versionId: string;
  worldId: string;
  parentVersionId: string | null;
  branch: string;
  label?: string;
  notes?: string;
  createdAt: string;
  lastPlayedAt: number;
  deviceId: string;
  deviceName: string;
  isConflict: boolean;
  contentKind: ContentKind;
  totalSize: number;
  fileCount: number;
  treeHash: string;
  files: FileEntry[];
  minecraftMeta: MinecraftWorldMeta;
}

export interface VersionSummary {
  versionId: string;
  parentVersionId: string | null;
  branch: string;
  label?: string;
  notes?: string;
  createdAt: string;
  lastPlayedAt: number;
  deviceId: string;
  deviceName: string;
  isConflict: boolean;
  totalSize: number;
  fileCount: number;
  treeHash: string;
  levelName: string;
  mcVersion?: string;
  gameType?: string;
}

export interface WorldManifest {
  worldId: string;
  displayName: string;
  folderName: string;
  contentKind: ContentKind;
  providerId: string;
  defaultBranch: string;
  /** Map of branch name -> head versionId */
  branches: Record<string, string>;
  /** The most recently updated versionId on the default branch */
  latestVersionId: string | null;
  versions: VersionSummary[];
  updatedAt: string;
}

export interface WorldSyncConfig {
  worldId: string;
  localFolderName: string;
  localRootPath: string;
  providerId: string;
  contentKind: ContentKind;
  syncEnabled: boolean;
  versionMode: VersionMode;
  /** Currently checked-out / applied version on this computer */
  activeVersionId: string | null;
  /** Base version from the last successful sync (used for 3-way conflict detection) */
  lastSyncedVersionId: string | null;
  /** Tree hash of the local world at the last sync */
  lastSyncedTreeHash: string | null;
  lastSyncedAt: string | null;
}

export interface DiscoveredWorld {
  localPath: string;
  localRootPath: string;
  folderName: string;
  providerId: string;
  contentKind: ContentKind;
  totalSize: number;
  fileCount: number;
  lastModifiedAt: number;
  meta: MinecraftWorldMeta;
}

export interface WorldViewModel {
  worldId: string;
  displayName: string;
  folderName: string;
  contentKind: ContentKind;
  providerId: string;
  localPath: string | null;
  localRootPath: string | null;
  hasLocal: boolean;
  hasRemote: boolean;
  syncEnabled: boolean;
  versionMode: VersionMode;
  status: SyncStatus;
  activeVersionId: string | null;
  latestRemoteVersionId: string | null;
  lastSyncedAt: string | null;
  localMeta?: MinecraftWorldMeta;
  localSize?: number;
  localFileCount?: number;
  localLastModified?: number;
  versions: VersionSummary[];
  branches: Record<string, string>;
  hasConflicts: boolean;
  conflictVersionIds: string[];
}

export interface PeerInfo {
  peerId: string;
  deviceName: string;
  host: string;
  port: number;
  platform: string;
  pairingCode?: string;
  lastSeenAt: number;
  source: 'lan' | 'manual';
  online: boolean;
}

export interface ProviderInfo {
  id: string;
  kind: ContentKind;
  name: string;
  description: string;
  status: 'active' | 'planned';
  detectedRoots: string[];
  capabilities: string[];
}

export interface SaveRootConfig {
  path: string;
  providerId: string;
  label: string;
  isDefault: boolean;
}

export interface AppSettings {
  deviceId: string;
  deviceName: string;
  saveRoots: SaveRootConfig[];
  activeDestination: SyncDestinationType;
  folderSyncPath: string;
  selectedPeerId: string | null;
  p2pEnabled: boolean;
  p2pPort: number;
  p2pDiscoveryPort: number;
  p2pPairingCode: string;
  savedPeers: PeerInfo[];
  autoBackupBeforeOverwrite: boolean;
  worlds: Record<string, WorldSyncConfig>;
}

export interface ActivityLogEntry {
  id: string;
  timestamp: string;
  level: 'info' | 'success' | 'warn' | 'error';
  message: string;
  worldId?: string;
}

export interface SyncResult {
  worldId: string;
  displayName: string;
  action: 'pushed' | 'pulled' | 'up-to-date' | 'conflict' | 'skipped' | 'error';
  message: string;
  newVersionId?: string;
  conflictVersionId?: string;
  bytesTransferred: number;
  filesTransferred: number;
}

export interface ApplyVersionOptions {
  worldId: string;
  versionId: string;
  targetRootPath?: string;
  /** If provided, installs side-by-side into a new folder instead of overwriting the current save */
  installAsNewFolderName?: string;
  /** If true, also promotes this version to be the active main branch head */
  promoteToMain?: boolean;
}

export interface DestinationStatus {
  type: SyncDestinationType;
  connected: boolean;
  label: string;
  detail: string;
  worldCount: number;
  objectCount?: number;
  totalStorageBytes?: number;
}
