import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  Box,
  CheckCircle2,
  Copy,
  Download,
  FolderSync,
  GitBranch,
  HardDrive,
  History,
  Layers,
  Network,
  Plus,
  RefreshCw,
  Settings,
  ShieldCheck,
  Trash2,
  Wifi,
} from 'lucide-react';
import {
  ActivityLogEntry,
  AppSettings,
  DestinationStatus,
  ProviderInfo,
  SyncStatus,
  VersionSummary,
  WorldViewModel,
} from '../shared/types';
import { P2PStatusInfo } from '../shared/ipc';

type Tab = 'worlds' | 'destinations' | 'providers' | 'settings';

function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let idx = 0;
  let val = bytes;
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024;
    idx += 1;
  }
  return `${val.toFixed(val >= 100 || idx === 0 ? 0 : 1)} ${units[idx]}`;
}

function formatDate(ts?: string | number | null): string {
  if (!ts) return 'Never';
  const d = typeof ts === 'number' ? new Date(ts) : new Date(ts);
  if (Number.isNaN(d.getTime())) return 'Unknown';
  return d.toLocaleString();
}

function statusBadge(status: SyncStatus) {
  switch (status) {
    case 'synced':
      return <span className="badge badge-green">Synced</span>;
    case 'local-ahead':
      return <span className="badge badge-blue">Local Ahead</span>;
    case 'remote-ahead':
      return <span className="badge badge-amber">Update Available</span>;
    case 'conflict':
      return (
        <span className="badge badge-rose">
          <AlertTriangle size={11} /> Conflict
        </span>
      );
    case 'local-only':
      return <span className="badge badge-purple">Ready to Upload</span>;
    case 'remote-only':
      return <span className="badge badge-blue">Available on Remote</span>;
    default:
      return <span className="badge badge-slate">Not Synced</span>;
  }
}

