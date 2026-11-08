import { shell, dialog, BrowserWindow } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createSkillsService } from '../main/service'
import { parseImportSource, stageImport } from '../main/import'
import { inside } from '../main/paths'
import type { SkillsBridge } from '../shared/types'

export function createBridgeService() {
  const service = createSkillsService()
  let recovery = service.recover()
  const ready = recovery
  const afterRecovery = async <T>(action: () => Promise<T>): Promise<T> => {
    await recovery
    return action()
  }
  let staged: Awaited<ReturnType<typeof stageImport>> | undefined
  let importing: AbortController | undefined

  let closing = false
  const pendingImports = new Set<Promise<unknown>>()
  const cleanup = async () => {
    const previous = staged
    if (previous) {
      await previous.cleanup()
      if (staged === previous) staged = undefined
    }
  }
  const bridge: SkillsBridge = {
    acceptChanges: id => afterRecovery(() => service.acceptChanges(id)),
    bulk: (action, ids) => afterRecovery(() => service.bulk(action, ids)),
    restorePreview: () => afterRecovery(() => service.restorePreview()),
    restoreApply: previewId => afterRecovery(() => service.restoreApply(previewId)),
    async revealExport() {
      const saved = JSON.parse(await fs.readFile(path.join(service.paths.store, 'last-export.json'), 'utf8'));
      if (typeof saved.path !== 'string' || path.dirname(saved.path) !== service.paths.home || !path.basename(saved.path).startsWith('Skills Manager Export-')) throw new Error('Invalid export path.');
      shell.showItemInFolder(saved.path);
    },
    async chooseFolder() {
      const parent = BrowserWindow.getAllWindows()[0];
      if (!parent) throw new Error('No window is open.');
      const result = await dialog.showOpenDialog(parent, { properties: ['openDirectory'], buttonLabel: 'Choose folder', defaultPath: service.paths.home });
      return result.canceled ? null : result.filePaths[0] ?? null;
    },
    scan: () => afterRecovery(() => service.scan()),
    list: () => afterRecovery(() => service.list()),
    detail: id => afterRecovery(() => service.detail(id)),
    setupPreview: () => afterRecovery(() => service.setupPreview()),
    setupApply: request => afterRecovery(() => service.setupApply(request)),
    fixBrokenLinks: previewId => afterRecovery(() => service.fixBrokenLinks(previewId)),
    enable: id => afterRecovery(() => service.enable(id)),
    disable: id => afterRecovery(() => service.disable(id)),
    setDestinations: (id, destinationIds) => afterRecovery(() => service.setDestinations(id, destinationIds)),
    delete: id => afterRecovery(() => service.delete(id)),
    removeMissing: id => afterRecovery(() => service.removeMissing(id)),
    async rescan() {
      await recovery.catch(() => {
        recovery = service.recover()
        return recovery
      })
      return service.rescan()
    },
    importPreview(source) {
      if (closing) return Promise.reject(new Error('The app is closing.'))
      importing?.abort()
      const controller = new AbortController()
      importing = controller
      const checkCancelled = () => {
        if (controller.signal.aborted) throw new Error('Import cancelled.')
      }
      const work = (async () => {
        let ownedStage: typeof staged
        const cleanupOwned = async () => {
          if (!ownedStage) return
          await ownedStage.cleanup()
          if (staged === ownedStage) staged = undefined
        }
        try {
          await recovery
          checkCancelled()
          await cleanup()
          checkCancelled()
          const parsed = parseImportSource(source)
          if (parsed.localPath) {
            const localReal = await fs.realpath(parsed.localPath)
            const preview = await service.setupPreview(controller.signal)
            const roots = await Promise.all(service.paths.destinations.map(root => fs.realpath(root.path).catch(() => null)))
            const matches = await Promise.all(preview.skills.filter(skill => !skill.external).map(async skill => {
              const entries = await Promise.all([skill.path, ...skill.aliases].map(async file => path.join(await fs.realpath(path.dirname(file)), path.basename(file))))
              return { skill, selected: (inside(localReal, skill.realPath) || entries.some(file => inside(localReal, file))) && (!parsed.skills.length || parsed.skills.includes('*') || parsed.skills.some(name => name.toLowerCase() === skill.name.toLowerCase())) }
            }))
            const hashes = new Set(matches.filter(match => match.selected).map(match => match.skill.contentHash))
            if (roots.some(root => root && inside(root, localReal)) || matches.some(match => match.skill.realPath === localReal)) {
              checkCancelled()
              return { ...preview, selectedSkillIds: preview.skills.filter(skill => hashes.has(skill.contentHash)).map(skill => skill.id) }
            }
            if (hashes.size) throw new Error('This folder includes installed skills. Use Setup, or import a skill folder.')
          }
          checkCancelled()
          ownedStage = await stageImport(source, service.paths, controller.signal)
          checkCancelled()
          staged = ownedStage
          const preview = await service.previewImport(ownedStage.root, ownedStage.localPath ? { path: ownedStage.localPath } : { path: '.', repository: ownedStage.source, revision: ownedStage.revision, subpath: ownedStage.subpath }, controller.signal, ownedStage.origins)
          checkCancelled()
          return { ...preview, issues: [...ownedStage.issues, ...preview.issues], kind: 'import' as const }
        } catch (error) {
          await cleanupOwned()
          throw error
        } finally {
          if (importing === controller) importing = undefined
        }
      })()
      pendingImports.add(work)
      void work.then(() => pendingImports.delete(work), () => pendingImports.delete(work))
      return work
    },
    async importApply(request) {
      await recovery
      const result = await service.applyImport(request)
      if (result.ok) await cleanup()
      return result
    },
    browseMarketplace: () => shell.openExternal('https://skills.sh/'),
    async cancelImport() {
      importing?.abort()
      await cleanup()
    },
    async reveal(id) {
      await recovery
      const detail = await service.detail(id)
      shell.showItemInFolder(detail.canonicalPath)
    }
  }
  return { bridge, ready, cleanup: async () => {
    closing = true
    importing?.abort()
    await Promise.allSettled([...pendingImports])
    await cleanup()
  } }
}
