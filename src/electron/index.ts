import { app, BrowserWindow, ipcMain, session, nativeTheme } from 'electron'
import { mkdirSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createBridgeService } from './serviceAdapter'
import type { ImportApply } from '../shared/types'

const directory = dirname(fileURLToPath(import.meta.url))
const page = pathToFileURL(join(directory, '../renderer/index.html')).href
const devUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined
if (devUrl && !/^http:\/\/(localhost|127\.0\.0\.1):\d+\/?$/.test(devUrl)) throw new Error('Invalid development URL.')
const allowedPage = new URL(devUrl || page).href
const isolatedHome = process.env.SKILLS_MANAGER_HOME
if (isolatedHome) {
  if (!isAbsolute(isolatedHome)) throw new Error('SKILLS_MANAGER_HOME must be an absolute path.')
  const userData = join(isolatedHome, '.skills_manager', 'electron')
  mkdirSync(userData, { recursive: true })
  app.setPath('userData', userData)
}

function text(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || value.includes('\0')) throw new Error('Invalid text.')
  return value
}
function selection(value: unknown): ImportApply {
  if (!value || typeof value !== 'object' || !('previewId' in value) || !('skillIds' in value) || !('destinations' in value)) throw new Error('Invalid selection.')
  const { previewId, skillIds, destinations } = value
  if (!Array.isArray(skillIds) || !Array.isArray(destinations) || skillIds.length > 10000 || destinations.length > 100) throw new Error('Invalid selection.')
  const names = 'names' in value ? value.names : undefined
  if (names !== undefined && (!Array.isArray(names) || names.length > 10000)) throw new Error('Invalid selection.')
  const parsedNames = names?.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object' || !('skillId' in entry) || !('name' in entry)) throw new Error('Invalid selection.')
    return { skillId: text(entry.skillId), name: text(entry.name) }
  })
  return { previewId: text(previewId), skillIds: skillIds.map(text), destinations: destinations.map(text), ...(parsedNames ? { names: parsedNames } : {}) }
}

if (!app.requestSingleInstanceLock()) app.quit()
else {
  let window: BrowserWindow | undefined
  app.on('second-instance', () => { window?.show(); window?.focus() })
  void app.whenReady().then(async () => {
    nativeTheme.themeSource = 'dark'
    const { bridge, cleanup, ready } = createBridgeService()
    // Bridge calls retain the recovery error until a rescan retries it.
    void ready.catch(() => undefined)
    // All calls share one queue so a scan cannot observe an unfinished write.
    let queue: Promise<unknown> = Promise.resolve()
    let importGeneration = 0
    const register = (name: string, action: (payload: unknown) => Promise<unknown>) => {
      ipcMain.handle(`skills:${name}`, (event, payload: unknown) => {
        if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== allowedPage) throw new Error('Untrusted request.')
        const generation = name === 'importPreview' ? ++importGeneration : importGeneration
        const result = queue.then(() => {
          if (name === 'importPreview' && generation !== importGeneration) throw new Error('Import canceled.')
          return action(payload)
        })
        queue = result.catch(() => undefined)
        return result
      })
    }
    register('bulk', value => {
      if (!value || typeof value !== 'object' || !('action' in value) || !('ids' in value) || !Array.isArray(value.ids) || !value.ids.length || value.ids.length > 10000 || !['enable', 'disable', 'delete', 'keep'].includes(String(value.action))) throw new Error('Invalid bulk action.');
      return bridge.bulk(value.action as 'enable' | 'disable' | 'delete' | 'keep', value.ids.map(text));
    })
    register('restorePreview', () => bridge.restorePreview())
    register('restoreApply', value => bridge.restoreApply(text(value)))
    register('revealExport', () => bridge.revealExport())
    register('chooseFolder', () => bridge.chooseFolder())
    register('scan', () => bridge.scan())
    register('list', () => bridge.list())
    register('detail', value => bridge.detail(text(value)))
    register('setupPreview', () => bridge.setupPreview())
    register('setupApply', value => bridge.setupApply(selection(value)))
    register('fixBrokenLinks', value => bridge.fixBrokenLinks(text(value)))
    register('enable', value => bridge.enable(text(value)))
    register('disable', value => bridge.disable(text(value)))
    register('setDestinations', value => {
      if (!value || typeof value !== 'object' || !('id' in value) || !('destinationIds' in value) || !Array.isArray(value.destinationIds) || value.destinationIds.length > 100) throw new Error('Invalid destinations.')
      return bridge.setDestinations(text(value.id), value.destinationIds.map(text))
    })
    register('delete', value => bridge.delete(text(value)))
    register('acceptChanges', value => bridge.acceptChanges(text(value)))
    register('removeMissing', value => bridge.removeMissing(text(value)))
    register('importPreview', value => bridge.importPreview(text(value)))
    register('importApply', value => bridge.importApply(selection(value)))
    register('rescan', () => bridge.rescan())
    register('reveal', value => bridge.reveal(text(value)))
    register('browseMarketplace', () => bridge.browseMarketplace())
    ipcMain.handle('skills:cancelImport', event => {
      if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== allowedPage) throw new Error('Untrusted request.')
      importGeneration++
      return bridge.cancelImport()
    })
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    session.defaultSession.setPermissionCheckHandler(() => false)
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': ["default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'" + (devUrl ? ' ws://localhost:* ws://127.0.0.1:*' : '') + "; object-src 'none'; frame-src 'none'; base-uri 'none'"] } })
    })
    const createWindow = () => {
      window = new BrowserWindow({ width: 1240, height: 820, minWidth: 760, minHeight: 560, title: 'Skills Manager', backgroundColor: '#101012', webPreferences: { preload: join(directory, '../preload/index.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false } })
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      window.webContents.on('will-navigate', event => event.preventDefault())
      window.webContents.on('will-attach-webview', event => event.preventDefault())
      void window.loadURL(allowedPage)
      window.on('closed', () => { window = undefined })
    }
    createWindow()
    app.on('activate', () => { if (!window) createWindow() })
    let cleaningUp = false
    app.on('before-quit', (event) => {
      if (cleaningUp) return
      event.preventDefault()
      cleaningUp = true
      void cleanup().finally(() => app.quit())
    })
  })
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
}
