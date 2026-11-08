import { contextBridge, ipcRenderer } from 'electron'
import type { SkillsBridge } from '../shared/types'

const bridge: SkillsBridge = {
  acceptChanges: id => ipcRenderer.invoke('skills:acceptChanges', id),
  bulk: (action, ids) => ipcRenderer.invoke('skills:bulk', { action, ids }),
  restorePreview: () => ipcRenderer.invoke('skills:restorePreview'),
  restoreApply: previewId => ipcRenderer.invoke('skills:restoreApply', previewId),
  revealExport: () => ipcRenderer.invoke('skills:revealExport'),
  chooseFolder: () => ipcRenderer.invoke('skills:chooseFolder'),
  scan: () => ipcRenderer.invoke('skills:scan'),
  list: () => ipcRenderer.invoke('skills:list'),
  detail: id => ipcRenderer.invoke('skills:detail', id),
  setupPreview: () => ipcRenderer.invoke('skills:setupPreview'),
  setupApply: request => ipcRenderer.invoke('skills:setupApply', request),
  fixBrokenLinks: previewId => ipcRenderer.invoke('skills:fixBrokenLinks', previewId),
  enable: id => ipcRenderer.invoke('skills:enable', id),
  disable: id => ipcRenderer.invoke('skills:disable', id),
  setDestinations: (id, destinationIds) => ipcRenderer.invoke('skills:setDestinations', { id, destinationIds }),
  delete: id => ipcRenderer.invoke('skills:delete', id),
  removeMissing: id => ipcRenderer.invoke('skills:removeMissing', id),
  importPreview: source => ipcRenderer.invoke('skills:importPreview', source),
  importApply: request => ipcRenderer.invoke('skills:importApply', request),
  rescan: () => ipcRenderer.invoke('skills:rescan'),
  reveal: id => ipcRenderer.invoke('skills:reveal', id),
  browseMarketplace: () => ipcRenderer.invoke('skills:browseMarketplace'),
  cancelImport: () => ipcRenderer.invoke('skills:cancelImport')
}

contextBridge.exposeInMainWorld('skillsManager', bridge)
