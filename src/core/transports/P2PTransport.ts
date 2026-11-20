import http from 'node:http';
import dgram from 'node:dgram';
import os from 'node:os';
import crypto from 'node:crypto';
import { DestinationStatus, PeerInfo, VersionRecord, WorldManifest } from '../../shared/types';
import { FolderTransport } from './FolderTransport';
import { SyncTransport } from './SyncTransport';

export interface P2PServerConfig {
  deviceId: string;
  deviceName: string;
  port: number;
  pairingCode: string;
  backingStore: FolderTransport;
}

function readRequestBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Built-in lightweight HTTP peer server that exposes a device's local ChunkSafe
 * repository to authenticated peers on the LAN, VPN (Tailscale/WireGuard), or Internet.
 */
export class P2PServer {
  private server: http.Server | null = null;
  private boundPort = 0;

  constructor(private config: P2PServerConfig) {}

  updateConfig(partial: Partial<P2PServerConfig>): void {
    this.config = { ...this.config, ...partial };
  }

  get port(): number {
    return this.boundPort;
  }

  get running(): boolean {
    return this.server !== null;
  }

  async start(): Promise<number> {
    if (this.server) return this.boundPort;
    await this.config.backingStore.ensureInitialized();

    this.server = http.createServer((req, res) => {
      void this.handleRequest(req, res);
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.config.port, '0.0.0.0', () => {
        const addr = this.server!.address();
        this.boundPort = typeof addr === 'object' && addr ? addr.port : this.config.port;
        resolve();
      });
    });

