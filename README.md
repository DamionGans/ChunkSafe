# ChunkSafe

Cross-platform desktop application for **macOS, Windows, and Linux** to synchronise Minecraft saves with version history, conflict protection, folder/network sync, and direct peer-to-peer sync.

## Features

- **Per-World Sync Selection**: Choose exactly which Minecraft worlds to synchronise.
- **Version Selection & Multi-Version Support**:
  - **Single-Version Mode (Default)**: Automatically updates to the last-updated version on `main`.
  - **Multi-Version Mode & Named Snapshots**: Create labelled snapshots/branches at any time and choose *which specific version* to apply to your PC (replacing the local save with an automatic safety backup, or installing side-by-side under a new folder name).
  - **Safe Conflict Handling**: If two computers edit the same world offline, ChunkSafe detects the divergence via 3-way tracking, preserves **both** versions, and lets you pick which one to use or promote to Latest.
- **Dual Sync Transports**:
  - **Local / Network Folder**: Sync to any local folder, external USB drive, NAS/SMB network share, or cloud-synced folder (Proton Drive, Dropbox, OneDrive, iCloud).
  - **Peer-to-Peer (P2P)**: Built-in HTTP sync server + UDP LAN auto-discovery + manual `IP:port` connection protected by a 6-character pairing code.
- **Deduplicated Content-Addressed Storage**: Stores SHA-256 content-addressed gzipped chunks/files so keeping multiple versions of large worlds only stores changed files.
- **Extensible Content Provider Architecture**: Built around a `ContentProvider` plugin interface (`src/core/providers/ContentProvider.ts`) so future versions can plug in **Modded Game Saves** (Prism Launcher, Modrinth App, MultiMC, CurseForge instances) and **CurseForge Addon Packs** (`manifest.json`, mods, overrides, configs) without changing the sync engine or transports.

## Development

```bash
npm install
npm test          # Run unit & end-to-end sync tests (Folder + P2P)
npm run typecheck # Strict TypeScript check (main + renderer)
npm run dev       # Launch Vite dev server + Electron app
```

## Building Installers (macOS, Windows, Linux)

```bash
npm run dist:win   # Windows NSIS installer & portable exe
npm run dist:mac   # macOS .dmg & .zip
npm run dist:linux # Linux .AppImage & .deb
```