export default function App() {
  const [tab, setTab] = useState<Tab>('worlds');
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [worlds, setWorlds] = useState<WorldViewModel[]>([]);
  const [destStatus, setDestStatus] = useState<DestinationStatus | null>(null);
  const [p2pInfo, setP2PInfo] = useState<P2PStatusInfo | null>(null);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [logs, setLogs] = useState<ActivityLogEntry[]>([]);
  const [selectedWorldId, setSelectedWorldId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; isError?: boolean } | null>(null);

  // Snapshot form state
  const [snapLabel, setSnapLabel] = useState('');
  const [snapBranch, setSnapBranch] = useState('main');
  const [snapNotes, setSnapNotes] = useState('');

  // Side-by-side install state
  const [sideBySideVersionId, setSideBySideVersionId] = useState<string | null>(null);
  const [sideBySideFolder, setSideBySideFolder] = useState('');

  // Manual peer form
  const [peerHost, setPeerHost] = useState('');
  const [peerPort, setPeerPort] = useState('41821');
  const [peerCode, setPeerCode] = useState('');
  const [peerName, setPeerName] = useState('');

  const showToast = useCallback((text: string, isError = false) => {
    setToast({ text, isError });
    setTimeout(() => {
      setToast((prev) => (prev?.text === text ? null : prev));
    }, 4500);
  }, []);

  const refreshAll = useCallback(async () => {
    try {
      const [s, w, ds, p2p, prov, lg] = await Promise.all([
        window.chunkSafe.getSettings(),
        window.chunkSafe.listWorlds(),
        window.chunkSafe.getDestinationStatus(),
        window.chunkSafe.getP2PInfo(),
        window.chunkSafe.listProviders(),
        window.chunkSafe.getActivityLog(),
      ]);
      setSettings(s);
      setWorlds(w);
      setDestStatus(ds);
      setP2PInfo(p2p);
      setProviders(prov);
      setLogs(lg);
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), true);
    }
  }, [showToast]);

  useEffect(() => {
    void refreshAll();
    const timer = setInterval(() => {
      void window.chunkSafe.getP2PInfo().then(setP2PInfo).catch(() => {});
    }, 5000);
    return () => clearInterval(timer);
  }, [refreshAll]);

  const selectedWorld = worlds.find((w) => w.worldId === selectedWorldId) || null;
  const conflictCount = worlds.filter((w) => w.hasConflicts).length;

  async function handleToggleSync(world: WorldViewModel, enabled: boolean) {
    await window.chunkSafe.setWorldSyncEnabled(world.worldId, enabled);
    await refreshAll();
  }

  async function handleToggleVersionMode(world: WorldViewModel) {
    const next = world.versionMode === 'single' ? 'multi' : 'single';
    await window.chunkSafe.setWorldVersionMode(world.worldId, next);
    showToast(
      next === 'multi'
        ? `"${world.displayName}" switched to Multi-Version mode.`
        : `"${world.displayName}" switched to Single-Version (Auto-Latest) mode.`,
    );
    await refreshAll();
  }

  async function handleSyncWorld(world: WorldViewModel) {
    setBusy(`sync:${world.worldId}`);
    try {
      const res = await window.chunkSafe.syncWorld(world.worldId);
      showToast(res.message, res.action === 'error');
      if (res.action === 'conflict') {
        setSelectedWorldId(world.worldId);
      }
      await refreshAll();
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), true);
    } finally {
      setBusy(null);
    }
  }

  async function handleSyncAll() {
    setBusy('sync-all');
    try {
      const results = await window.chunkSafe.syncAll();
      if (results.length === 0) {
        showToast('No worlds are selected for synchronisation yet.');
      } else {
        const conflicts = results.filter((r) => r.action === 'conflict').length;
        const errors = results.filter((r) => r.action === 'error').length;
        showToast(
          `Synced ${results.length} world(s)${conflicts ? ` — ${conflicts} conflict(s) need attention` : ''}${errors ? ` — ${errors} error(s)` : ''}.`,
          errors > 0,
        );
      }
      await refreshAll();
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), true);
    } finally {
      setBusy(null);
    }
  }

  async function handleCreateSnapshot(world: WorldViewModel) {
    setBusy(`snap:${world.worldId}`);
    try {
      const ver = await window.chunkSafe.createSnapshot(world.worldId, {
        label: snapLabel.trim() || undefined,
        branch: snapBranch.trim() || 'main',
        notes: snapNotes.trim() || undefined,
      });
      setSnapLabel('');
      setSnapNotes('');
      showToast(`Saved snapshot ${ver.versionId} on branch "${ver.branch}".`);
      await refreshAll();
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), true);
    } finally {
      setBusy(null);
    }
  }

  async function handleApplyVersion(
    world: WorldViewModel,
    ver: VersionSummary,
    opts?: { promoteToMain?: boolean; installAsNewFolderName?: string },
  ) {
    setBusy(`apply:${ver.versionId}`);
    try {
      const res = await window.chunkSafe.applyVersion({
        worldId: world.worldId,
        versionId: ver.versionId,
        promoteToMain: opts?.promoteToMain,
        installAsNewFolderName: opts?.installAsNewFolderName,
      });
      setSideBySideVersionId(null);
      setSideBySideFolder('');
      showToast(
        opts?.installAsNewFolderName
          ? `Installed version ${ver.versionId} side-by-side into "${opts.installAsNewFolderName}".`
          : `Applied version ${ver.versionId} to this PC${res.backupPath ? ' (previous local copy backed up)' : ''}.`,
      );
      await refreshAll();
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), true);
    } finally {
      setBusy(null);
    }
  }

  async function handlePickSyncFolder() {
    const picked = await window.chunkSafe.pickDirectory(
      'Choose Local or Network Folder for ChunkSafe Sync',
    );
    if (!picked) return;
    await window.chunkSafe.updateSettings({
      folderSyncPath: picked,
      activeDestination: 'folder',
    });
    showToast(`Sync folder set to ${picked}`);
    await refreshAll();
  }

  async function handleAddSaveRoot() {
    const picked = await window.chunkSafe.pickDirectory('Add Minecraft Saves Folder');
    if (!picked || !settings) return;
    const exists = settings.saveRoots.some((r) => r.path === picked);
    if (exists) return;
    await window.chunkSafe.updateSettings({
      saveRoots: [
        ...settings.saveRoots,
        {
          path: picked,
          providerId: 'vanilla-minecraft',
          label: 'Custom Saves Folder',
          isDefault: false,
        },
      ],
    });
    await refreshAll();
  }

  async function handleRemoveSaveRoot(rootPath: string) {
    if (!settings) return;
    await window.chunkSafe.updateSettings({
      saveRoots: settings.saveRoots.filter((r) => r.path !== rootPath),
    });
    await refreshAll();
  }

  async function handleAddManualPeer(e: React.FormEvent) {
    e.preventDefault();
    if (!peerHost.trim()) return;
    setBusy('add-peer');
    try {
      const peer = await window.chunkSafe.addManualPeer({
        host: peerHost.trim(),
        port: Number(peerPort) || 41821,
        pairingCode: peerCode.trim(),
        deviceName: peerName.trim() || undefined,
      });
      await window.chunkSafe.updateSettings({
        activeDestination: 'p2p',
        selectedPeerId: peer.peerId,
      });
      setPeerHost('');
      setPeerName('');
      showToast(`Added peer "${peer.deviceName}" (${peer.online ? 'Online' : 'Saved offline'}).`);
      await refreshAll();
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), true);
    } finally {
      setBusy(null);
    }
  }

  async function handleSelectPeer(peerId: string, pairingCode?: string) {
    if (!settings) return;
    let savedPeers = settings.savedPeers;
    if (pairingCode !== undefined) {
      const existing = p2pInfo?.discoveredPeers.find((p) => p.peerId === peerId);
      if (existing) {
        savedPeers = [
          ...savedPeers.filter((p) => p.peerId !== peerId),
          { ...existing, pairingCode },
        ];
      }
    }
    await window.chunkSafe.updateSettings({
      activeDestination: 'p2p',
      selectedPeerId: peerId,
      savedPeers,
    });
    await refreshAll();
  }

  return (
    <div className="app-shell">
      {/* Sidebar */}
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-icon">
            <ShieldCheck size={20} />
          </div>
          <div>
            <h1>ChunkSafe</h1>
            <span>Minecraft Save Sync</span>
          </div>
        </div>

        <nav className="nav">
          <button
            className={`nav-btn ${tab === 'worlds' ? 'active' : ''}`}
            onClick={() => setTab('worlds')}
          >
            <HardDrive size={17} />
            Worlds
            {conflictCount > 0 && <span className="nav-badge">{conflictCount}</span>}
          </button>
          <button
            className={`nav-btn ${tab === 'destinations' ? 'active' : ''}`}
            onClick={() => setTab('destinations')}
          >
            <Network size={17} />
            Sync Destinations
          </button>
          <button
            className={`nav-btn ${tab === 'providers' ? 'active' : ''}`}
            onClick={() => setTab('providers')}
          >
            <Layers size={17} />
            Providers & Mods
          </button>
          <button
            className={`nav-btn ${tab === 'settings' ? 'active' : ''}`}
            onClick={() => setTab('settings')}
          >
            <Settings size={17} />
            Settings & Log
          </button>
        </nav>

        <div className="dest-pill">
          <div className="dest-pill-header">
            <span className={`dot ${destStatus?.connected ? 'online' : 'offline'}`} />
            {settings?.activeDestination === 'p2p' ? 'Peer-to-Peer' : 'Folder Sync'}
          </div>
          <div className="dest-pill-detail" title={destStatus?.detail || ''}>
            {destStatus?.connected ? destStatus.label : 'Not connected'}
          </div>
          {destStatus?.connected && (
            <div style={{ marginTop: 4, fontSize: 11, color: '#94a3b8' }}>
              {destStatus.worldCount} world(s) · {formatBytes(destStatus.totalStorageBytes)}
            </div>
          )}
        </div>
      </aside>

      {/* Main workspace */}
      <main className="main">
        <header className="topbar">
          <div>
            <h2>
              {tab === 'worlds' && 'Minecraft Worlds'}
              {tab === 'destinations' && 'Sync Destinations (Folder & Peer-to-Peer)'}
              {tab === 'providers' && 'Content Providers & Mod Extensibility'}
              {tab === 'settings' && 'Settings & Activity Log'}
            </h2>
            <div className="topbar-sub">
              {tab === 'worlds' &&
                'Choose which worlds to sync, manage single or multiple versions, and pick which version to use on this PC.'}
              {tab === 'destinations' &&
                'Sync via a local/network folder or directly peer-to-peer with another computer running ChunkSafe.'}
              {tab === 'providers' &&
                'Active vanilla saves plus extensible plugin architecture for modded saves and CurseForge packs.'}
              {tab === 'settings' &&
                `Device: ${settings?.deviceName || '...'} · Automatic safety backups ${settings?.autoBackupBeforeOverwrite ? 'enabled' : 'disabled'}`}
            </div>
          </div>
          <div className="topbar-actions">
            <button className="btn" onClick={() => void refreshAll()} disabled={busy !== null}>
              <RefreshCw size={15} /> Refresh
            </button>
            {tab === 'worlds' && (
              <button
                className="btn btn-primary"
                onClick={() => void handleSyncAll()}
                disabled={busy !== null || !destStatus?.connected}
              >
                <FolderSync size={15} />
                {busy === 'sync-all' ? 'Syncing...' : 'Sync Selected Worlds'}
              </button>
            )}
          </div>
        </header>

        <div className="content">
          {/* TAB 1: WORLDS */}
          {tab === 'worlds' && (
            <>
              {!destStatus?.connected && (
                <div className="card" style={{ borderColor: 'rgba(245, 158, 11, 0.45)' }}>
                  <div className="card-title" style={{ color: '#f59e0b' }}>
                    <AlertTriangle size={16} /> No Sync Destination Connected
                  </div>
                  <p style={{ fontSize: 13, color: '#cbd5e1', marginBottom: 10 }}>
                    Configure a local/network folder or connect to a peer computer to start
                    synchronising your worlds. You can still browse local worlds and create local
                    snapshots right now.
                  </p>
                  <button className="btn btn-amber btn-sm" onClick={() => setTab('destinations')}>
                    Configure Sync Destination
                  </button>
                </div>
              )}

              <div className={`worlds-layout ${selectedWorld ? 'with-drawer' : ''}`}>
                <div className="world-list">
                  {worlds.length === 0 ? (
                    <div className="card empty-state">
                      <Box size={32} style={{ marginBottom: 10, opacity: 0.5 }} />
                      <p>No Minecraft worlds found yet.</p>
                      <p style={{ fontSize: 12, marginTop: 6 }}>
                        Add your Minecraft saves folder in <strong>Providers & Mods</strong> or
                        connect a sync destination containing remote worlds.
                      </p>
                    </div>
                  ) : (
                    worlds.map((w) => (
                      <div
                        key={w.worldId}
                        className={`world-card ${selectedWorldId === w.worldId ? 'selected' : ''} ${w.hasConflicts ? 'conflict' : ''}`}
                      >
                        <div className="world-header">
                          {w.localMeta?.iconDataUrl ? (
                            <img
                              src={w.localMeta.iconDataUrl}
                              alt={w.displayName}
                              className="world-icon"
                            />
                          ) : (
                            <div className="world-icon">
                              <Box size={22} />
                            </div>
                          )}

                          <div className="world-info">
                            <div className="world-name">
                              <span>{w.displayName}</span>
                              {statusBadge(w.status)}
                              {w.versionMode === 'multi' && (
                                <span className="badge badge-purple">
                                  <GitBranch size={11} /> Multi-Version
                                </span>
                              )}
                            </div>
                            <div className="world-meta">
                              <span>Folder: {w.folderName}</span>
                              {w.localMeta?.mcVersion && <span>MC {w.localMeta.mcVersion}</span>}
                              {w.localMeta?.gameType && w.localMeta.gameType !== 'Unknown' && (
                                <span>
                                  {w.localMeta.hardcore ? 'Hardcore' : w.localMeta.gameType}
                                </span>
                              )}
                              {w.localSize !== undefined && <span>{formatBytes(w.localSize)}</span>}
                              <span>{w.versions.length} version(s)</span>
                            </div>
                          </div>
                        </div>

                        <div className="world-footer">
                          <div className="row" style={{ gap: 14 }}>
                            {w.hasLocal && (
                              <label className="toggle-label">
                                <input
                                  type="checkbox"
                                  checked={w.syncEnabled}
                                  onChange={(e) => void handleToggleSync(w, e.target.checked)}
                                />
                                Sync this world
                              </label>
                            )}
                            {w.hasLocal && (
                              <button
                                className="btn btn-sm"
                                onClick={() => void handleToggleVersionMode(w)}
                                title="Single-version auto-updates to the latest save; Multi-version lets you keep & switch between multiple snapshots/branches."
                              >
                                <GitBranch size={13} />
                                {w.versionMode === 'single'
                                  ? 'Mode: Single (Latest)'
                                  : 'Mode: Multi-Version'}
                              </button>
                            )}
                          </div>

                          <div className="row">
                            <button
                              className="btn btn-sm"
                              onClick={() =>
                                setSelectedWorldId(
                                  selectedWorldId === w.worldId ? null : w.worldId,
                                )
                              }
                            >
                              <History size={13} />
                              Versions ({w.versions.length})
                            </button>

                            {w.hasRemote && !w.hasLocal ? (
                              <button
                                className="btn btn-primary btn-sm"
                                onClick={() => setSelectedWorldId(w.worldId)}
                              >
                                <Download size={13} /> Choose Version to Download
                              </button>
                            ) : (
                              <button
                                className="btn btn-primary btn-sm"
                                disabled={busy !== null || !destStatus?.connected}
                                onClick={() => void handleSyncWorld(w)}
                              >
                                <FolderSync size={13} />
                                {busy === `sync:${w.worldId}` ? 'Syncing...' : 'Sync Now'}
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    ))
                  )}
                </div>

                {/* Version Selector & Conflict Resolution Drawer */}
                {selectedWorld && (
                  <aside className="drawer">
                    <div className="row" style={{ justifyContent: 'space-between' }}>
                      <div>
                        <h3 style={{ fontSize: 16 }}>{selectedWorld.displayName}</h3>
                        <span style={{ fontSize: 12, color: '#94a3b8' }}>
                          Select which version of this world to use on this PC
                        </span>
                      </div>
                      <button
                        className="btn btn-sm"
                        onClick={() => setSelectedWorldId(null)}
                      >
                        Close
                      </button>
                    </div>

                    {selectedWorld.hasConflicts && (
                      <div className="conflict-banner">
                        <strong>Conflict Detected:</strong> Both this computer and another device
                        modified this world since the last sync. ChunkSafe preserved{' '}
                        <strong>both versions</strong> below. Pick which version you want on this
                        PC, promote it to Latest, or install both side-by-side.
                      </div>
                    )}

                    {/* Create Named Snapshot / Branch */}
                    {selectedWorld.hasLocal && (
                      <div className="card" style={{ padding: 12 }}>
                        <div className="card-title" style={{ fontSize: 13 }}>
                          <Plus size={14} /> Create Snapshot / Manage Multiple Versions
                        </div>
                        <div className="row" style={{ marginBottom: 8 }}>
                          <input
                            className="input"
                            style={{ flex: 1 }}
                            placeholder="Label (e.g. Before Dragon Fight)"
                            value={snapLabel}
                            onChange={(e) => setSnapLabel(e.target.value)}
                          />
                          <input
                            className="input"
                            style={{ width: 120 }}
                            placeholder="Branch"
                            value={snapBranch}
                            onChange={(e) => setSnapBranch(e.target.value)}
                          />
                        </div>
                        <div className="row">
                          <input
                            className="input"
                            style={{ flex: 1 }}
                            placeholder="Optional notes..."
                            value={snapNotes}
                            onChange={(e) => setSnapNotes(e.target.value)}
                          />
                          <button
                            className="btn btn-primary btn-sm"
                            disabled={busy !== null}
                            onClick={() => void handleCreateSnapshot(selectedWorld)}
                          >
                            Save Snapshot
                          </button>
                        </div>
                      </div>
                    )}

                    {/* Version Timeline */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                      {selectedWorld.versions.length === 0 ? (
                        <p style={{ fontSize: 13, color: '#94a3b8' }}>
                          No versions recorded yet. Click <strong>Sync Now</strong> or{' '}
                          <strong>Save Snapshot</strong> to create the first version.
                        </p>
                      ) : (
                        selectedWorld.versions.map((v) => {
                          const isActive = selectedWorld.activeVersionId === v.versionId;
                          const isLatest = selectedWorld.latestRemoteVersionId === v.versionId;
                          return (
                            <div
                              key={v.versionId}
                              className={`version-item ${isActive ? 'active-version' : ''} ${v.isConflict ? 'conflict-version' : ''}`}
                            >
                              <div className="version-top">
                                <span className="version-id">{v.versionId}</span>
                                <div className="row" style={{ gap: 5 }}>
                                  <span className="badge badge-slate">{v.branch}</span>
                                  {isLatest && <span className="badge badge-blue">Latest</span>}
                                  {isActive && (
                                    <span className="badge badge-green">
                                      <CheckCircle2 size={11} /> On This PC
                                    </span>
                                  )}
                                  {v.isConflict && (
                                    <span className="badge badge-rose">Conflict</span>
                                  )}
                                </div>
                              </div>

                              {v.label && (
                                <div style={{ fontSize: 13, fontWeight: 600 }}>{v.label}</div>
                              )}
                              {v.notes && (
                                <div style={{ fontSize: 12, color: '#94a3b8' }}>{v.notes}</div>
                              )}

                              <div style={{ fontSize: 11.5, color: '#94a3b8' }}>
                                Device: <strong>{v.deviceName}</strong> · {formatDate(v.createdAt)} ·{' '}
                                {v.fileCount} files ({formatBytes(v.totalSize)})
                              </div>

                              <div className="version-actions">
                                <button
                                  className="btn btn-primary btn-sm"
                                  disabled={busy !== null}
                                  onClick={() => void handleApplyVersion(selectedWorld, v)}
                                >
                                  <Download size={12} />
                                  {busy === `apply:${v.versionId}`
                                    ? 'Applying...'
                                    : 'Use on This PC'}
                                </button>

                                {(v.isConflict || !isLatest) && (
                                  <button
                                    className="btn btn-amber btn-sm"
                                    disabled={busy !== null}
                                    onClick={() =>
                                      void handleApplyVersion(selectedWorld, v, {
                                        promoteToMain: true,
                                      })
                                    }
                                  >
                                    Use & Set as Latest
                                  </button>
                                )}

                                <button
                                  className="btn btn-sm"
                                  disabled={busy !== null}
                                  onClick={() => {
                                    setSideBySideVersionId(
                                      sideBySideVersionId === v.versionId ? null : v.versionId,
                                    );
                                    setSideBySideFolder(
                                      `${selectedWorld.folderName}_${v.branch}`,
                                    );
                                  }}
                                >
                                  <Copy size={12} /> Install Side-by-Side
                                </button>
                              </div>

                              {sideBySideVersionId === v.versionId && (
                                <div className="row" style={{ marginTop: 6 }}>
                                  <input
                                    className="input"
                                    style={{ flex: 1 }}
                                    value={sideBySideFolder}
                                    onChange={(e) => setSideBySideFolder(e.target.value)}
                                    placeholder="New local folder name"
                                  />
                                  <button
                                    className="btn btn-primary btn-sm"
                                    disabled={!sideBySideFolder.trim() || busy !== null}
                                    onClick={() =>
                                      void handleApplyVersion(selectedWorld, v, {
                                        installAsNewFolderName: sideBySideFolder.trim(),
                                      })
                                    }
                                  >
                                    Install Copy
                                  </button>
                                </div>
                              )}
                            </div>
                          );
                        })
                      )}
                    </div>
                  </aside>
                )}
              </div>
            </>
          )}

          {/* TAB 2: DESTINATIONS (FOLDER + PEER-TO-PEER) */}
          {tab === 'destinations' && settings && (
            <div className="grid-2">
              {/* Folder / Network Share Sync */}
              <div
                className="card"
                style={{
                  borderColor:
                    settings.activeDestination === 'folder' ? 'var(--accent)' : undefined,
                }}
              >
                <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
                  <div className="card-title" style={{ margin: 0 }}>
                    <FolderSync size={17} /> Local / Network Folder Sync
                  </div>
                  <button
                    className={`btn btn-sm ${settings.activeDestination === 'folder' ? 'btn-primary' : ''}`}
                    onClick={async () => {
                      await window.chunkSafe.updateSettings({ activeDestination: 'folder' });
                      await refreshAll();
                    }}
                  >
                    {settings.activeDestination === 'folder' ? 'Active Mode' : 'Use Folder Sync'}
                  </button>
                </div>

                <p style={{ fontSize: 13, color: '#94a3b8', marginBottom: 14 }}>
                  Synchronise saves to any local folder, external USB drive, NAS / SMB network
                  share (e.g. <code>\\NAS\ChunkSafe</code> or <code>/Volumes/NAS</code>), or
                  cloud-synced directory (Proton Drive, Dropbox, OneDrive, iCloud).
                </p>

                <div className="field">
                  <label>Sync Folder Path</label>
                  <div className="row">
                    <input
                      className="input"
                      style={{ flex: 1 }}
                      value={settings.folderSyncPath}
                      placeholder="Select a local or network folder..."
                      onChange={async (e) => {
                        await window.chunkSafe.updateSettings({
                          folderSyncPath: e.target.value,
                        });
                        await refreshAll();
                      }}
                    />
                    <button className="btn" onClick={() => void handlePickSyncFolder()}>
                      Browse...
                    </button>
                  </div>
                </div>

                {settings.activeDestination === 'folder' && destStatus && (
                  <div style={{ fontSize: 12.5, color: '#cbd5e1', marginTop: 8 }}>
                    Status:{' '}
                    <strong style={{ color: destStatus.connected ? '#10b981' : '#f43f5e' }}>
                      {destStatus.connected ? 'Connected' : 'Not Connected'}
                    </strong>
                    {destStatus.connected && (
                      <>
                        {' '}
                        · {destStatus.worldCount} world(s) · {destStatus.objectCount ?? 0}{' '}
                        deduplicated objects ({formatBytes(destStatus.totalStorageBytes)})
                      </>
                    )}
                  </div>
                )}
              </div>

              {/* Peer-to-Peer Sync */}
              <div
                className="card"
                style={{
                  borderColor:
                    settings.activeDestination === 'p2p' ? 'var(--accent)' : undefined,
                }}
              >
                <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
                  <div className="card-title" style={{ margin: 0 }}>
                    <Wifi size={17} /> Peer-to-Peer (Direct Sync)
                  </div>
                  <button
                    className={`btn btn-sm ${settings.activeDestination === 'p2p' ? 'btn-primary' : ''}`}
                    onClick={async () => {
                      await window.chunkSafe.updateSettings({ activeDestination: 'p2p' });
                      await refreshAll();
                    }}
                  >
                    {settings.activeDestination === 'p2p' ? 'Active Mode' : 'Use P2P Sync'}
                  </button>
                </div>

                <p style={{ fontSize: 13, color: '#94a3b8', marginBottom: 14 }}>
                  Sync directly between computers on your Wi-Fi / LAN (auto-discovered) or over
                  VPN / Tailscale / IP address. Protected by your pairing code.
                </p>

                <div
                  className="card"
                  style={{ background: '#0b1222', padding: 12, marginBottom: 14 }}
                >
                  <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
                    <span style={{ fontSize: 12, color: '#94a3b8' }}>
                      This Computer&apos;s P2P Server
                    </span>
                    <label className="toggle-label">
                      <input
                        type="checkbox"
                        checked={settings.p2pEnabled}
                        onChange={async (e) => {
                          await window.chunkSafe.updateSettings({
                            p2pEnabled: e.target.checked,
                          });
                          await refreshAll();
                        }}
                      />
                      Allow Peers to Connect
                    </label>
                  </div>
                  <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
                    <div style={{ fontSize: 12 }}>
                      <div>
                        Status:{' '}
                        <strong style={{ color: p2pInfo?.running ? '#10b981' : '#f43f5e' }}>
                          {p2pInfo?.running ? `Listening on port ${p2pInfo.port}` : 'Stopped'}
                        </strong>
                      </div>
                      <div style={{ color: '#94a3b8', marginTop: 2 }}>
                        IPs: {p2pInfo?.addresses.join(', ') || '127.0.0.1'}
                      </div>
                    </div>
                    <div>
                      <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 2 }}>
                        Pairing Code
                      </div>
                      <div className="code-box">{p2pInfo?.pairingCode}</div>
                    </div>
                  </div>
                </div>

                {/* Discovered & Saved Peers */}
                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 6 }}>
                    Available Peers ({p2pInfo?.discoveredPeers.length || 0})
                  </div>
                  {(!p2pInfo || p2pInfo.discoveredPeers.length === 0) ? (
                    <div style={{ fontSize: 12.5, color: '#64748b' }}>
                      No peers discovered on LAN yet. Open ChunkSafe on another computer on the
                      same network, or add a peer by IP below.
                    </div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {p2pInfo.discoveredPeers.map((peer) => {
                        const isSelected = settings.selectedPeerId === peer.peerId;
                        return (
                          <div
                            key={peer.peerId}
                            className="row"
                            style={{
                              justifyContent: 'space-between',
                              padding: '8px 10px',
                              borderRadius: 8,
                              background: '#0b1222',
                              border: `1px solid ${isSelected ? 'var(--accent)' : 'var(--border)'}`,
                            }}
                          >
                            <div>
                              <div style={{ fontSize: 13, fontWeight: 600 }}>
                                <span
                                  className={`dot ${peer.online ? 'online' : 'offline'}`}
                                  style={{ marginRight: 6 }}
                                />
                                {peer.deviceName}
                              </div>
                              <div style={{ fontSize: 11.5, color: '#94a3b8' }}>
                                {peer.host}:{peer.port} · {peer.source.toUpperCase()} ·{' '}
                                {peer.platform}
                              </div>
                            </div>
                            <div className="row">
                              <button
                                className={`btn btn-sm ${isSelected ? 'btn-primary' : ''}`}
                                onClick={() => void handleSelectPeer(peer.peerId)}
                              >
                                {isSelected ? 'Selected' : 'Select'}
                              </button>
                              {peer.source === 'manual' && (
                                <button
                                  className="btn btn-danger btn-sm"
                                  onClick={async () => {
                                    await window.chunkSafe.removePeer(peer.peerId);
                                    await refreshAll();
                                  }}
                                >
                                  <Trash2 size={12} />
                                </button>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Add Manual Peer */}
                <form onSubmit={(e) => void handleAddManualPeer(e)}>
                  <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 6 }}>
                    Connect to Peer by IP / Hostname
                  </div>
                  <div className="row" style={{ marginBottom: 8 }}>
                    <input
                      className="input"
                      style={{ flex: 2 }}
                      placeholder="IP or Hostname (e.g. 192.168.1.42)"
                      value={peerHost}
                      onChange={(e) => setPeerHost(e.target.value)}
                    />
                    <input
                      className="input"
                      style={{ width: 84 }}
                      placeholder="Port"
                      value={peerPort}
                      onChange={(e) => setPeerPort(e.target.value)}
                    />
                  </div>
                  <div className="row">
                    <input
                      className="input"
                      style={{ flex: 1 }}
                      placeholder="Peer's Pairing Code"
                      value={peerCode}
                      onChange={(e) => setPeerCode(e.target.value.toUpperCase())}
                    />
                    <input
                      className="input"
                      style={{ flex: 1 }}
                      placeholder="Nickname (optional)"
                      value={peerName}
                      onChange={(e) => setPeerName(e.target.value)}
                    />
                    <button
                      type="submit"
                      className="btn btn-primary btn-sm"
                      disabled={!peerHost.trim() || busy !== null}
                    >
                      Add Peer
                    </button>
                  </div>
                </form>
              </div>
            </div>
          )}

          {/* TAB 3: PROVIDERS & EXTENSIBILITY */}
          {tab === 'providers' && settings && (
            <>
              <div className="card">
                <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
                  <div className="card-title" style={{ margin: 0 }}>
                    <HardDrive size={16} /> Monitored Minecraft Save Folders
                  </div>
                  <button className="btn btn-primary btn-sm" onClick={() => void handleAddSaveRoot()}>
                    <Plus size={14} /> Add Custom Saves Folder
                  </button>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {settings.saveRoots.map((r) => (
                    <div
                      key={r.path}
                      className="row"
                      style={{
                        justifyContent: 'space-between',
                        padding: '8px 12px',
                        borderRadius: 8,
                        background: '#0b1222',
                        border: '1px solid var(--border)',
                      }}
                    >
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 600 }}>{r.label}</div>
                        <div style={{ fontSize: 12, color: '#94a3b8' }}>{r.path}</div>
                      </div>
                      <div className="row">
                        <button
                          className="btn btn-sm"
                          onClick={() => void window.chunkSafe.openPath(r.path)}
                        >
                          Open
                        </button>
                        {!r.isDefault && (
                          <button
                            className="btn btn-danger btn-sm"
                            onClick={() => void handleRemoveSaveRoot(r.path)}
                          >
                            Remove
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="grid-2">
                {providers.map((p) => (
                  <div key={p.id} className="card">
                    <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
                      <div className="card-title" style={{ margin: 0 }}>
                        {p.name}
                      </div>
                      <span
                        className={`badge ${p.status === 'active' ? 'badge-green' : 'badge-purple'}`}
                      >
                        {p.status === 'active' ? 'Active' : 'Extensible Plugin (Planned)'}
                      </span>
                    </div>
                    <p style={{ fontSize: 13, color: '#94a3b8', marginBottom: 10 }}>
                      {p.description}
                    </p>
                    <ul style={{ paddingLeft: 18, fontSize: 12.5, color: '#cbd5e1' }}>
                      {p.capabilities.map((c) => (
                        <li key={c} style={{ marginBottom: 3 }}>
                          {c}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </>
          )}

          {/* TAB 4: SETTINGS & LOG */}
          {tab === 'settings' && settings && (
            <div className="grid-2">
              <div className="card">
                <div className="card-title">
                  <Settings size={16} /> General & Safety Settings
                </div>

                <div className="field">
                  <label>Device Name (shown in version history & P2P discovery)</label>
                  <input
                    className="input"
                    value={settings.deviceName}
                    onChange={async (e) => {
                      await window.chunkSafe.updateSettings({ deviceName: e.target.value });
                      await refreshAll();
                    }}
                  />
                </div>

                <div className="field">
                  <label>P2P Server Port</label>
                  <input
                    className="input"
                    type="number"
                    value={settings.p2pPort}
                    onChange={async (e) => {
                      const val = Number(e.target.value);
                      if (val > 1024 && val < 65535) {
                        await window.chunkSafe.updateSettings({ p2pPort: val });
                        await refreshAll();
                      }
                    }}
                  />
                </div>

                <div className="field">
                  <label>P2P Pairing Code</label>
                  <input
                    className="input"
                    value={settings.p2pPairingCode}
                    onChange={async (e) => {
                      await window.chunkSafe.updateSettings({
                        p2pPairingCode: e.target.value.toUpperCase(),
                      });
                      await refreshAll();
                    }}
                  />
                </div>

                <label className="toggle-label" style={{ marginTop: 8 }}>
                  <input
                    type="checkbox"
                    checked={settings.autoBackupBeforeOverwrite}
                    onChange={async (e) => {
                      await window.chunkSafe.updateSettings({
                        autoBackupBeforeOverwrite: e.target.checked,
                      });
                      await refreshAll();
                    }}
                  />
                  Automatically back up local save before overwriting with another version
                </label>
              </div>

              <div className="card">
                <div className="card-title">Activity Log</div>
                <div className="log-list" style={{ maxHeight: 420, overflowY: 'auto' }}>
                  {logs.length === 0 ? (
                    <div style={{ color: '#64748b' }}>No activity yet.</div>
                  ) : (
                    logs.map((entry) => (
                      <div key={entry.id} className="log-item">
                        <span style={{ color: '#64748b', flexShrink: 0 }}>
                          {new Date(entry.timestamp).toLocaleTimeString()}
                        </span>
                        <span
                          style={{
                            color:
                              entry.level === 'error'
                                ? '#f43f5e'
                                : entry.level === 'warn'
                                  ? '#f59e0b'
                                  : entry.level === 'success'
                                    ? '#10b981'
                                    : '#cbd5e1',
                          }}
                        >
                          {entry.message}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </main>

      {toast && (
        <div className={`toast ${toast.isError ? 'error' : ''}`}>{toast.text}</div>
      )}
    </div>
  );
}