    return this.boundPort;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const srv = this.server;
    this.server = null;
    this.boundPort = 0;
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }

  private sendJson(res: http.ServerResponse, status: number, data: unknown): void {
    const body = JSON.stringify(data);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
  }

  private isAuthorized(req: http.IncomingMessage): boolean {
    const token = String(req.headers['x-chunksafe-token'] || '');
    if (!this.config.pairingCode) return true;
    return safeEqual(token, this.config.pairingCode);
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      const pathname = url.pathname;
      const method = req.method || 'GET';

      // Public ping endpoint for peer discovery & reachability
      if (method === 'GET' && pathname === '/api/ping') {
        this.sendJson(res, 200, {
          app: 'ChunkSafe',
          peerId: this.config.deviceId,
          deviceName: this.config.deviceName,
          platform: process.platform,
          port: this.boundPort,
        });
        return;
      }

      if (!this.isAuthorized(req)) {
        this.sendJson(res, 401, { error: 'Invalid or missing pairing code' });
        return;
      }

      const store = this.config.backingStore;

      if (method === 'GET' && pathname === '/api/status') {
        const status = await store.getStatus();
        this.sendJson(res, 200, {
          ...status,
          type: 'p2p',
          label: this.config.deviceName,
        });
        return;
      }

      if (method === 'GET' && pathname === '/api/worlds') {
        const worlds = await store.listWorlds();
        this.sendJson(res, 200, worlds);
        return;
      }

      const worldMatch = pathname.match(/^\/api\/worlds\/([^/]+)$/);
      if (worldMatch) {
        const worldId = decodeURIComponent(worldMatch[1]);
        if (method === 'GET') {
          const manifest = await store.getWorldManifest(worldId);
          if (!manifest) {
            this.sendJson(res, 404, { error: 'World not found' });
            return;
          }
          this.sendJson(res, 200, manifest);
          return;
        }
        if (method === 'PUT') {
          const body = await readRequestBody(req);
          const manifest = JSON.parse(body.toString('utf8')) as WorldManifest;
          await store.putWorldManifest(manifest);
          this.sendJson(res, 200, { ok: true });
          return;
        }
      }

      const versionMatch = pathname.match(/^\/api\/versions\/([^/]+)\/([^/]+)$/);
      if (versionMatch) {
        const worldId = decodeURIComponent(versionMatch[1]);
        const versionId = decodeURIComponent(versionMatch[2]);
        if (method === 'GET') {
          const ver = await store.getVersion(worldId, versionId);
          if (!ver) {
            this.sendJson(res, 404, { error: 'Version not found' });
            return;
          }
          this.sendJson(res, 200, ver);
          return;
        }
        if (method === 'PUT') {
          const body = await readRequestBody(req);
          const ver = JSON.parse(body.toString('utf8')) as VersionRecord;
          await store.putVersion(ver);
          this.sendJson(res, 200, { ok: true });
          return;
        }
      }

      if (method === 'POST' && pathname === '/api/objects/missing') {
        const body = await readRequestBody(req);
        const { hashes } = JSON.parse(body.toString('utf8')) as { hashes: string[] };
        const missing = await store.findMissingObjects(hashes || []);
        this.sendJson(res, 200, { missing });
        return;
      }

      const objectMatch = pathname.match(/^\/api\/objects\/([a-fA-F0-9]{64})$/);
      if (objectMatch) {
        const sha256 = objectMatch[1].toLowerCase();
        if (method === 'GET') {
          try {
            const raw = await store.getObject(sha256);
            res.writeHead(200, {
              'Content-Type': 'application/octet-stream',
              'Content-Length': raw.length,
            });
            res.end(raw);
          } catch {
            this.sendJson(res, 404, { error: 'Object not found' });
          }
          return;
        }
        if (method === 'PUT') {
          const raw = await readRequestBody(req);
          await store.putObject(sha256, raw);
          this.sendJson(res, 200, { ok: true });
          return;
        }
      }

      this.sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      this.sendJson(res, 500, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * UDP LAN broadcast discovery so two computers running ChunkSafe on the same
 * Wi-Fi / local network automatically discover each other.
 */
export class P2PDiscovery {
  private socket: dgram.Socket | null = null;
  private broadcastTimer: NodeJS.Timeout | null = null;
  private pruneTimer: NodeJS.Timeout | null = null;
  private readonly peers = new Map<string, PeerInfo>();

  constructor(
    private config: {
      deviceId: string;
      deviceName: string;
      httpPort: number;
      discoveryPort: number;
      onPeersChanged?: (peers: PeerInfo[]) => void;
    },
  ) {}

  updateConfig(partial: Partial<{ deviceName: string; httpPort: number }>): void {
    this.config = { ...this.config, ...partial };
  }

  getDiscoveredPeers(): PeerInfo[] {
    return Array.from(this.peers.values());
  }

  async start(): Promise<void> {
    if (this.socket) return;
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.socket = sock;

    sock.on('message', (msg, rinfo) => {
      try {
        const payload = JSON.parse(msg.toString('utf8')) as {
          app?: string;
          peerId?: string;
          deviceName?: string;
          port?: number;
          platform?: string;
        };
        if (payload.app !== 'ChunkSafe' || !payload.peerId || payload.peerId === this.config.deviceId) {
          return;
        }
        const peer: PeerInfo = {
          peerId: payload.peerId,
          deviceName: payload.deviceName || rinfo.address,
          host: rinfo.address,
          port: payload.port || 41821,
          platform: payload.platform || 'unknown',
          lastSeenAt: Date.now(),
          source: 'lan',
          online: true,
        };
        this.peers.set(peer.peerId, peer);
        this.config.onPeersChanged?.(this.getDiscoveredPeers());
      } catch {
        // Ignore malformed UDP packets
      }
    });

    sock.on('error', () => {
      // Non-fatal: LAN broadcast may be restricted by firewall; manual peer IP still works
    });

    await new Promise<void>((resolve) => {
      sock.bind(this.config.discoveryPort, () => {
        try {
          sock.setBroadcast(true);
        } catch {
          // Ignore if broadcast isn't allowed
        }
        resolve();
      });
    });

    const sendBeacon = () => {
      if (!this.socket) return;
      const msg = Buffer.from(
        JSON.stringify({
          app: 'ChunkSafe',
          peerId: this.config.deviceId,
          deviceName: this.config.deviceName,
          port: this.config.httpPort,
          platform: process.platform,
        }),
        'utf8',
      );
      try {
        this.socket.send(msg, 0, msg.length, this.config.discoveryPort, '255.255.255.255');
      } catch {
        // Ignore transient network errors
      }
    };

    sendBeacon();
    this.broadcastTimer = setInterval(sendBeacon, 3000);
    this.pruneTimer = setInterval(() => {
      const now = Date.now();
      let changed = false;
      for (const [id, peer] of this.peers.entries()) {
        if (now - peer.lastSeenAt > 15000) {
          this.peers.delete(id);
          changed = true;
        }
      }
      if (changed) {
        this.config.onPeersChanged?.(this.getDiscoveredPeers());
      }
    }, 5000);
  }

  async stop(): Promise<void> {
    if (this.broadcastTimer) clearInterval(this.broadcastTimer);
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.broadcastTimer = null;
    this.pruneTimer = null;
    if (this.socket) {
      const s = this.socket;
      this.socket = null;
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
    this.peers.clear();
  }
}

/**
 * SyncTransport implementation that syncs directly with another ChunkSafe peer over HTTP.
 */
export class P2PClientTransport implements SyncTransport {
  readonly kind = 'p2p' as const;
  readonly label: string;
  private readonly baseUrl: string;

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly pairingCode: string,
    label?: string,
  ) {
    this.baseUrl = `http://${host}:${port}`;
    this.label = label || `${host}:${port}`;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      'X-ChunkSafe-Token': this.pairingCode,
      ...extra,
    };
  }

  private async requestJson<T>(
    urlPath: string,
    init?: RequestInit,
  ): Promise<{ status: number; data: T | null }> {
    const res = await fetch(`${this.baseUrl}${urlPath}`, {
      ...init,
      headers: {
        ...this.headers(),
        ...(init?.headers as Record<string, string> | undefined),
      },
    });
    if (res.status === 404) {
      return { status: 404, data: null };
    }
    if (!res.ok) {
      const errText = await res.text().catch(() => res.statusText);
      throw new Error(`Peer error (${res.status}): ${errText}`);
    }
    const data = (await res.json()) as T;
    return { status: res.status, data };
  }

  async getStatus(): Promise<DestinationStatus> {
    try {
      const { data } = await this.requestJson<DestinationStatus>('/api/status');
      if (!data) {
        return {
          type: 'p2p',
          connected: false,
          label: this.label,
          detail: 'Peer did not return status',
          worldCount: 0,
        };
      }
      return {
        ...data,
        type: 'p2p',
        connected: true,
        detail: `${this.host}:${this.port}`,
      };
    } catch (err) {
      return {
        type: 'p2p',
        connected: false,
        label: this.label,
        detail: err instanceof Error ? err.message : String(err),
        worldCount: 0,
      };
    }
  }

  async listWorlds(): Promise<WorldManifest[]> {
    const { data } = await this.requestJson<WorldManifest[]>('/api/worlds');
    return data || [];
  }

  async getWorldManifest(worldId: string): Promise<WorldManifest | null> {
    const { data } = await this.requestJson<WorldManifest>(
      `/api/worlds/${encodeURIComponent(worldId)}`,
    );
    return data;
  }

  async putWorldManifest(manifest: WorldManifest): Promise<void> {
    await this.requestJson(`/api/worlds/${encodeURIComponent(manifest.worldId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(manifest),
    });
  }

  async getVersion(worldId: string, versionId: string): Promise<VersionRecord | null> {
    const { data } = await this.requestJson<VersionRecord>(
      `/api/versions/${encodeURIComponent(worldId)}/${encodeURIComponent(versionId)}`,
    );
    return data;
  }

  async putVersion(version: VersionRecord): Promise<void> {
    await this.requestJson(
      `/api/versions/${encodeURIComponent(version.worldId)}/${encodeURIComponent(version.versionId)}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(version),
      },
    );
  }

  async findMissingObjects(hashes: string[]): Promise<string[]> {
    const { data } = await this.requestJson<{ missing: string[] }>('/api/objects/missing', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hashes }),
    });
    return data?.missing || [];
  }

  async putObject(sha256: string, rawData: Buffer): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/objects/${sha256}`, {
      method: 'PUT',
      headers: this.headers({ 'Content-Type': 'application/octet-stream' }),
      body: new Uint8Array(rawData),
    });
    if (!res.ok) {
      throw new Error(`Failed to upload object ${sha256}: ${res.status}`);
    }
  }

  async getObject(sha256: string): Promise<Buffer> {
    const res = await fetch(`${this.baseUrl}/api/objects/${sha256}`, {
      method: 'GET',
      headers: this.headers(),
    });
    if (!res.ok) {
      throw new Error(`Failed to download object ${sha256}: ${res.status}`);
    }
    const arrBuf = await res.arrayBuffer();
    return Buffer.from(arrBuf);
  }
}

export function getLocalIPv4Addresses(): string[] {
  const nets = os.networkInterfaces();
  const ips: string[] = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        ips.push(net.address);
      }
    }
  }
  return ips;
}
