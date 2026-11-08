import fs from 'node:fs/promises';
import path from 'node:path';
import type { StoredSkill } from '../shared/types';
import { atomicJson, readCatalog } from './catalog';
import { exists, treeHash } from './discovery';
import { inside, type RuntimePaths } from './paths';
import { writableDirectories } from './files';

export interface RestoreJournal {
  id: string;
  backupPath: string;
  catalog: StoredSkill[];
  removing?: Record<string, { dev: number; ino: number }>;
  entries: { source: string; target: string; hash: string; link: string | null; stage: string; backup: string; creatingStage?: boolean; installing?: boolean; identity?: { dev: number; ino: number }; installed?: { dev: number; ino: number }; directories?: Record<string, { dev?: number; ino?: number }> }[];
}


async function directoryModes(source: string, target: string): Promise<void> {
  const installed = await fs.lstat(target);
  if (!installed.isDirectory() || installed.isSymbolicLink()) throw new Error(`Restore folder changed: ${target}`);
  for (const entry of await fs.readdir(source, { withFileTypes: true })) if (entry.isDirectory()) await directoryModes(path.join(source, entry.name), path.join(target, entry.name));
  await fs.chmod(target, (await fs.lstat(source)).mode & 0o777);
}

async function emptyReservation(folder: string): Promise<void> {
  if (!await exists(folder)) return;
  const stat = await fs.lstat(folder);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (await fs.readdir(folder)).length) throw new Error(`Restore path is occupied: ${folder}`);
}

// Link complete staged files atomically; interrupted copies cannot leave partial public files.
async function installCopy(source: string, target: string, directories: NonNullable<RestoreJournal['entries'][number]['directories']>, save: () => Promise<void>): Promise<void> {
  for (const name of await fs.readdir(source)) {
    const from = path.join(source, name), to = path.join(target, name);
    const stat = await fs.lstat(from);
    if (stat.isDirectory()) {
      let reservation = directories[to];
      if (!reservation) {
        if (await exists(to)) throw new Error(`Restore folder is occupied: ${to}`);
        reservation = directories[to] = {};
        await save();
      }
      if (reservation.ino === undefined) {
        await emptyReservation(to);
        if (!await exists(to)) await fs.mkdir(to, { mode: 0o700 });
        const created = await fs.lstat(to);
        Object.assign(reservation, { dev: created.dev, ino: created.ino });
        await save();
      }
      const installed = await fs.lstat(to);
      if (!installed.isDirectory() || installed.isSymbolicLink() || installed.dev !== reservation.dev || installed.ino !== reservation.ino) throw new Error(`Restore folder changed: ${to}`);
      await fs.chmod(to, 0o700);
      await installCopy(from, to, directories, save);
      await fs.chmod(to, stat.mode & 0o777);
      continue;
    }
    try {
      if (stat.isSymbolicLink()) await fs.symlink(await fs.readlink(from), to);
      else if (stat.isFile()) await fs.link(from, to);
      else throw new Error(`Unsupported file: ${from}`);
    } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; }
    const installed = await fs.lstat(to);
    if (stat.isSymbolicLink()) {
      if (!installed.isSymbolicLink() || await fs.readlink(from) !== await fs.readlink(to)) throw new Error(`Restore link changed: ${to}`);
    } else if (!installed.isFile() || installed.isSymbolicLink()) throw new Error(`Restore file changed: ${to}`);
  }
}

