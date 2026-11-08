import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { parse, parseDocument, isMap } from 'yaml';
import type { Destination, BulkAction, BulkResult, RestorePreview, RestoreResult, BrokenLink, ImportApply, ImportOrigin, Issue, OperationResult, SetupApply, SetupPreview, SkillDetail, SkillSummary, SourceRecord, StoredSkill } from '../shared/types';
import { resolvePaths, inside, validName, skillFolderName, type RuntimePaths } from './paths';
import { exists, scanRoots, treeHash } from './discovery';
import { atomicJson, readCatalog } from './catalog';
import { sameName } from '../shared/validation';
import { finishRestore, type RestoreJournal } from './restore';
import { writableDirectories } from './files';

interface Replacement { source: string; backup: string; target: string }
interface Journal { id: string; skills: StoredSkill[]; createdFolders: { path: string; dev?: number; ino?: number }[]; replacements: Replacement[]; links: { file: string; target: string }[]; catalogBefore: string; catalogAfter: string | null; committed: boolean }
interface DestinationJournal { kind: 'destinations'; id: string; skillId: string; links: { file: string; target: string }[]; removedLinks: { file: string; target: string; verifiedCanonical: string }[]; catalogBefore: string; catalogAfter: string | null; committed: boolean }
class SkillContentChanged extends Error { constructor() { super('Skill files changed.'); } }
export function createSkillsService(paths: RuntimePaths = resolvePaths()) {
  const previews = new Map<string, { preview: SetupPreview; replace: boolean; source?: SourceRecord }>();
  const restorePreviews = new Map<string, { preview: RestorePreview; catalog: string }>();
  const rootTargets = new Map<string, string>();
  let queue: Promise<unknown> = Promise.resolve();
  function serial<T>(work: () => Promise<T>): Promise<T> { const next = queue.then(work); queue = next.catch(() => undefined); return next; }
  async function checkRoots(roots = paths.destinations): Promise<void> {
    const store = await exists(paths.store) ? await fs.realpath(paths.store) : path.resolve(paths.store);
    for (const root of roots) {
      if (!await exists(root.path)) continue;
      const real = await fs.realpath(root.path); const previous = rootTargets.get(root.path);
      if (previous && previous !== real) throw new Error(`Skill root changed: ${root.path}`);
      if (inside(store, real)) throw new Error(`Skill root overlaps the catalog: ${root.path}`);
      rootTargets.set(root.path, real);
    }
  }
  function inConfiguredRoot(file: string): boolean {
    const resolved = path.resolve(file);
    return paths.destinations.some((root) => inside(root.path, resolved));
  }
  async function owned(file: string, target: string): Promise<boolean> {
    if (!await exists(file) || !(await fs.lstat(file)).isSymbolicLink()) return false;
    const lexical = path.resolve(path.dirname(file), await fs.readlink(file));
    if (lexical === path.resolve(target)) return true;
    const expected = await exists(target) ? await fs.realpath(target) : await physicalEntry(target);
    const actual = await fs.realpath(file).catch(error => {
      if (error instanceof Error && 'code' in error && ['ENOENT', 'ENOTDIR', 'ELOOP'].includes(String(error.code))) return null;
      throw error;
    });
    return actual !== null ? actual === expected : await physicalEntry(lexical).catch(() => null) === expected;
  }
  function destinationFiles(skill: Pick<StoredSkill, 'sources' | 'linkName'>, root: Destination): string[] {
    const files = new Set<string>();
    for (const source of skill.sources) if (source.replaced && !excludedLink(source.path)) {
      const originalRoot = paths.destinations.find(candidate => source.path !== candidate.path && inside(candidate.path, source.path));
      if (originalRoot && (originalRoot.path === root.path || rootTargets.has(root.path) && rootTargets.get(root.path) === rootTargets.get(originalRoot.path))) files.add(path.join(root.path, path.relative(originalRoot.path, source.path)));
    }
    return files.size ? [...files] : [path.join(root.path, skill.linkName)];
  }
  async function physicalEntry(file: string): Promise<string> {
    let parent = path.dirname(file);
    while (!await exists(parent)) { const next = path.dirname(parent); if (next === parent) throw new Error(`No existing parent: ${file}`); parent = next; }
    return path.join(await fs.realpath(parent), path.relative(parent, file));
  }
  async function canonical(skill: StoredSkill): Promise<void> {
    const target = path.resolve(skill.canonicalPath);
    if (!inside(paths.skills, target) || target === path.resolve(paths.skills) || !validName(skill.linkName)) throw new Error('Invalid managed skill path');
  }
  async function currentHash(skill: StoredSkill): Promise<string> {
    await canonical(skill);
    const stat = await fs.lstat(skill.canonicalPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Canonical skill folder is missing or changed');
    if (!(await fs.stat(path.join(skill.canonicalPath, 'SKILL.md'))).isFile()) throw new Error('SKILL.md is missing or changed');
    return treeHash(skill.canonicalPath);
  }
  async function verifyCanonical(skill: StoredSkill): Promise<void> {
    if (await currentHash(skill) !== skill.contentHash) throw new SkillContentChanged();
  }
  async function contentFailure(skill: StoredSkill, error: unknown): Promise<Pick<SkillSummary, 'contentState' | 'issues'>> {
    let missing = false;
    try { missing = !await exists(skill.canonicalPath); } catch { /* Unreadable paths are invalid, not missing. */ }
    return { contentState: missing ? 'missing' : error instanceof SkillContentChanged ? 'changed' : 'invalid', issues: [{ path: skill.canonicalPath, message: missing ? 'Skill folder is missing.' : String(error) }] };
  }
  async function link(file: string, target: string): Promise<void> {
    const roots = paths.destinations.filter(root => inside(root.path, file));
    if (!roots.length) throw new Error(`Unknown destination: ${file}`);
    await checkRoots(roots);
    if (roots.some(root => path.dirname(file) !== root.path)) await checkLinkParent(file);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await checkLinkParent(file);
    if (await exists(file)) { if (await owned(file, target)) return; throw new Error(`Destination is occupied: ${file}`); }
    await fs.symlink(target, file);
    if (!await owned(file, target)) throw new Error(`Link verification failed: ${file}`);
  }
  async function list(): Promise<SkillSummary[]> {
    for (const root of paths.destinations) await checkRoots([root]).catch(() => undefined);
    const items = await readCatalog(paths.catalog);
    const summaries: SkillSummary[] = [];
    for (const stored of items) { await canonical(stored); const skill: SkillSummary = { ...stored, contentState: 'ready', linkedDestinations: [], issues: [] };
      try { await verifyCanonical(skill); } catch (error) { Object.assign(skill, await contentFailure(skill, error)); }
      for (const id of skill.destinations) { const dest = paths.destinations.find(d => d.id === id); if (!skill.issues.length && dest && (await Promise.all(destinationFiles(skill, dest).map(file => owned(file, skill.canonicalPath)))).every(Boolean)) skill.linkedDestinations.push(id); }
      if (!skill.enabled && skill.contentState === 'ready') {
        try {
          const active = await ownedLinks(skill);
          skill.linkedDestinations = paths.destinations.filter(root => active.some(entry => inside(root.path, entry.file))).map(root => root.id);
          for (const entry of active) skill.issues.push({ path: entry.file, message: 'Disabled skill has an active link.' });
        } catch (error) { skill.issues.push({ path: skill.canonicalPath, message: String(error) }); }
      }
      if (!skill.issues.length && skill.enabled && skill.linkedDestinations.length < skill.destinations.length) skill.issues.push({ path: skill.canonicalPath, message: 'Some links are missing.' });
      summaries.push(skill);
    }
    return summaries;
  }
  function excludedLink(file: string): boolean {
    const root = paths.destinations.find(candidate => inside(candidate.path, file));
    if (!root) return true;
    const parts = path.relative(root.path, file).split(path.sep);
    return parts.some(part => part.startsWith('.') || part === 'plugins' || part === 'node_modules')
      || inside(path.join(paths.home, '.claude/skills/synced'), file);
  }
  async function checkLinkParent(file: string): Promise<void> {
    const root = paths.destinations.find(candidate => file !== candidate.path && inside(candidate.path, file));
    if (!root || excludedLink(file)) throw new Error(`Unknown destination: ${file}`);
    await checkRoots([root]);
    const realRoot = await exists(root.path) ? await fs.realpath(root.path) : await physicalEntry(root.path);
    const parent = path.dirname(file);
    const realParent = await exists(parent) ? await fs.realpath(parent) : await physicalEntry(parent);
    const parentParts = path.relative(realRoot, realParent).split(path.sep);
    if (!inside(realRoot, realParent) || parentParts.some(part => part.startsWith('.') || part === 'plugins' || part === 'node_modules') || (root.id === 'claude' && parentParts[0] === 'synced')) throw new Error(`Link parent leaves its personal skill root: ${file}`);
    for (let folder = realParent; folder !== realRoot; folder = path.dirname(folder)) {
      if (await exists(path.join(folder, 'SKILL.md'))) throw new Error(`Location is inside another skill: ${file}`);
    }
  }
  async function ownedLinks(skill: StoredSkill, roots = paths.destinations): Promise<{ file: string; target: string }[]> {
    await checkRoots(roots);
    const candidates = new Set(skill.sources.map(s => path.resolve(s.path)).filter(file => roots.some(root => inside(root.path, file)) && !excludedLink(file)));
    for (const root of roots) {
      if (!await exists(root.path)) continue;
      async function walk(folder: string): Promise<void> {
        if (folder !== root.path && await exists(path.join(folder, 'SKILL.md'))) return;
        for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
          const file = path.join(folder, entry.name);
          if (excludedLink(file)) continue;
          if (entry.isSymbolicLink()) candidates.add(file);
          else if (entry.isDirectory()) await walk(file);
        }
      }
      await walk(root.path);
    }
    const links: { file: string; target: string }[] = [];
    for (const file of candidates) if (await owned(file, skill.canonicalPath)) {
      await checkLinkParent(file);
      links.push({ file, target: await fs.readlink(file) });
    }
    return links;
  }
  async function removeLinks(skill: StoredSkill): Promise<void> {
    for (const entry of await ownedLinks(skill)) {
      await checkLinkParent(entry.file);
      if (!await exists(entry.file)) continue;
      if (!(await fs.lstat(entry.file)).isSymbolicLink() || await fs.readlink(entry.file) !== entry.target) throw new Error(`Link changed: ${entry.file}`);
      await fs.unlink(entry.file);
    }
  }
  async function supportingLinks(skill: StoredSkill): Promise<{ file: string }[]> {
    const found: { file: string }[] = [];
    const visited = new Set<string>();
    const counts = new Map<string, number>();
    const lexicalCanonical = path.resolve(skill.canonicalPath);
    const realCanonical = await exists(lexicalCanonical) ? await fs.realpath(lexicalCanonical) : await physicalEntry(lexicalCanonical);
    const storedRoots = new Set<string>();
    for (const other of await readCatalog(paths.catalog)) {
      await canonical(other);
      if (await exists(other.canonicalPath)) storedRoots.add(await fs.realpath(other.canonicalPath));
    }
    await checkRoots();
    for (const root of paths.destinations) {
      if (!await exists(root.path)) continue;
      async function walk(folder: string, inSkill: boolean, tree?: string): Promise<void> {
        const wasInSkill = inSkill;
        inSkill ||= folder !== root.path && await exists(path.join(folder, 'SKILL.md'));
        const real = await fs.realpath(folder);
        if (inside(realCanonical, real)) return;
        if (inSkill && (!wasInSkill || !tree)) tree = real;
        const key = `${inSkill}:${real}`;
        if (visited.has(key)) return;
        visited.add(key);
        if (storedRoots.has(real) && !inside(real, realCanonical)) {
          try { await treeHash(real); return; } catch { /* Inspect edited or unsafe trees for dependencies. */ }
        }
        const origin = tree ?? root.path, count = (counts.get(origin) ?? 0) + 1;
        if (count > 10000) throw new Error(`Supporting folder scan is too large for ${origin}. Review its supporting links.`);
        counts.set(origin, count);
        for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
          const file = path.join(folder, entry.name);
          if (!inSkill && excludedLink(file)) continue;
          if (entry.isDirectory()) await walk(file, inSkill, tree);
          else if (entry.isSymbolicLink()) {
            const target = path.resolve(path.dirname(file), await fs.readlink(file));
            const resolved = await fs.realpath(file).catch(error => {
              if (error instanceof Error && 'code' in error && ['ENOENT', 'ENOTDIR', 'ELOOP'].includes(String(error.code))) return null;
              throw error;
            });
            if (inSkill && (inside(lexicalCanonical, target) || inside(realCanonical, target) || resolved && inside(realCanonical, resolved))) found.push({ file });
            else if (!inSkill && resolved && resolved !== realCanonical && inside(realCanonical, resolved)) found.push({ file });
            else if (resolved && (await fs.stat(file)).isDirectory()) {
              if (inSkill) await walk(file, true, tree);
              else if (await exists(path.join(file, 'SKILL.md'))) await walk(file, true);
            }
          }
        }
      }
      await walk(root.path, false);
    }
    return found;
  }
  async function remainingRestoreLinks(skill: StoredSkill): Promise<{ file: string }[]> {
    return [...await ownedLinks(skill), ...await supportingLinks(skill)];
  }
  async function recoverDestinationLinks(journal: DestinationJournal, committed: boolean): Promise<void> {
    if (committed) return;
    const before: StoredSkill[] = JSON.parse(journal.catalogBefore);
    const skill = before.find(item => item.id === journal.skillId);
    if (!skill) throw new Error('Invalid destination owner');
    await canonical(skill);
    for (const entry of [...journal.links].reverse()) {
      if (!inConfiguredRoot(entry.file) || entry.target !== skill.canonicalPath) throw new Error('Invalid destination operation');
      if (await owned(entry.file, entry.target)) { await checkLinkParent(entry.file); await fs.unlink(entry.file); }
    }
    for (const entry of [...journal.removedLinks].reverse()) {
      if (!inConfiguredRoot(entry.file) || entry.verifiedCanonical !== skill.canonicalPath || typeof entry.target !== 'string') throw new Error('Invalid destination operation');
      await checkLinkParent(entry.file);
      if (await exists(entry.file)) {
        if (!(await fs.lstat(entry.file)).isSymbolicLink() || await fs.readlink(entry.file) !== entry.target) throw new Error(`Recovery destination is occupied: ${entry.file}`);
      } else await fs.symlink(entry.target, entry.file);
    }
  }
  async function setDestinations(id: string, destinationIds: string[]): Promise<OperationResult> {
    return serial(async () => {
      const ids = [...new Set(destinationIds)];
      if (ids.some(destination => !paths.destinations.some(root => root.id === destination && root.writable))) throw new Error('Invalid destination');
      await recover();
      const items = await readCatalog(paths.catalog);
      const skill = items.find(item => item.id === id);
      if (!skill) throw new Error('Skill not found');
      await canonical(skill);
      const journal: DestinationJournal = { kind: 'destinations', id: randomUUID(), skillId: skill.id, links: [], removedLinks: [], catalogBefore: JSON.stringify(items), catalogAfter: null, committed: false };
      const record = path.join(paths.operations, `${journal.id}.json`);
      const issues: Issue[] = [];
      try {
        await checkRoots();
        const chosen = paths.destinations.filter(root => ids.includes(root.id));
        if (skill.enabled && ids.length) await verifyCanonical(skill);
        for (const root of chosen) for (const file of destinationFiles(skill, root)) {
          await checkLinkParent(file);
          if (await exists(file) && !await owned(file, skill.canonicalPath)) throw new Error(`Destination is occupied: ${file}`);
        }
        const retained = new Set(await Promise.all(chosen.flatMap(root => destinationFiles(skill, root)).map(physicalEntry)));
        const removed = [];
        for (const entry of await ownedLinks(skill)) if (!skill.enabled || !retained.has(await physicalEntry(entry.file))) removed.push(entry);
        await atomicJson(record, journal);
        if (skill.enabled) for (const root of chosen) for (const file of destinationFiles(skill, root)) {
          if (await exists(file) && await owned(file, skill.canonicalPath) && path.resolve(path.dirname(file), await fs.readlink(file)) !== skill.canonicalPath) {
            journal.removedLinks.push({ file, target: await fs.readlink(file), verifiedCanonical: skill.canonicalPath });
            await atomicJson(record, journal);
            await fs.unlink(file);
          }
          if (!await exists(file)) {
            journal.links.push({ file, target: skill.canonicalPath });
            await atomicJson(record, journal);
            await link(file, skill.canonicalPath);
          } else if (!await owned(file, skill.canonicalPath)) throw new Error(`Destination is occupied: ${file}`);
        }
        for (const entry of removed) {
          await checkLinkParent(entry.file);
          if (!await exists(entry.file)) continue;
          if (!(await fs.lstat(entry.file)).isSymbolicLink() || await fs.readlink(entry.file) !== entry.target) throw new Error(`Link changed: ${entry.file}`);
          journal.removedLinks.push({ ...entry, verifiedCanonical: skill.canonicalPath });
          await atomicJson(record, journal);
          await fs.unlink(entry.file);
        }
        skill.destinations = ids;
        if (!ids.length) skill.enabled = false;
        journal.catalogAfter = JSON.stringify(items);
        await atomicJson(record, journal);
        await atomicJson(paths.catalog, items);
        journal.committed = true;
        await atomicJson(record, journal);
        await fs.unlink(record);
      } catch (error) {
        issues.push({ path: skill.canonicalPath, message: String(error) });
        if (await exists(record)) try { await recover(); } catch (recoveryError) { issues.push({ path: record, message: String(recoveryError) }); }
      }
      return { ok: issues.length === 0, issues, skills: await list() };
    });
  }
  async function change(id: string, action: Exclude<BulkAction, 'keep'>, summaries = true): Promise<OperationResult> {
    return serial(async () => {
      await recover();
      const items = await readCatalog(paths.catalog); const skill = items.find(s => s.id === id); if (!skill) throw new Error('Skill not found'); await canonical(skill);
      const issues: Issue[] = [];
      if (action === 'enable') {
        if (!skill.destinations.length) return { ok: false, issues: [{ path: skill.canonicalPath, message: 'Choose a location first.' }], skills: summaries ? await list() : [] };
        try { await verifyCanonical(skill); } catch (error) { return { ok: false, issues: (await contentFailure(skill, error)).issues, skills: summaries ? await list() : [] }; }
        skill.enabled = true;
        for (const destination of skill.destinations) { const root = paths.destinations.find(d => d.id === destination); try { if (!root?.writable) throw new Error('Unknown destination'); for (const file of destinationFiles(skill, root)) await link(file, skill.canonicalPath); } catch (error) { issues.push({ path: root?.path ?? destination, message: String(error) }); } }
      } else {
        try { const dependency = action === 'delete' ? (await supportingLinks(skill))[0] : undefined; if (dependency) throw new Error(`Copy or remove the supporting link before deleting: ${dependency.file}`); await removeLinks(skill); skill.enabled = false; if (action === 'delete') { if (await exists(skill.canonicalPath)) await writableDirectories(skill.canonicalPath); await fs.rm(skill.canonicalPath, { recursive: true, force: true }); items.splice(items.indexOf(skill), 1); } } catch (error) { issues.push({ path: skill.canonicalPath, message: String(error) }); }
      }
      await atomicJson(paths.catalog, items); return { ok: issues.length === 0, issues, skills: summaries ? await list() : [] };
    });
  }
  async function removeMissing(id: string): Promise<OperationResult> {
    return serial(async () => {
      await recover();
      const items = await readCatalog(paths.catalog);
      const skill = items.find(item => item.id === id);
      if (!skill) throw new Error('Skill not found');
      await canonical(skill);
      const issues: Issue[] = [];
      try {
        if (await exists(skill.canonicalPath)) throw new Error('Skill folder exists. Scan again.');
        await removeLinks(skill);
        if (await exists(skill.canonicalPath)) throw new Error('Skill folder exists. Scan again.');
        await atomicJson(paths.catalog, items.filter(item => item.id !== id));
      } catch (error) { issues.push({ path: skill.canonicalPath, message: String(error) }); }
      return { ok: issues.length === 0, issues, skills: await list() };
    });
  }
  async function acceptChanges(id: string, summaries = true): Promise<OperationResult> {
    return serial(async () => {
      await recover(true);
      const items = await readCatalog(paths.catalog);
      const skill = items.find(item => item.id === id);
      if (!skill) throw new Error('Skill not found');
      const hash = await currentHash(skill);
      const markdown = await fs.readFile(path.join(skill.canonicalPath, 'SKILL.md'), 'utf8');
      const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
      const metadata: unknown = match ? parse(match[1] ?? '') ?? {} : {};
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('Skill metadata must be a map.');
      const name = 'name' in metadata ? metadata.name : skill.name;
      if (typeof name !== 'string' || !name.trim() || items.some(item => item.id !== id && sameName(item.name, name))) throw new Error('Choose a valid, unique skill name in SKILL.md.');
      if ('description' in metadata && typeof metadata.description !== 'string') throw new Error('Skill description must be text.');
      if (await currentHash(skill) !== hash) throw new Error('Skill files changed again. Try once more.');
      skill.name = name;
      skill.description = 'description' in metadata ? metadata.description as string : '';
      skill.contentHash = hash;
      await atomicJson(paths.catalog, items);
      await recover(true);
      return { ok: true, issues: [], skills: summaries ? await list() : [] };
    });
  }
  function skillsForLink(file: string, skills: StoredSkill[]): StoredSkill[] {
    return skills.filter(skill => skill.sources.some(source => path.resolve(source.path) === file)
      || skill.destinations.some(id => {
        const root = paths.destinations.find(destination => destination.id === id);
        return root && destinationFiles(skill, root).includes(file);
      }));
  }
  async function fixBrokenLinks(previewId: string): Promise<OperationResult> {
    return serial(async () => {
      const saved = previews.get(previewId);
      if (!saved?.replace) throw new Error('Setup preview expired. Scan again.');
      await recover();
      const skills = await readCatalog(paths.catalog);
      const issues: Issue[] = [];
      for (const candidate of saved.preview.brokenLinks) {
        try {
          const root = paths.destinations.find(destination => path.dirname(candidate.path) === destination.path);
          if (!root) throw new Error('Link is outside a skill root.');
          let skill: StoredSkill | undefined;
          if (candidate.kind === 'restore') {
            const matches = skillsForLink(candidate.path, skills);
            skill = matches.length === 1 ? matches[0] : undefined;
            if (!skill || skill.id !== candidate.skillId || !skill.enabled) throw new Error('Managed skill changed. Scan again.');
            await verifyCanonical(skill);
          }
          await checkRoots([root]);
          const realRoot = await fs.realpath(root.path);
          if (!inside(realRoot, await fs.realpath(path.dirname(candidate.path)))) throw new Error('Link parent changed.');
          if (!await exists(candidate.path)) continue;
          if (!(await fs.lstat(candidate.path)).isSymbolicLink()) throw new Error('Link changed since the scan.');
          const target = await fs.readlink(candidate.path);
          if (skill && path.resolve(path.dirname(candidate.path), target) === skill.canonicalPath) continue;
          if (target !== candidate.target) throw new Error('Link changed since the scan.');
          let broken = false;
          try { await fs.realpath(candidate.path); }
          catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') broken = true; else throw error; }
          if (!broken) throw new Error('Link is no longer broken. Scan again.');
          await fs.unlink(candidate.path);
          if (skill) {
            try {
              await fs.symlink(skill.canonicalPath, candidate.path);
              if (await fs.realpath(candidate.path) !== await fs.realpath(skill.canonicalPath)) throw new Error('Link verification failed.');
            } catch (error) {
              try {
                if (await owned(candidate.path, skill.canonicalPath)) await fs.unlink(candidate.path);
                if (!await exists(candidate.path)) await fs.symlink(candidate.target, candidate.path);
              } catch (restoreError) { throw new Error(`${String(error)} Original link could not be restored: ${String(restoreError)}`); }
              throw error;
            }
          }
        } catch (error) { issues.push({ path: candidate.path, message: String(error) }); }
      }
      return { ok: issues.length === 0, issues, skills: await list() };
    });
  }
  async function preview(folder?: string, source?: SourceRecord, signal?: AbortSignal, origins?: Record<string, ImportOrigin>): Promise<SetupPreview> {
    const rootIssues: Issue[] = [];
    for (const root of paths.destinations) {
      try { await checkRoots([root]); } catch (error) { rootIssues.push({ path: root.path, message: String(error) }); }
    }
    const scanned = await scanRoots(paths, folder ? [{ id: 'local', name: 'Local', path: path.resolve(folder), writable: true, availableTo: [] }] : undefined, folder ? 'repository' : 'personal', signal);
    if (folder) for (const item of scanned.skills) {
      const original = origins?.[item.realPath];
      if (original) { item.name = original.name; item.sourcePath = original.path; }
      item.linkName = skillFolderName(item.name);
    }
    scanned.issues.push(...rootIssues);
    const catalog = await readCatalog(paths.catalog);
    const brokenLinks: BrokenLink[] = [];
    if (!folder) for (const issue of scanned.issues) {
      if (issue.message !== 'Broken link.' || !paths.destinations.some(root => path.dirname(issue.path) === root.path)) continue;
      try {
        const target = await fs.readlink(issue.path);
        const matches = skillsForLink(issue.path, catalog);
        const skill = matches.length === 1 ? matches[0] : undefined;
        let candidate: BrokenLink = { path: issue.path, target, kind: 'remove' };
        if (skill?.enabled) {
          try { await verifyCanonical(skill); candidate = { path: issue.path, target, kind: 'restore', skillId: skill.id }; }
          catch { /* Keep missing or changed canonical content visible in the catalog. */ }
        }
        brokenLinks.push(candidate);
      } catch { /* A changed entry must be scanned again before repair. */ }
    }
    if (folder) for (const item of scanned.skills) {
      if (item.external || item.issues.length) continue;
      try {
        const markdown = await fs.readFile(path.join(item.realPath, 'SKILL.md'), 'utf8');
        item.preview = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim().slice(0, 500);
      } catch { /* scan issues already describe unreadable skills */ }
    }
    const identical = new Map<string, typeof scanned.skills>();
    for (const item of scanned.skills.filter(item => !item.external && !item.issues.length)) {
      const group = identical.get(item.contentHash) ?? []; group.push(item); identical.set(item.contentHash, group);
    }
    for (const group of identical.values()) {
      const name = catalog.find(skill => skill.contentHash === group[0].contentHash)?.name ?? [...group].sort((a, b) => a.path.localeCompare(b.path))[0].name;
      for (const item of group) item.name = name;
    }
    const names = new Map<string, typeof scanned.skills>();
    for (const item of scanned.skills) { const group = names.get(item.name) ?? []; group.push(item); names.set(item.name, group); }
    const duplicateGroups: { name: string; skillIds: string[] }[] = [];
    for (const [name, items] of names) {
      const byHash = new Map<string, typeof items>();
      for (const item of items) {
        if (item.external || item.issues.length) continue;
        const group = byHash.get(item.contentHash) ?? [];
        group.push(item);
        byHash.set(item.contentHash, group);
      }
      for (const group of byHash.values()) {
        if (group.length > 1) duplicateGroups.push({ name, skillIds: group.map((item) => item.id) });
      }
    }
    const conflictGroups: SetupPreview['conflicts'] = [];
    const candidates = scanned.skills.filter((item) => !item.external);
    const managed = catalog.filter((entry) => candidates.some(item => (sameName(item.name, entry.name) || sameName(item.linkName, entry.linkName)) && item.contentHash !== entry.contentHash));
    const edges = candidates.map(() => new Set<number>());
    const reasons = new Map<string, Set<'display-name' | 'link-name'>>();
    for (let i = 0; i < candidates.length; i++) for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i], b = candidates[j]; if (a.contentHash === b.contentHash) continue;
      const why = new Set<'display-name' | 'link-name'>(); if (sameName(a.name, b.name)) why.add('display-name'); if (sameName(a.linkName, b.linkName)) why.add('link-name');
      if (why.size) { edges[i].add(j); edges[j].add(i); reasons.set(`${i}:${j}`, why); }
    }
    const seenConflict = new Set<number>();
    for (let start = 0; start < candidates.length; start++) {
      if (seenConflict.has(start) || (!edges[start].size && !managed.some(m => sameName(m.name, candidates[start].name) || sameName(m.linkName, candidates[start].linkName)))) continue;
      const indexes = new Set<number>([start]); const queue = [start];
      while (queue.length) for (const next of edges[queue.shift()!] ?? []) if (!indexes.has(next)) { indexes.add(next); queue.push(next); }
      indexes.forEach(i => seenConflict.add(i));
      const ids = [...indexes].map(i => candidates[i].id); const why = new Set<'display-name' | 'link-name'>();
      for (const [key, value] of reasons) { const [a, b] = key.split(':').map(Number); if (indexes.has(a) && indexes.has(b)) value.forEach(v => why.add(v)); }
      const managedRefs = await Promise.all(managed.filter(m => ids.some(id => { const item = candidates.find(c => c.id === id)!; if (sameName(item.name, m.name)) why.add('display-name'); if (sameName(item.linkName, m.linkName)) why.add('link-name'); return sameName(item.name, m.name) || sameName(item.linkName, m.linkName); })).map(async m => {
        let preview: string | undefined;
        if (folder) try { await verifyCanonical(m); const markdown = await fs.readFile(path.join(m.canonicalPath, 'SKILL.md'), 'utf8'); preview = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim().slice(0, 500); } catch { /* catalog issue is reported elsewhere */ }
        return { name: m.name, linkName: m.linkName, path: m.canonicalPath, description: m.description, contentHash: m.contentHash, preview };
      }));
      conflictGroups.push({ name: candidates[start].name, skillIds: ids, reasons: [...why], managed: managedRefs });
    }
    const result: SetupPreview = {
      ...scanned,
      kind: 'setup',
      storePath: paths.skills,
      existing: catalog.map(({ name, linkName, canonicalPath, contentHash, destinations, sources, enabled }) => ({ name, linkName, canonicalPath, contentHash, destinations, sources, enabled })),
      previewId: randomUUID(),
      duplicates: duplicateGroups,
      conflicts: conflictGroups,
      brokenLinks,
    };
    previews.set(result.previewId, { preview: result, replace: !folder, source }); return result;
  }
  async function adoptExistingStore(): Promise<void> {
    if (await exists(paths.catalog) || !await exists(paths.skills)) return;
    const skills: StoredSkill[] = [];
    const destinationsByTarget = new Map<string, string[]>();
    for (const root of paths.destinations) {
      if (!await exists(root.path)) continue;
      for (const entry of await fs.readdir(root.path, { withFileTypes: true })) {
        if (!entry.isSymbolicLink()) continue;
        const link = path.join(root.path, entry.name);
        try {
          const target = path.resolve(await fs.realpath(link));
          const ids = destinationsByTarget.get(target) ?? [];
          ids.push(root.id);
          destinationsByTarget.set(target, ids);
        } catch { /* Broken links are reported by the normal scan. */ }
      }
    }
    for (const entry of await fs.readdir(paths.skills, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const canonicalPath = path.join(paths.skills, entry.name);
      if (!await exists(path.join(canonicalPath, 'SKILL.md'))) continue;
      try {
        const markdown = await fs.readFile(path.join(canonicalPath, 'SKILL.md'), 'utf8');
        const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
        const metadata: unknown = match ? parse(match[1] ?? '') : {};
        const name = metadata && typeof metadata === 'object' && 'name' in metadata && typeof metadata.name === 'string'
          ? metadata.name
          : entry.name;
        const description = metadata && typeof metadata === 'object' && 'description' in metadata && typeof metadata.description === 'string'
          ? metadata.description
          : '';
        const id = createHash('sha256').update(canonicalPath).digest('hex').slice(0, 20);
        skills.push({
          id,
          name,
          description,
          linkName: entry.name,
          canonicalPath,
          contentHash: await treeHash(canonicalPath),
          sources: [],
          enabled: true,
          destinations: [...new Set(destinationsByTarget.get(path.resolve(canonicalPath)) ?? [])],
          linkedDestinations: [],
          issues: [],
        });
      } catch { /* Leave invalid store entries for a later manual repair. */ }
    }
    await atomicJson(paths.catalog, skills);
  }
  async function recover(allowReview = false): Promise<void> {
    await finishRestore(paths, checkLinkParent, remainingRestoreLinks);
    if (await exists(paths.operations)) {
      for (const name of await fs.readdir(paths.operations)) {
        if (!name.endsWith('.json')) continue;
        const file = path.join(paths.operations, name); const journal: Journal | DestinationJournal = JSON.parse(await fs.readFile(file, 'utf8'));
        if (journal.id + '.json' !== name) throw new Error('Invalid operation record');
        const catalog = await readCatalog(paths.catalog);
        const committed = journal.committed || (journal.catalogAfter !== null && journal.catalogAfter !== journal.catalogBefore && JSON.stringify(catalog) === journal.catalogAfter);
        if ('kind' in journal) {
          if (journal.kind !== 'destinations') throw new Error('Invalid operation kind');
          await recoverDestinationLinks(journal, committed);
          await fs.unlink(file);
          continue;
        }
        if (committed) {
          if (!journal.committed) { journal.committed = true; await atomicJson(file, journal); }
          let needsReview = false;
          for (const replacement of journal.replacements) {
            const skill = catalog.find(s => s.canonicalPath === replacement.target);
            if (!skill) throw new Error('Recovery target is not in the catalog');
            try { await verifyCanonical(skill); }
            catch (error) {
              if (error instanceof SkillContentChanged) {
                if (allowReview) needsReview = true;
                else throw new Error(`Review ${skill.name} with Keep current files before continuing.`);
              } else throw error;
            }
          }
          if (needsReview) continue;
        }
        if (!committed) for (const entry of [...journal.links].reverse()) {
          if (!inConfiguredRoot(entry.file) || !inside(paths.skills, entry.target)) throw new Error('Invalid recovery link');
          if (await owned(entry.file, entry.target)) await fs.unlink(entry.file);
        }
        for (const replacement of [...journal.replacements].reverse()) {
          const index = journal.replacements.indexOf(replacement);
          if (replacement.backup !== path.join(path.dirname(replacement.source), `.skills-manager-${journal.id}-${index}.backup`) || !inside(paths.skills, replacement.target)) throw new Error('Invalid recovery path');
          if (committed) { if (await exists(replacement.backup)) { if ((await fs.lstat(replacement.backup)).isDirectory()) await writableDirectories(replacement.backup); await fs.rm(replacement.backup, { recursive: true }); } }
          else if (await exists(replacement.backup)) { if (await owned(replacement.source, replacement.target)) await fs.unlink(replacement.source); if (await exists(replacement.source)) throw new Error(`Recovery destination is occupied: ${replacement.source}`); await fs.rename(replacement.backup, replacement.source); }
        }
        if (!committed) {
          for (const skill of journal.skills) { await canonical(skill); const staged = path.join(paths.staging, skill.id); if (await exists(staged) && (await fs.lstat(staged)).isDirectory()) await writableDirectories(staged); await fs.rm(staged, { recursive: true, force: true }); }
          for (const folder of journal.createdFolders) {
            if (!journal.skills.some(skill => skill.canonicalPath === folder.path)) throw new Error('Invalid recovery folder');
            if (!await exists(folder.path)) continue;
            const stat = await fs.lstat(folder.path);
            if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Skill folder changed: ${folder.path}`);
            if (folder.dev === undefined && folder.ino === undefined) {
              if ((await fs.readdir(folder.path)).length) throw new Error(`Pending skill folder is occupied: ${folder.path}`);
              await fs.rmdir(folder.path);
            } else {
              if (stat.dev !== folder.dev || stat.ino !== folder.ino) throw new Error(`Skill folder changed: ${folder.path}`);
              await writableDirectories(folder.path);
              await fs.rm(folder.path, { recursive: true });
            }
          }
        }
        await fs.unlink(file);
      }
    }
    await adoptExistingStore();
  }
  async function apply(request: SetupApply | ImportApply): Promise<OperationResult> {
    return serial(async () => {
      await recover(); const saved = previews.get(request.previewId); if (!saved) throw new Error('Preview expired. Scan again.');
      const selected = saved.preview.skills.filter(s => request.skillIds.includes(s.id));
      if (!selected.length) throw new Error('Select a skill');
      if (!saved.replace && !request.destinations.length) throw new Error('Choose a destination.');
      if (request.destinations.some(id => !paths.destinations.some(root => root.id === id && root.writable))) throw new Error('Invalid destination');
      const requestedNames = new Map(request.names?.map(entry => [entry.skillId, entry.name]) ?? []);
      if (requestedNames.size !== (request.names?.length ?? 0) || [...requestedNames.keys()].some(id => !request.skillIds.includes(id)) || [...requestedNames.values()].some(name => !validName(name))) throw new Error('Invalid skill names');
      const finalNames = selected.map(item => ({ item, name: requestedNames.get(item.id) ?? item.name, linkName: requestedNames.get(item.id) ?? item.linkName }));
      const byHash = new Map<string, typeof finalNames>();
      for (const entry of finalNames) {
        const entries = byHash.get(entry.item.contentHash) ?? [];
        entries.push(entry);
        byHash.set(entry.item.contentHash, entries);
      }
      for (const entries of byHash.values()) {
        const explicitLinks = entries.filter(entry => requestedNames.has(entry.item.id)).map(entry => entry.linkName);
        if (new Set(explicitLinks).size > 1) throw new Error(`Identical copies of ${entries[0].item.name} must use one name.`);
        const name = explicitLinks[0] ?? entries[0].name;
        const linkName = explicitLinks[0] ?? [...entries].sort((a, b) => a.item.path.localeCompare(b.item.path))[0].linkName;
        for (const entry of entries) { entry.name = name; entry.linkName = linkName; }
      }
      const effectiveNames = [...byHash.values()].map(entries => entries[0]);
      if (new Set(effectiveNames.map(entry => entry.name.toLowerCase())).size !== effectiveNames.length || new Set(effectiveNames.map(entry => entry.linkName.toLowerCase())).size !== effectiveNames.length) throw new Error('Skill names must be unique');
      for (const item of selected) if (item.external || item.issues.length) throw new Error(`Resolve skill issues first: ${item.path}`);
      for (const conflict of saved.preview.conflicts) {
        const hashes = new Set(
          saved.preview.skills
            .filter((item) => conflict.skillIds.includes(item.id) && request.skillIds.includes(item.id))
            .map((item) => item.contentHash),
        );
        if (hashes.size > 1 && !selected.some(item => requestedNames.has(item.id))) throw new Error(`Choose one copy of ${conflict.name}`);
      }
      const catalog = await readCatalog(paths.catalog); const journal: Journal = { id: randomUUID(), skills: [], createdFolders: [], replacements: [], links: [], catalogBefore: JSON.stringify(catalog), catalogAfter: null, committed: false };
      // Resolve the entire link plan before reserving or replacing any files.
      const plannedLinks = new Map<string, string>();
      const requiredRoots = paths.destinations.filter(root => request.destinations.includes(root.id) || selected.some(item => item.destinations.includes(root.id)));
      await checkRoots(requiredRoots);
      for (const entries of byHash.values()) {
        const first = entries[0];
        const existing = catalog.find(skill => skill.contentHash === first.item.contentHash && skill.name === first.name && (!requestedNames.has(first.item.id) || skill.linkName === first.linkName));
        if (existing && !existing.enabled) continue;
        const sources = [...existing?.sources ?? [], ...(saved.replace ? entries.flatMap(({ item }) => [item.path, ...item.aliases].map(file => ({ path: file, replaced: true }))) : [])];
        const planned = { linkName: existing?.linkName ?? first.linkName, sources };
        const ids = new Set([...existing?.destinations ?? [], ...(saved.replace ? entries.flatMap(({ item }) => item.destinations) : []), ...request.destinations]);
        for (const root of paths.destinations.filter(root => ids.has(root.id))) for (const file of destinationFiles(planned, root)) {
          const key = await physicalEntry(file);
          const owner = plannedLinks.get(key);
          if (owner && owner !== first.item.contentHash) throw new Error(`Two selected skills use ${file}. Clear ${root.name} in Add destinations or choose one copy.`);
          plannedLinks.set(key, first.item.contentHash);
        }
      }
      const copiesBySourceHash = new Map<string, StoredSkill>();
      const touched = new Map<string, StoredSkill>();
      for (const { linkName } of finalNames) if (!validName(linkName)) throw new Error(`Invalid link name: ${linkName}`);
      const record = path.join(paths.operations, journal.id + '.json');
      await fs.mkdir(paths.skills, { recursive: true }); await fs.mkdir(paths.staging, { recursive: true });
      const issues: Issue[] = [];
      try {
        for (const item of selected) {
          if (await treeHash(item.realPath) !== item.contentHash) throw new Error(`Source changed: ${item.path}`);
          const final = finalNames.find(entry => entry.item.id === item.id)!;
          let skill = copiesBySourceHash.get(item.contentHash);
          if (!skill) {
            const existing = catalog.find(s => s.contentHash === item.contentHash);
            if (existing) {
              await verifyCanonical(existing);
              if (existing.name === final.name && (!requestedNames.has(item.id) || existing.linkName === final.linkName)) skill = existing;
            }
          }
          if (!skill) {
            if (catalog.some(s => (sameName(s.name, final.name) || sameName(s.linkName, final.linkName)) && s.contentHash !== item.contentHash)) throw new Error(`Skill already exists: ${final.name}`);
            const id = randomUUID(); const target = path.join(paths.skills, final.linkName); const staged = path.join(paths.staging, id);
            if (await exists(target)) throw new Error(`Skill folder is occupied: ${target}`);
            skill = { id, name: final.name, description: item.description, linkName: final.linkName, canonicalPath: target, contentHash: item.contentHash, sources: [], enabled: true, destinations: [], linkedDestinations: [], issues: [] };
            journal.skills.push(skill);
            await atomicJson(record, journal);
            await fs.cp(item.realPath, staged, { recursive: true, dereference: false, verbatimSymlinks: true, preserveTimestamps: true });
            if (await treeHash(staged) !== item.contentHash) { await fs.rm(staged, { recursive: true, force: true }); throw new Error(`Copy verification failed: ${item.path}`); }
            if (final.name !== item.name) {
              const file = path.join(staged, 'SKILL.md'); const markdown = await fs.readFile(file, 'utf8');
              const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
              const document = parseDocument(match?.[1] ?? '');
              if (document.errors.length || (document.contents !== null && !isMap(document.contents))) throw new Error(`Could not update skill name: ${item.path}`);
              document.set('name', final.name);
              const rewritten = `---\n${document.toString()}---\n${match ? markdown.slice(match[0].length) : markdown}`;
              const fileMode = (await fs.stat(file)).mode & 0o777;
              await fs.chmod(file, fileMode | 0o200);
              try { await fs.writeFile(file, rewritten); }
              finally { await fs.chmod(file, fileMode); }
            }
            skill.contentHash = await treeHash(staged);
            const mode = (await fs.stat(staged)).mode & 0o777;
            const reservation: Journal['createdFolders'][number] = { path: target };
            journal.createdFolders.push(reservation);
            await atomicJson(record, journal);
            try { await fs.mkdir(target, { mode }); }
            catch (error) {
              journal.createdFolders.splice(journal.createdFolders.indexOf(reservation), 1);
              await atomicJson(record, journal);
              throw error;
            }
            const reserved = await fs.lstat(target);
            Object.assign(reservation, { dev: reserved.dev, ino: reserved.ino });
            await atomicJson(record, journal);
            await fs.chmod(target, mode | 0o700);
            for (const name of await fs.readdir(staged)) await fs.cp(path.join(staged, name), path.join(target, name), { recursive: true, dereference: false, verbatimSymlinks: true, preserveTimestamps: true, force: false, errorOnExist: true });
            await fs.chmod(target, mode);
            await writableDirectories(staged);
            await fs.rm(staged, { recursive: true });
          }
          copiesBySourceHash.set(item.contentHash, skill);
          touched.set(skill.id, skill);
          const sourceRecords: SourceRecord[] = saved.source
            ? [{ ...saved.source, path: item.sourcePath ?? saved.source.path }]
            : [{ path: item.path, replaced: saved.replace }, ...item.aliases.map((alias) => ({ path: alias, replaced: saved.replace }))];
          for (const source of sourceRecords) {
            const existing = skill.sources.find(existing => existing.path === source.path && existing.repository === source.repository && existing.revision === source.revision && existing.subpath === source.subpath);
            if (!existing) skill.sources.push(source);
            else if (source.replaced) existing.replaced = true;
          }
          skill.destinations = [...new Set([...skill.destinations, ...(saved.replace ? item.destinations : []), ...request.destinations])];
          if (saved.replace) {
            const sourcePaths = [...item.aliases, item.path];
            const sources = [];
            for (const sourcePath of sourcePaths) {
              await checkRoots(paths.destinations.filter(root => inside(root.path, sourcePath)));
              if (await fs.realpath(sourcePath) !== item.realPath || await treeHash(sourcePath) !== item.contentHash) throw new Error(`Source changed: ${sourcePath}`);
              const stat = await fs.lstat(sourcePath);
              sources.push({ sourcePath, dev: stat.dev, ino: stat.ino, link: stat.isSymbolicLink() ? await fs.readlink(sourcePath) : null });
            }
            for (const source of sources) {
              const { sourcePath } = source;
              await checkRoots(paths.destinations.filter(root => inside(root.path, sourcePath)));
              const stat = await fs.lstat(sourcePath);
              if (stat.dev !== source.dev || stat.ino !== source.ino || (source.link !== null ? !stat.isSymbolicLink() || await fs.readlink(sourcePath) !== source.link : stat.isSymbolicLink() || await treeHash(sourcePath) !== item.contentHash)) throw new Error(`Source changed: ${sourcePath}`);
              const replacement = { source: sourcePath, backup: path.join(path.dirname(sourcePath), `.skills-manager-${journal.id}-${journal.replacements.length}.backup`), target: skill.canonicalPath };
              journal.replacements.push(replacement); await atomicJson(record, journal);
              await fs.rename(replacement.source, replacement.backup);
              if (skill.enabled) await link(replacement.source, replacement.target);
            }
          }
        }
        await atomicJson(record, journal);
        for (const skill of touched.values()) for (const id of skill.destinations) {
          const root = paths.destinations.find(d => d.id === id && d.writable); if (!root) throw new Error(`Invalid destination: ${id}`);
          for (const file of destinationFiles(skill, root)) {
            if (await exists(file) && !await owned(file, skill.canonicalPath)) throw new Error(`Destination is occupied: ${file}`);
            if (!skill.enabled) continue;
            if (!await exists(file)) { journal.links.push({ file, target: skill.canonicalPath }); await atomicJson(record, journal); }
            await link(file, skill.canonicalPath);
          }
        }
        journal.catalogAfter = JSON.stringify([...catalog, ...journal.skills]);
        for (const skill of touched.values()) await verifyCanonical(skill);
        await atomicJson(record, journal);
        await atomicJson(paths.catalog, [...catalog, ...journal.skills]);
        journal.committed = true;
        await atomicJson(record, journal);
        await recover(); previews.delete(request.previewId);
      } catch (error) { issues.push({ path: paths.store, message: String(error) }); try { await recover(); } catch (recoveryError) { issues.push({ path: record, message: String(recoveryError) }); } }
      return { ok: issues.length === 0, issues, skills: await list() };
    });
  }
  async function bulk(action: BulkAction, ids: string[]): Promise<BulkResult> {
    if (!['enable', 'disable', 'delete', 'keep'].includes(action) || !ids.length || ids.length > 10000) throw new Error('Invalid bulk action.');
    const issues: Issue[] = [], failedIds: string[] = [];
    const labels = new Map((await readCatalog(paths.catalog)).map(skill => [skill.id, skill.name]));
    for (const id of new Set(ids)) {
      try {
        const result = action === 'keep' ? await acceptChanges(id, false) : await change(id, action, false);
        if (!result.ok) { failedIds.push(id); issues.push(...result.issues); }
      } catch (error) { failedIds.push(id); issues.push({ path: labels.get(id) ?? 'Selected skill', message: String(error) }); }
    }
    return { ok: !failedIds.length, issues, failedIds, skills: await list() };
  }
  async function restorePreview(): Promise<RestorePreview> {
    return serial(async () => {
      await recover(true);
      const catalog = await readCatalog(paths.catalog);
      const previewId = randomUUID();
      const result: RestorePreview = { previewId, backupPath: path.join(paths.home, `Skills Manager Export-${previewId}`), skills: [], issues: [] };
      for (const skill of catalog) {
        try {
          await verifyCanonical(skill);
          const supporting = await supportingLinks(skill);
          if (supporting.length) throw new Error(`Another skill uses this stored copy. Copy or remove its supporting link first: ${supporting[0].file}`);
          const locations = new Set((await ownedLinks(skill)).map(entry => entry.file));
          const preservedLocations: string[] = [], exportOnlyLocations: string[] = [];
          for (const source of skill.sources) if (source.replaced && inConfiguredRoot(source.path) && !excludedLink(source.path)) {
            const root = paths.destinations.find(root => inside(root.path, source.path))!;
            if (!await exists(root.path) || !await exists(path.dirname(source.path))) { exportOnlyLocations.push(source.path); continue; }
            if (await exists(source.path) && !await owned(source.path, skill.canonicalPath)) preservedLocations.push(source.path);
            else locations.add(path.resolve(source.path));
          }
          for (const file of locations) {
            await checkLinkParent(file);
            if (await exists(file) && !await owned(file, skill.canonicalPath)) throw new Error(`Restore location is occupied: ${file}`);
          }
          const uniqueLocations = new Map<string, string>();
          for (const file of locations) if (!uniqueLocations.has(await physicalEntry(file))) uniqueLocations.set(await physicalEntry(file), file);
          result.skills.push({ id: skill.id, name: skill.name, locations: [...uniqueLocations.values()], preservedLocations, exportOnlyLocations });
        } catch (error) { result.issues.push({ path: skill.canonicalPath, message: String(error) }); }
      }
      const claims = new Map<string, { skill: RestorePreview['skills'][number]; file: string }[]>();
      for (const skill of result.skills) for (const file of skill.locations) {
        const key = await physicalEntry(file), entries = claims.get(key) ?? [];
        entries.push({ skill, file }); claims.set(key, entries);
      }
      for (const entries of claims.values()) if (entries.length > 1) for (const { skill, file } of entries) {
        skill.locations = skill.locations.filter(location => location !== file);
        skill.exportOnlyLocations.push(file);
      }
      restorePreviews.clear();
      restorePreviews.set(previewId, { preview: result, catalog: JSON.stringify(catalog) });
      return result;
    });
  }
  async function restoreApply(previewId: string): Promise<RestoreResult> {
    return serial(async () => {
      if (await exists(path.join(paths.store, 'restore.json'))) {
        const pending = JSON.parse(await fs.readFile(path.join(paths.store, 'restore.json'), 'utf8'));
        if (pending.id !== previewId) throw new Error('A different restore is in progress. Restart the app to resume it.');
        const backupPath = await finishRestore(paths, checkLinkParent, remainingRestoreLinks);
        restorePreviews.clear(); previews.clear();
        return { ok: true, issues: [], skills: await list(), backupPath: backupPath! };
      }
      const saved = restorePreviews.get(previewId);
      if (!saved || saved.preview.issues.length || !saved.preview.skills.length) throw new Error('Review restore again before continuing.');
      const catalog = await readCatalog(paths.catalog);
      if (JSON.stringify(catalog) !== saved.catalog) throw new Error('The collection changed. Review restore again.');
      const journal: RestoreJournal = { id: previewId, backupPath: saved.preview.backupPath, catalog, entries: [] };
      for (const skill of catalog) {
        await verifyCanonical(skill);
        const selected = saved.preview.skills.find(item => item.id === skill.id)!;
        const currentLinks = await ownedLinks(skill);
        const selectedEntries = new Set(await Promise.all(selected.locations.map(physicalEntry)));
        for (const entry of currentLinks) if (!selectedEntries.has(await physicalEntry(entry.file))) throw new Error('Skill locations changed. Review restore again.');
        for (const target of [path.join(journal.backupPath, skill.linkName), ...selected.locations]) {
          let link: string | null = null;
          if (selected.locations.includes(target)) {
            await checkLinkParent(target);
            if (await exists(target)) {
              if (!await owned(target, skill.canonicalPath)) throw new Error(`Restore location is occupied: ${target}`);
              link = await fs.readlink(target);
            }
          }
          const index = journal.entries.length;
          journal.entries.push({ source: skill.canonicalPath, hash: skill.contentHash, target, link, stage: path.join(path.dirname(target), `.skills-manager-${previewId}-${index}.tmp`), backup: path.join(path.dirname(target), `.skills-manager-${previewId}-${index}.link`) });
        }
      }
      if (new Set(await Promise.all(journal.entries.map(entry => physicalEntry(entry.target)))).size !== journal.entries.length) throw new Error('Restore locations changed. Review restore again.');
      await fs.mkdir(journal.backupPath);
      await atomicJson(path.join(paths.store, 'restore.json'), journal);
      const backupPath = await finishRestore(paths, checkLinkParent, remainingRestoreLinks);
      restorePreviews.clear(); previews.clear();
      return { ok: true, issues: [], skills: await list(), backupPath: backupPath! };
    });
  }
  return { paths, bulk, restorePreview, restoreApply, acceptChanges, scan: () => scanRoots(paths), list, rescan: list, setupPreview: (signal?: AbortSignal) => preview(undefined, undefined, signal), setupApply: apply, fixBrokenLinks, previewImport: (folder: string, source?: SourceRecord, signal?: AbortSignal, origins?: Record<string, ImportOrigin>) => preview(folder, source, signal, origins), applyImport: apply,
    enable: (id: string) => change(id, 'enable'), disable: (id: string) => change(id, 'disable'), setDestinations, delete: (id: string) => change(id, 'delete'), removeMissing, recover: () => serial(() => recover(true)),
    detail: async (id: string): Promise<SkillDetail> => {
      const skill = (await list()).find(s => s.id === id);
      if (!skill) throw new Error('Skill not found');
      try {
        await verifyCanonical(skill);
        return { ...skill, contentState: 'ready', markdown: await fs.readFile(path.join(skill.canonicalPath, 'SKILL.md'), 'utf8') };
      } catch (error) {
        const failure = await contentFailure(skill, error);
        return { ...skill, ...failure, markdown: failure.contentState === 'changed' ? await fs.readFile(path.join(skill.canonicalPath, 'SKILL.md'), 'utf8') : '' };
      }
    },
  };
}
