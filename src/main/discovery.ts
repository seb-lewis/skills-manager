import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parse } from 'yaml';
import { inside, validName, type RuntimePaths } from './paths';
import type { Issue, ScanResult, ScannedSkill } from '../shared/types';
function isMissing(error: unknown): boolean { return error instanceof Error && 'code' in error && error.code === 'ENOENT'; }
export async function exists(file: string): Promise<boolean> { try { await fs.lstat(file); return true; } catch (error) { if (isMissing(error)) return false; throw error; } }
export async function treeHash(root: string, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) throw new Error('Import canceled.');
  const hash = createHash('sha256');
  const realRoot = await fs.realpath(root);
  function entry(parts: (string | number)[]): void { hash.update(JSON.stringify(parts) + '\n'); }
  const rootStat = await fs.stat(realRoot);
  if (!rootStat.isDirectory()) throw new Error(`Skill folder is not a directory: ${root}`);
  entry(['.', rootStat.mode & 0o777, 'directory']);
  async function walk(folder: string): Promise<void> {
    for (const name of (await fs.readdir(folder)).sort()) {
      if (signal?.aborted) throw new Error('Import canceled.');
      const file = path.join(folder, name); const stat = await fs.lstat(file);
      const relative = path.relative(root, file);
      if (stat.isSymbolicLink()) {
        const link = await fs.readlink(file);
        if (path.isAbsolute(link) || !inside(root, path.resolve(path.dirname(file), link)) || !inside(realRoot, await fs.realpath(file))) throw new Error(`Link leaves skill folder: ${file}`);
        entry([relative, stat.mode & 0o777, 'link', link]);
      } else if (stat.isDirectory()) { entry([relative, stat.mode & 0o777, 'directory']); await walk(file); }
      else if (stat.isFile()) { entry([relative, stat.mode & 0o777, 'file', createHash('sha256').update(await fs.readFile(file, { signal })).digest('hex')]); }
      else throw new Error(`Unsupported file: ${file}`);
    }
  }
  await walk(root); return hash.digest('hex');
}
export async function scanRoots(paths: RuntimePaths, roots = paths.destinations, scope: 'personal' | 'repository' = 'personal', signal?: AbortSignal): Promise<ScanResult> {
  const checkCancelled = () => { if (signal?.aborted) throw new Error('Import canceled.'); };
  checkCancelled();
  const skills: ScannedSkill[] = []; const issues: Issue[] = [];
  const claudeSynced = path.join(paths.home, '.claude', 'skills', 'synced');
  const realClaudeSynced = scope === 'personal' ? await fs.realpath(claudeSynced).catch(() => undefined) : undefined;
  async function resolveFolder(folder: string): Promise<string | undefined> {
    try { return await fs.realpath(folder); }
    catch (error) {
      const brokenLink = isMissing(error) && (await fs.lstat(folder)).isSymbolicLink();
      issues.push({ path: folder, message: brokenLink ? 'Broken link.' : String(error) });
      return undefined;
    }
  }
  let realStore: string | undefined;
  try { if (await exists(paths.store)) realStore = await fs.realpath(paths.store); }
  catch (error) { issues.push({ path: paths.store, message: String(error) }); }
  const seen = new Set<string>();
  const skillsByRealPath = new Map<string, ScannedSkill>();
  const allowedRealRoots: string[] = [];
  const readableRoots: typeof roots = [];
  for (const root of roots) {
    checkCancelled();
    try {
      if (await exists(root.path)) {
        const realRoot = await resolveFolder(root.path);
        if (realRoot) { allowedRealRoots.push(realRoot); readableRoots.push(root); }
      }
    } catch (error) { issues.push({ path: root.path, message: String(error) }); }
  }
  for (const root of readableRoots) {
    async function walk(folder: string): Promise<void> {
      checkCancelled();
      try {
        if (scope === 'personal' && inside(claudeSynced, folder)) return;
        const realPath = await resolveFolder(folder);
        if (!realPath) return;
        if (realClaudeSynced && inside(realClaudeSynced, realPath)) return;
        if (realStore && inside(realStore, realPath)) return;
        const stat = await fs.lstat(folder);
        if (!(stat.isSymbolicLink() ? await fs.stat(folder) : stat).isDirectory()) return;
        const insideKnownRoot = allowedRealRoots.some((knownRoot) => inside(knownRoot, realPath));
        const external = scope === 'personal' && /(?:^|\/)(?:plugins|\.system|\.cache)(?:\/|$)/.test(realPath);
        if (scope === 'repository' && stat.isSymbolicLink() && !insideKnownRoot) {
          issues.push({ path: folder, message: 'Skill link leaves the configured roots.' });
          return;
        }
        const existing = skillsByRealPath.get(realPath);
        if (existing) {
          const destination = root.id;
          existing.destinations = [...new Set([...existing.destinations, destination])];
          if (folder !== existing.path && !existing.aliases.includes(folder)) {
            if (!stat.isSymbolicLink() && (await fs.lstat(existing.path)).isSymbolicLink()) {
              existing.aliases.push(existing.path);
              existing.path = folder;
              existing.id = createHash('sha256').update(folder).digest('hex').slice(0, 20);
              existing.linkName = path.basename(folder);
            } else existing.aliases.push(folder);
          }
          return;
        }
        if (seen.has(realPath)) return;
        if (await exists(path.join(folder, 'SKILL.md'))) {
          seen.add(realPath);
          const itemIssues: Issue[] = [];
          let contentHash = '';
          try { contentHash = await treeHash(realPath, signal); } catch (error) { checkCancelled(); itemIssues.push({ path: folder, message: String(error) }); }
          const markdown = contentHash ? await fs.readFile(path.join(folder, 'SKILL.md'), 'utf8') : '';
          const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
          const metadata: unknown = match ? parse(match[1] ?? '') : {};
          const name = metadata && typeof metadata === 'object' && 'name' in metadata && typeof metadata.name === 'string' ? metadata.name : path.basename(realPath);
          const description = metadata && typeof metadata === 'object' && 'description' in metadata && typeof metadata.description === 'string' ? metadata.description : '';
          const linkName = path.basename(folder);
          if (scope === 'personal' && !external && !validName(linkName)) itemIssues.push({ path: folder, message: 'Skill folder name must use letters, numbers, dots, underscores, spaces, or hyphens.' });
          const skill = { id: createHash('sha256').update(folder).digest('hex').slice(0, 20), name, description, path: folder, realPath, contentHash, linkName, destinations: [root.id], aliases: [], external, issues: itemIssues };
          skills.push(skill); skillsByRealPath.set(realPath, skill);
          return;
        }
        if (external) return;
        if (stat.isSymbolicLink() && folder !== root.path) return;
        seen.add(realPath);
        for (const entry of (await fs.readdir(folder, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
          if (entry.name === '.git' || entry.name === 'node_modules' || (scope === 'personal' && (entry.name.startsWith('.') || entry.name === 'plugins'))) continue;
          if (entry.isDirectory() || entry.isSymbolicLink()) await walk(path.join(folder, entry.name));
        }
      } catch (error) { checkCancelled(); issues.push({ path: folder, message: String(error) }); }
    }
    await walk(root.path);
  }
  checkCancelled();
  return { skills, issues, destinations: paths.destinations };
}
