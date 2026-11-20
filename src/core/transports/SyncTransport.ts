import { DestinationStatus, VersionRecord, WorldManifest } from '../../shared/types';

/**
 * Common transport abstraction implemented by both:
 * - FolderTransport (local folder, USB drive, NAS/SMB network share, cloud folder)
 * - P2PClientTransport (direct peer-to-peer over LAN / VPN / Internet)
 */
export interface SyncTransport {
  readonly kind: 'folder' | 'p2p';
  readonly label: string;

  /** Checks connectivity and returns repository statistics */
  getStatus(): Promise<DestinationStatus>;

  /** Lists all world manifests stored on the remote/repository */
  listWorlds(): Promise<WorldManifest[]>;

  /** Gets a single world manifest, or null if not found */
  getWorldManifest(worldId: string): Promise<WorldManifest | null>;

  /** Saves/updates a world manifest */
  putWorldManifest(manifest: WorldManifest): Promise<void>;

  /** Retrieves a full VersionRecord (including file list) */
  getVersion(worldId: string, versionId: string): Promise<VersionRecord | null>;

  /** Stores a full VersionRecord */
  putVersion(version: VersionRecord): Promise<void>;

  /** Given a list of SHA-256 object hashes, returns the subset that are MISSING on the remote */
  findMissingObjects(hashes: string[]): Promise<string[]>;

  /** Uploads a raw (uncompressed) file object by its SHA-256 hash; transport may compress internally */
  putObject(sha256: string, rawData: Buffer): Promise<void>;

  /** Downloads a raw (uncompressed) file object by its SHA-256 hash */
  getObject(sha256: string): Promise<Buffer>;
}