// Resume forward: canonical copies stay intact until every independent copy is verified.
export async function finishRestore(paths: RuntimePaths, checkParent: (file: string) => Promise<void>, linksForSkill: (skill: StoredSkill) => Promise<{ file: string }[]>): Promise<string | null> {
  const record = path.join(paths.store, 'restore.json');
  if (!await exists(record)) return null;
  const journal: RestoreJournal = JSON.parse(await fs.readFile(record, 'utf8'));
  if (!/^[a-f0-9-]{36}$/.test(journal.id) || journal.backupPath !== path.join(paths.home, `Skills Manager Export-${journal.id}`)) throw new Error('Invalid restore record.');
  const current = await readCatalog(paths.catalog);
  if (current.length && JSON.stringify(current) !== JSON.stringify(journal.catalog)) throw new Error('The collection changed during restore.');
  const committed = current.length === 0;
  for (const [index, entry] of journal.entries.entries()) {
    const skill = journal.catalog.find(skill => skill.canonicalPath === entry.source && skill.contentHash === entry.hash);
    const exportTarget = skill && path.join(journal.backupPath, skill.linkName);
    if (!skill || !inside(paths.skills, entry.source) || entry.source === paths.skills
      || (entry.target !== exportTarget && !paths.destinations.some(root => entry.target !== root.path && inside(root.path, entry.target)))
      || entry.stage !== path.join(path.dirname(entry.target), `.skills-manager-${journal.id}-${index}.tmp`) || entry.backup !== path.join(path.dirname(entry.target), `.skills-manager-${journal.id}-${index}.link`)) throw new Error('Invalid restore path.');
    if (entry.target !== exportTarget) await checkParent(entry.target);
    if (committed) {
      if (!(await fs.lstat(entry.target)).isDirectory() || (await fs.lstat(entry.target)).isSymbolicLink() || await treeHash(entry.target) !== entry.hash) throw new Error(`Restored files changed: ${entry.target}`);
      continue;
    }
    if (await treeHash(entry.source) !== entry.hash) throw new Error(`Skill files changed: ${entry.source}`);
    if (!entry.identity) {
      if (!entry.creatingStage) {
        if (await exists(entry.stage)) throw new Error(`Restore staging path is occupied: ${entry.stage}`);
        entry.creatingStage = true;
        await atomicJson(record, journal);
      }
      await emptyReservation(entry.stage);
      if (!await exists(entry.stage)) await fs.mkdir(entry.stage, { mode: 0o700 });
      const stat = await fs.lstat(entry.stage);
      entry.identity = { dev: stat.dev, ino: stat.ino };
      await atomicJson(record, journal);
    }
    if (!entry.installed) {
      const stage = await fs.lstat(entry.stage);
      if (!stage.isDirectory() || stage.isSymbolicLink() || stage.dev !== entry.identity.dev || stage.ino !== entry.identity.ino) throw new Error(`Restore folder changed: ${entry.stage}`);
      await writableDirectories(entry.stage);
      await fs.cp(entry.source, entry.stage, { recursive: true, dereference: false, verbatimSymlinks: true, preserveTimestamps: true });
      await directoryModes(entry.source, entry.stage);
      if (await treeHash(entry.stage) !== entry.hash) throw new Error(`Copy verification failed: ${entry.target}`);
      if (!entry.installing) {
        if (await exists(entry.target)) {
          if (entry.link === null || !(await fs.lstat(entry.target)).isSymbolicLink() || await fs.readlink(entry.target) !== entry.link) throw new Error(`Restore location is occupied: ${entry.target}`);
          if (await exists(entry.backup)) throw new Error(`Restore backup is occupied: ${entry.backup}`);
          await fs.rename(entry.target, entry.backup);
        } else if (entry.link !== null && (!await exists(entry.backup) || !(await fs.lstat(entry.backup)).isSymbolicLink() || await fs.readlink(entry.backup) !== entry.link)) throw new Error(`Restore link changed: ${entry.target}`);
        entry.installing = true;
        await atomicJson(record, journal);
      }
      await emptyReservation(entry.target);
      if (!await exists(entry.target)) await fs.mkdir(entry.target, { mode: 0o700 });
      const installed = await fs.lstat(entry.target);
      entry.installed = { dev: installed.dev, ino: installed.ino };
      await atomicJson(record, journal);
    }
    const target = await fs.lstat(entry.target);
    if (!target.isDirectory() || target.isSymbolicLink() || target.dev !== entry.installed.dev || target.ino !== entry.installed.ino) throw new Error(`Restore location changed: ${entry.target}`);
    await fs.chmod(entry.target, 0o700);
    entry.directories ??= {};
    await installCopy(entry.stage, entry.target, entry.directories, () => atomicJson(record, journal));
    await fs.chmod(entry.target, (await fs.stat(entry.source)).mode & 0o777);
    if (await treeHash(entry.target) !== entry.hash) throw new Error(`Restored files changed: ${entry.target}`);
  }
  const backups = new Set(journal.entries.map(entry => entry.backup));
  for (const skill of journal.catalog) if ((await linksForSkill(skill)).some(entry => !backups.has(entry.file))) throw new Error(`Skill links changed during restore: ${skill.name}`);
  const metadata = path.join(journal.backupPath, '.metadata');
  await fs.mkdir(metadata, { recursive: true });
  const metadataStat = await fs.lstat(metadata);
  if (!metadataStat.isDirectory() || metadataStat.isSymbolicLink()) throw new Error('Export metadata folder changed.');
  await atomicJson(path.join(metadata, 'catalog.json'), journal.catalog);
  await atomicJson(paths.catalog, []);
  for (const entry of journal.entries) if (await exists(entry.backup)) {
    if (!(await fs.lstat(entry.backup)).isSymbolicLink() || await fs.readlink(entry.backup) !== entry.link) throw new Error(`Restore backup changed: ${entry.backup}`);
    await fs.unlink(entry.backup);
  }
  for (const entry of journal.entries) if (await exists(entry.stage)) {
    const stage = await fs.lstat(entry.stage);
    if (!stage.isDirectory() || stage.isSymbolicLink() || stage.dev !== entry.identity?.dev || stage.ino !== entry.identity.ino) throw new Error(`Restore staging folder changed: ${entry.stage}`);
    await writableDirectories(entry.stage);
    await fs.rm(entry.stage, { recursive: true });
  }
  for (const skill of journal.catalog) if (await exists(skill.canonicalPath)) {
    if (!journal.entries.some(entry => entry.source === skill.canonicalPath) || !inside(paths.skills, skill.canonicalPath) || skill.canonicalPath === paths.skills) throw new Error('Invalid stored copy.');
    const stored = await fs.lstat(skill.canonicalPath);
    const removing = journal.removing?.[skill.id];
    if (!stored.isDirectory() || stored.isSymbolicLink() || (removing ? stored.dev !== removing.dev || stored.ino !== removing.ino : await treeHash(skill.canonicalPath) !== skill.contentHash)) throw new Error(`Stored files changed: ${skill.canonicalPath}`);
    if ((await linksForSkill(skill)).length) throw new Error(`Skill links changed during restore: ${skill.name}`);
    if (!removing) {
      journal.removing ??= {};
      journal.removing[skill.id] = { dev: stored.dev, ino: stored.ino };
      await atomicJson(record, journal);
    }
    await writableDirectories(skill.canonicalPath);
    await fs.rm(skill.canonicalPath, { recursive: true });
  }
  await atomicJson(path.join(paths.store, 'last-export.json'), { path: journal.backupPath });
  await fs.unlink(record);
  return journal.backupPath;
}
