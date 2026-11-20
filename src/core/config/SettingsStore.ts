import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AppSettings } from '../../shared/types';
import { ProviderRegistry } from '../providers/ContentProvider';
import { atomicWriteFile, pathExists } from '../utils/fsUtils';

function generatePairingCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(6);
  let out = '';
  for (let i = 0; i < 6; i++) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

export class SettingsStore {
  private settings: AppSettings | null = null;
  private readonly filePath: string;

  constructor(
    dataDir: string,
    private readonly providers: ProviderRegistry,
  ) {
    this.filePath = path.join(dataDir, 'settings.json');
  }

  async load(): Promise<AppSettings> {
    if (await pathExists(this.filePath)) {
      try {
        const raw = await fs.readFile(this.filePath, 'utf8');
        const parsed = JSON.parse(raw) as Partial<AppSettings>;
        const defaults = await this.createDefaults();
        this.settings = {
          ...defaults,
          ...parsed,
          saveRoots: parsed.saveRoots && parsed.saveRoots.length > 0 ? parsed.saveRoots : defaults.saveRoots,
          savedPeers: parsed.savedPeers || [],
          worlds: parsed.worlds || {},
        };
        return this.settings;
      } catch {
        // Fall through to defaults
      }
    }

    this.settings = await this.createDefaults();
    await this.save(this.settings);
    return this.settings;
  }

  get(): AppSettings {
    if (!this.settings) {
      throw new Error('SettingsStore not loaded yet. Call load() first.');
    }
    return this.settings;
  }

  async save(next: AppSettings): Promise<void> {
    this.settings = next;
    await atomicWriteFile(this.filePath, JSON.stringify(next, null, 2));
  }

  private async createDefaults(): Promise<AppSettings> {
    const vanilla = this.providers.get('vanilla-minecraft');
    const detectedRoots = vanilla ? await vanilla.detectDefaultRoots() : [];

    return {
      deviceId: `dev-${crypto.randomBytes(6).toString('hex')}`,
      deviceName: os.hostname() || 'My Computer',
      saveRoots: detectedRoots.map((p, idx) => ({
        path: p,
        providerId: 'vanilla-minecraft',
        label: idx === 0 ? 'Default Minecraft Saves' : `Minecraft Saves (${idx + 1})`,
        isDefault: idx === 0,
      })),
      activeDestination: 'folder',
      folderSyncPath: '',
      selectedPeerId: null,
      p2pEnabled: true,
      p2pPort: 41821,
      p2pDiscoveryPort: 41820,
      p2pPairingCode: generatePairingCode(),
      savedPeers: [],
      autoBackupBeforeOverwrite: true,
      worlds: {},
    };
  }
}
