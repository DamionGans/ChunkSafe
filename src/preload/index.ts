import { contextBridge, ipcRenderer } from 'electron';
import { ChunkSafeApi } from '../shared/ipc';

const api: ChunkSafeApi = {
  getSettings: () => ipcRenderer.invoke('chunksafe:getSettings'),
  updateSettings: (partial) => ipcRenderer.invoke('chunksafe:updateSettings', partial),
  pickDirectory: (title) => ipcRenderer.invoke('chunksafe:pickDirectory', title),
  openPath: (targetPath) => ipcRenderer.invoke('chunksafe:openPath', targetPath),
  listProviders: () => ipcRenderer.invoke('chunksafe:listProviders'),
  listWorlds: () => ipcRenderer.invoke('chunksafe:listWorlds'),
  getDestinationStatus: () => ipcRenderer.invoke('chunksafe:getDestinationStatus'),
  setWorldSyncEnabled: (worldId, enabled) =>
    ipcRenderer.invoke('chunksafe:setWorldSyncEnabled', worldId, enabled),
  setWorldVersionMode: (worldId, mode) =>
    ipcRenderer.invoke('chunksafe:setWorldVersionMode', worldId, mode),
  syncWorld: (worldId) => ipcRenderer.invoke('chunksafe:syncWorld', worldId),
  syncAll: () => ipcRenderer.invoke('chunksafe:syncAll'),
  createSnapshot: (worldId, opts) =>
    ipcRenderer.invoke('chunksafe:createSnapshot', worldId, opts),
  applyVersion: (options) => ipcRenderer.invoke('chunksafe:applyVersion', options),
  getP2PInfo: () => ipcRenderer.invoke('chunksafe:getP2PInfo'),
  addManualPeer: (input) => ipcRenderer.invoke('chunksafe:addManualPeer', input),
  removePeer: (peerId) => ipcRenderer.invoke('chunksafe:removePeer', peerId),
  getActivityLog: () => ipcRenderer.invoke('chunksafe:getActivityLog'),
};

contextBridge.exposeInMainWorld('chunkSafe', api);
