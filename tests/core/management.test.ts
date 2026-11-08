import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createSkillsService } from '../../src/main/service';
import { resolvePaths } from '../../src/main/paths';
import { treeHash } from '../../src/main/discovery';
import { stageImport, stageImportTrees } from '../../src/main/import';

const evidence = fileURLToPath(new URL('../../artifacts/quality/', import.meta.url));
async function record(name: string, result: unknown) {
  await fs.mkdir(evidence, { recursive: true });
  await fs.writeFile(path.join(evidence, name), JSON.stringify({ at: new Date().toISOString(), result }, null, 2));
}
async function seed(folder: string, name: string) {
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, 'SKILL.md'), `---\nname: ${name}\ndescription: Original description\n---\nKeep every file.\n`);
  await fs.symlink('z-data', path.join(folder, 'a-link'));
  await fs.writeFile(path.join(folder, 'z-data'), 'Executable supporting file', { mode: 0o755 });
}

test('bulk failures keep recoverable items, and undo preserves accepted edits and disabled imports', async () => {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'skills-management-')));
  const paths = resolvePaths(home), service = createSkillsService(paths);
  try {
    const agents = path.join(home, '.agents/skills');
    for (const name of ['alpha', 'beta', 'gamma']) await seed(path.join(agents, name), name);
    const setup = await service.setupPreview();
    const applied = await service.setupApply({ previewId: setup.previewId, skillIds: setup.skills.map(skill => skill.id), destinations: ['claude'] });
    assert.equal(applied.ok, true, JSON.stringify(applied.issues));
    const alpha = applied.skills.find(skill => skill.name === 'alpha')!;
    const beta = applied.skills.find(skill => skill.name === 'beta')!;
    const gamma = applied.skills.find(skill => skill.name === 'gamma')!;
    assert.equal((await service.bulk('disable', [alpha.id, beta.id])).ok, true);
    await fs.writeFile(path.join(agents, 'beta'), 'Unrelated file');
    const enabled = await service.bulk('enable', [alpha.id, beta.id]);
    assert.deepEqual(enabled.failedIds, [beta.id]);
    assert.equal(await fs.readFile(path.join(agents, 'beta'), 'utf8'), 'Unrelated file');
    await fs.unlink(path.join(agents, 'beta'));

    const consumer = path.join(home, '.claude/skills/local-consumer');
    await fs.mkdir(consumer);
    await fs.writeFile(path.join(consumer, 'SKILL.md'), '---\nname: local-consumer\n---\nKeep this supporting dependency.');
    await fs.symlink(beta.canonicalPath, path.join(consumer, 'shared'));
    const deleted = await service.bulk('delete', [gamma.id, beta.id]);
    assert.deepEqual(deleted.failedIds, [beta.id]);
    assert.equal(deleted.skills.some(skill => skill.id === gamma.id), false);
    assert.equal(await fs.readFile(path.join(beta.canonicalPath, 'z-data'), 'utf8'), 'Executable supporting file');
    await fs.rm(consumer, { recursive: true });
    assert.equal((await service.bulk('delete', deleted.failedIds)).ok, true);

    await service.disable(alpha.id);
    const edited = '---\nname: alpha\ndescription: Edited description\n---\nKeep these local edits.\n';
    await fs.writeFile(path.join(alpha.canonicalPath, 'SKILL.md'), edited);
    assert.equal((await service.detail(alpha.id)).contentState, 'changed');
    assert.match((await service.detail(alpha.id)).markdown, /local edits/);
    assert.equal((await service.restorePreview()).issues.length, 1);
    const kept = await service.acceptChanges(alpha.id);
    assert.equal(kept.skills[0]?.contentState, 'ready');
    assert.equal(kept.skills[0]?.enabled, false);
    assert.equal(kept.skills[0]?.description, 'Edited description');
    assert.equal(await fs.readFile(path.join(alpha.canonicalPath, 'SKILL.md'), 'utf8'), edited);

    const imported = path.join(home, 'download/catalog.json');
    await seed(imported, 'catalog.json');
    const preview = await service.previewImport(imported, { path: imported });
    const added = await service.applyImport({ previewId: preview.previewId, skillIds: preview.skills.map(skill => skill.id), destinations: ['agents'] });
    const delta = added.skills.find(skill => skill.name === 'catalog.json')!;
    await service.disable(delta.id);
    const stale = await service.restorePreview();
    await service.enable(alpha.id);
    await assert.rejects(service.restoreApply(stale.previewId), /collection changed/);
    await service.disable(alpha.id);
    await fs.writeFile(path.join(agents, 'alpha'), 'New unrelated file');
    const occupied = await service.restorePreview();
    assert.deepEqual(occupied.issues, []);
    assert.deepEqual(occupied.skills.find(skill => skill.id === alpha.id)?.preservedLocations, [path.join(agents, 'alpha')]);
    assert.equal(await fs.readFile(path.join(agents, 'alpha'), 'utf8'), 'New unrelated file');
    const hashes = new Map((await service.list()).map(skill => [skill.name, skill.contentHash]));
    const restore = await service.restorePreview();
    assert.deepEqual(restore.issues, []);
    await service.restoreApply(restore.previewId);
    assert.deepEqual(await service.list(), []);
    assert.deepEqual(await fs.readdir(paths.skills), []);
    const exportHashes = Object.fromEntries(await Promise.all(restore.skills.map(async skill => [skill.name, await treeHash(path.join(restore.backupPath, skill.name))])));
    for (const [name, hash] of hashes) assert.equal(exportHashes[name], hash);
    await fs.rm(paths.store, { recursive: true });
    assert.equal(await fs.readFile(path.join(agents, 'alpha'), 'utf8'), 'New unrelated file');
    assert.equal(await fs.readFile(path.join(restore.backupPath, 'alpha/SKILL.md'), 'utf8'), edited);
    assert.equal(await treeHash(imported), hashes.get('catalog.json'));
    await record('management-results.json', { ok: true, bulkEnableFailed: enabled.failedIds, bulkDeleteFailed: deleted.failedIds, exportHashes, restoredEditedSkillHash: await treeHash(path.join(restore.backupPath, 'alpha')), occupiedOriginalPreserved: true });
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});

test('undo keeps untouched local sources and protects supporting links and unsafe edits', async () => {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'skills-boundaries-')));
  const paths = resolvePaths(home), service = createSkillsService(paths);
  try {
    await seed(path.join(home, '.agents/skills/sample'), 'sample');
    const setup = await service.setupPreview();
    const result = await service.setupApply({ previewId: setup.previewId, skillIds: setup.skills.map(skill => skill.id), destinations: [] });
    const skill = result.skills[0]!;
    const local = path.join(home, '.claude/skills/local');
    await seed(local, 'local');
    await fs.mkdir(path.join(local, 'references'));
    const support = path.join(local, 'references/shared');
    await fs.symlink(skill.canonicalPath, support);
    assert.equal((await service.disable(skill.id)).ok, true);
    assert.equal(await fs.readlink(support), skill.canonicalPath);
    assert.equal((await service.delete(skill.id)).ok, false);
    assert.equal(await fs.readlink(support), skill.canonicalPath);
    assert.equal((await fs.stat(path.join(skill.canonicalPath, 'SKILL.md'))).isFile(), true);
    assert.match((await service.restorePreview()).issues[0]!.message, /supporting link/);
    await fs.unlink(support);
    await fs.symlink(home, path.join(skill.canonicalPath, 'unsafe'));
    const before = await fs.readFile(paths.catalog, 'utf8');
    await assert.rejects(service.acceptChanges(skill.id), /Link leaves/);
    assert.equal(await fs.readFile(paths.catalog, 'utf8'), before);
    await fs.unlink(path.join(skill.canonicalPath, 'unsafe'));
    const localHash = await treeHash(local);
    for (const [source, destination] of [[path.dirname(local), 'agents'], [local, 'pi']] as const) {
      const preview = await service.previewImport(source, { path: source });
      const added = await service.applyImport({ previewId: preview.previewId, skillIds: preview.skills.map(item => item.id), destinations: [destination] });
      assert.equal(added.ok, true, JSON.stringify(added.issues));
      const restore = await service.restorePreview();
      assert.deepEqual(restore.issues, []);
      assert.equal(restore.skills.find(item => item.name === 'local')?.locations.includes(local), false);
      assert.equal((await service.restoreApply(restore.previewId)).ok, true);
      assert.equal(await treeHash(local), localHash);
    }
    await record('boundary-results.json', { ok: true, sourceHashBefore: localHash, sourceHashAfter: await treeHash(local), supportingLinkPreservedOnDisable: true, unsafeFilesRejectedWithoutCatalogChanges: true });
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});

test('undo survives process stops during folder creation, copying, commit, and cleanup', async () => {
  const cases = [];
  for (const phase of ['stage-mkdir', 'target-mkdir', 'stage-copy', 'target-link', 'stage-permissions', 'nested-directory', 'backup-rename', 'catalog-commit', 'canonical-cleanup']) {
    const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'skills-crash-')));
    const paths = resolvePaths(home), service = createSkillsService(paths);
    try {
      const original = path.join(home, '.agents/skills/sample');
      await seed(original, 'sample');
      await fs.writeFile(path.join(original, 'z-data'), Buffer.alloc(1024 * 1024, 42), { mode: 0o755 });
      if (phase === 'nested-directory' || phase === 'stage-permissions') { await fs.mkdir(path.join(original, 'group')); await fs.writeFile(path.join(original, 'group/data'), 'Permission-safe restart'); await fs.chmod(path.join(original, 'group'), phase === 'stage-permissions' ? 0o555 : 0o775); }
      const sourceHash = await treeHash(original);
      if (phase === 'backup-rename') await seed(path.join(home, '.agents/skills/other'), 'other');
      const preview = await service.setupPreview();
      assert.equal((await service.setupApply({ previewId: preview.previewId, skillIds: preview.skills.map(skill => skill.id), destinations: phase === 'backup-rename' ? ['claude'] : [] })).ok, true);
      const expected = new Map((await service.list()).map(skill => [skill.linkName, skill.contentHash]));
      const config = path.join(home, 'case.json');
      await fs.writeFile(config, JSON.stringify({ home, phase }));
      let stderr = '', stdout = '';
      const stopped = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../fixtures/restore-crash-child.mjs', import.meta.url)), config], { stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.on('error', reject);
        child.on('exit', (code, signal) => resolve({ code, signal }));
      });
      assert.equal(stopped.signal, 'SIGKILL', stderr || JSON.stringify(stopped));
      const journal = JSON.parse(await fs.readFile(path.join(paths.store, 'restore.json'), 'utf8'));
      await createSkillsService(paths).recover();
      assert.deepEqual(await service.list(), []);
      assert.deepEqual(await fs.readdir(paths.skills), []);
      const exportHash = await treeHash(path.join(journal.backupPath, 'sample'));
      assert.equal(exportHash, sourceHash);
      await fs.rm(paths.store, { recursive: true });
      const restoredHash = await treeHash(original);
      assert.equal(restoredHash, sourceHash);
      const verifiedLocations = [];
      if (phase === 'backup-rename') for (const [name, hash] of expected) for (const root of ['.agents/skills', '.claude/skills']) {
        const location = path.join(home, root, name);
        assert.equal((await fs.lstat(location)).isSymbolicLink(), false);
        const actual = await treeHash(location); assert.equal(actual, hash); verifiedLocations.push({ root, name, hash: actual });
      }
      if (phase === 'stage-permissions') { await fs.chmod(path.join(original, 'group'), 0o755); await fs.chmod(path.join(journal.backupPath, 'sample/group'), 0o755); }
      cases.push({ phase, stopped, step: stdout.trim(), sourceHash, exportHash, restoredHash, verifiedLocations });
    } finally { await fs.rm(home, { recursive: true, force: true }); }
  }
  await record('crash-results.json', { ok: true, cases });
});

test('local import keeps optional metadata, same-name variants, and safe selected trees', async () => {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'skills-cli-conflict-')));
  let exportedReadonly: string | undefined;
  let staged: Awaited<ReturnType<typeof stageImport>> | undefined;
  try {
    const source = path.join(home, 'download/R&D $skills;safe');
    for (const version of ['a', 'b']) {
      const folder = path.join(source, version);
      await seed(folder, 'shared-example');
      await fs.writeFile(path.join(folder, 'SKILL.md'), `---\nname: shared-example\n${version === 'b' ? 'metadata:\n  internal: true\n' : ''}---\nKeep optional local metadata.\n`);
      await fs.mkdir(path.join(folder, 'readonly'));
      await fs.writeFile(path.join(folder, 'readonly/data'), 'Keep read-only supporting files');
      await fs.chmod(path.join(folder, 'readonly'), 0o555);
      await fs.chmod(folder, 0o555);
      await fs.writeFile(path.join(folder, 'z-data'), `Version ${version}`, { mode: 0o755 });
    }
    const sourceHash = await treeHash(source);
    staged = await stageImport(source, resolvePaths(home));
    const service = createSkillsService(resolvePaths(home));
    const preview = await service.previewImport(staged.root, { path: source }, undefined, staged.origins);
    assert.equal(preview.skills.length, 2);
    assert.equal(preview.conflicts.length, 1);
    const selected = preview.skills[1]!;
    const result = await service.applyImport({ previewId: preview.previewId, skillIds: [selected.id], destinations: ['agents'] });
    assert.equal(result.ok, true, JSON.stringify(result.issues));
    assert.equal(await treeHash(result.skills[0]!.canonicalPath), selected.contentHash);
    assert.ok(result.skills[0]!.sources.some(record => record.path === selected.sourcePath));
    assert.equal(await treeHash(source), sourceHash);
    const stagedRoot = staged.root;
    await staged.cleanup(); staged = undefined;
    await assert.rejects(fs.lstat(stagedRoot), { code: 'ENOENT' });
    for (const version of ['a', 'b']) assert.equal((await fs.stat(path.join(source, version, 'readonly'))).mode & 0o777, 0o555);
    const minimal = path.join(home, 'My Notes');
    await fs.mkdir(minimal); await fs.writeFile(path.join(minimal, 'SKILL.md'), '# Notes\nKeep a local skill without frontmatter.\n');
    const minimalHash = await treeHash(minimal);
    const minimalStage = await stageImport(minimal, resolvePaths(home));
    const minimalPreview = await service.previewImport(minimalStage.root, { path: minimal }, undefined, minimalStage.origins);
    assert.equal(minimalPreview.skills[0]!.name, 'My Notes');
    const minimalAdded = await service.applyImport({ previewId: minimalPreview.previewId, skillIds: minimalPreview.skills.map(skill => skill.id), destinations: ['agents'] });
    assert.equal(minimalAdded.ok, true, JSON.stringify(minimalAdded.issues));
    const notesSkill = minimalAdded.skills.find(skill => skill.name === 'My Notes')!;
    await fs.writeFile(path.join(notesSkill.canonicalPath, 'SKILL.md'), '---\nname: Notes (Local)\n---\nKeep this display name.\n');
    assert.equal((await service.acceptChanges(notesSkill.id)).ok, true);
    const notesHash = await treeHash(notesSkill.canonicalPath);
    await minimalStage.cleanup();
    const repeated = await stageImport(source, resolvePaths(home));
    await Promise.all([repeated.cleanup(), repeated.cleanup()]); await repeated.cleanup();
    await assert.rejects(fs.lstat(repeated.root), { code: 'ENOENT' });
    const selectionPath = path.join(home, 'selected-source');
    await fs.symlink(source, selectionPath);
    await seed(path.join(source, 'unsafe'), 'unsafe');
    await fs.symlink('../../unrelated', path.join(source, 'unsafe/escaped'));
    await fs.symlink('missing-folder', path.join(source, 'broken'));
    await fs.symlink(result.skills[0]!.canonicalPath, path.join(source, 'already-managed'));
    await fs.mkdir(path.join(source, '.claude'));
    await fs.symlink('../', path.join(source, '.claude/skills'));
    const unfiltered = await stageImport(selectionPath, resolvePaths(home));
    const unfilteredPreview = await service.previewImport(unfiltered.root, { path: selectionPath });
    assert.equal(unfilteredPreview.skills.length, 2);
    assert.ok(unfiltered.issues.some(issue => issue.path.endsWith('/unsafe')));
    assert.ok(unfiltered.issues.some(issue => issue.path.endsWith('/broken')));
    await unfiltered.cleanup();
    const selectedOnly = await stageImport(`skills add ${selectionPath} --skill shared-example`, resolvePaths(home));
    const selectedPreview = await service.previewImport(selectedOnly.root, { path: selectionPath });
    assert.equal(selectedPreview.skills.length, 2);
    assert.deepEqual(selectedPreview.issues, []);
    await selectedOnly.cleanup();
    await fs.rm(path.join(source, 'unsafe'), { recursive: true });
    await fs.unlink(path.join(source, 'broken'));
    await fs.unlink(path.join(source, 'already-managed'));
    await fs.rm(path.join(source, '.claude'), { recursive: true });
    let failedImport = '';
    try { await stageImport('http://127.0.0.1:1/missing/repository', resolvePaths(home)); }
    catch (error) { failedImport = String(error); }
    assert.match(failedImport, /Import failed with code/);
    const restore = await service.restorePreview();
    assert.deepEqual(restore.issues, []);
    exportedReadonly = path.join(restore.backupPath, 'shared-example/readonly');
    assert.equal((await service.restoreApply(restore.previewId)).ok, true);
    assert.equal(await treeHash(path.join(restore.backupPath, 'my-notes')), notesHash);
    assert.equal(await treeHash(path.join(home, '.agents/skills/my-notes')), notesHash);
    assert.equal(await treeHash(minimal), minimalHash);
    assert.equal(await treeHash(source), sourceHash);
    await record('cli-conflict-results.json', { ok: true, candidateHashes: preview.skills.map(skill => skill.contentHash), conflictCount: preview.conflicts.length, importedHash: selected.contentHash, sourceHashBefore: sourceHash, sourceHashAfter: await treeHash(source), readonlyImportCleanupSucceeded: true, specialFolderNameImported: true, optionalDescriptionAndInternalMetadataAccepted: true, noFrontmatterImportedHash: minimalHash, displayNameWithParenthesesAcceptedAndRestoredHash: notesHash, selectedSafeCopiesSkipUnsafeSiblingBrokenLinkAndManagedAlias: true, pickerStyleSafeCandidatesAndUnsafeIssues: true, repeatedReadonlyCleanupSucceeded: true, sourceModesUnchanged: '0555', failedImport });
  } finally { await staged?.cleanup(); for (const folder of [path.join(home, 'download/R&D $skills;safe/a'), path.join(home, 'download/R&D $skills;safe/b'), path.join(home, '.agents/skills/shared-example'), exportedReadonly ? path.dirname(exportedReadonly) : undefined, path.join(home, 'download/R&D $skills;safe/a/readonly'), path.join(home, 'download/R&D $skills;safe/b/readonly'), path.join(home, '.agents/skills/shared-example/readonly'), exportedReadonly]) if (folder) await fs.chmod(folder, 0o755).catch(() => undefined); await fs.rm(home, { recursive: true, force: true }); }
});

test('setup adopts the real alias target and setup/import recover after canonical mkdir', async () => {
  const cases = [];
  for (const phase of ['setup-mkdir', 'import-mkdir']) {
    const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'skills-create-crash-')));
    const paths = resolvePaths(home), service = createSkillsService(paths);
    const name = phase === 'setup-mkdir' ? '_private' : 'long-'.padEnd(200, 'x');
    const source = path.join(home, phase === 'setup-mkdir' ? '.claude/skills/team' : 'download', name);
    try {
      await seed(source, name);
      if (phase === 'setup-mkdir') {
        const collection = path.dirname(source), linked = path.join(home, '.agents/skills/team');
        await fs.mkdir(path.dirname(linked), { recursive: true }); await fs.symlink(collection, linked);
      }
      const hash = await treeHash(source);
      const alias = path.join(home, '.agents/skills/first-alias');
      const chain = path.join(home, '.pi/agent/skills/chain');
      if (phase === 'setup-mkdir') { await fs.mkdir(path.dirname(alias), { recursive: true }); await fs.symlink(source, alias); await fs.mkdir(path.dirname(chain), { recursive: true }); await fs.symlink(alias, chain); }
      const config = path.join(home, 'case.json');
      await fs.writeFile(config, JSON.stringify({ home, phase, name, source }));
      let stderr = '';
      const stopped = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../fixtures/restore-crash-child.mjs', import.meta.url)), config], { stdio: ['ignore', 'ignore', 'pipe'] });
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.on('error', reject);
        child.on('exit', (code, signal) => resolve({ code, signal }));
      });
      assert.equal(stopped.signal, 'SIGKILL', stderr);
      await createSkillsService(paths).recover();
      assert.equal(await treeHash(source), hash);
      const preview = phase === 'setup-mkdir' ? await service.setupPreview() : await service.previewImport(source, { path: source });
      if (phase === 'setup-mkdir') {
        assert.equal(preview.skills[0]?.path, source);
        assert.deepEqual(preview.skills[0]?.aliases, [alias, chain]);
        assert.deepEqual(new Set(preview.skills[0]?.destinations), new Set(['agents', 'claude', 'pi']));
      }
      const request = { previewId: preview.previewId, skillIds: preview.skills.map(skill => skill.id), destinations: ['agents'] };
      const applied = await (phase === 'setup-mkdir' ? service.setupApply(request) : service.applyImport(request));
      assert.equal(applied.ok, true, JSON.stringify(applied.issues));
      const skill = applied.skills[0]!;
      if (phase === 'setup-mkdir') { assert.equal(await fs.readlink(source), skill.canonicalPath); assert.equal(await fs.readlink(alias), skill.canonicalPath); assert.equal(await fs.readlink(chain), skill.canonicalPath); }
      assert.equal((await service.disable(skill.id)).ok, true);
      if (phase === 'setup-mkdir') { await assert.rejects(fs.lstat(source), { code: 'ENOENT' }); await assert.rejects(fs.lstat(alias), { code: 'ENOENT' }); await assert.rejects(fs.lstat(chain), { code: 'ENOENT' }); }
      const restore = await service.restorePreview();
      assert.deepEqual(restore.issues, []);
      await service.restoreApply(restore.previewId);
      assert.equal(await treeHash(path.join(restore.backupPath, name)), hash);
      assert.equal(await treeHash(source), hash);
      cases.push({ phase, nameLength: name.length, stopped, sourceHash: hash, restoredSourceHash: await treeHash(source) });
    } finally { await fs.rm(home, { recursive: true, force: true }); }
  }
  await record('setup-recovery-results.json', { ok: true, cases });
});

test('renamed and merged setup copies keep one link per destination and reimport keeps disabled state', async () => {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'skills-destination-names-')));
  const paths = resolvePaths(home), service = createSkillsService(paths);
  const agents = path.join(home, '.agents/skills'), claude = path.join(home, '.claude/skills');
  try {
    await seed(path.join(agents, 'foo'), 'foo');
    await seed(path.join(claude, 'other'), 'foo');
    await fs.writeFile(path.join(claude, 'other/z-data'), 'Different version', { mode: 0o755 });
    const preview = await service.setupPreview();
    const renamed = preview.skills.find(skill => skill.path === path.join(claude, 'other'))!;
    const result = await service.setupApply({ previewId: preview.previewId, skillIds: preview.skills.map(skill => skill.id), destinations: [], names: [{ skillId: renamed.id, name: 'foo-2' }] });
    assert.equal(result.ok, true, JSON.stringify(result.issues));
    assert.deepEqual(await fs.readdir(claude), ['other']);
    const skill = result.skills.find(item => item.name === 'foo-2')!;
    assert.deepEqual(skill.linkedDestinations, ['claude']);
    assert.deepEqual(skill.issues, []);
    await service.disable(skill.id);
    await service.enable(skill.id);
    assert.deepEqual(await fs.readdir(claude), ['other']);
    const undo = await service.restorePreview();
    await service.restoreApply(undo.previewId);
    assert.deepEqual(await fs.readdir(claude), ['other']);

    await seed(path.join(agents, 'pdf-tools'), 'pdf');
    await seed(path.join(claude, 'pdf'), 'pdf');
    const merge = await service.setupPreview();
    const merged = await service.setupApply({ previewId: merge.previewId, skillIds: merge.skills.filter(item => item.name === 'pdf').map(item => item.id), destinations: [] });
    assert.equal(merged.ok, true, JSON.stringify(merged.issues));
    assert.deepEqual((await fs.readdir(agents)).filter(name => name.startsWith('pdf')), ['pdf-tools']);
    assert.deepEqual((await fs.readdir(claude)).filter(name => name.startsWith('pdf')), ['pdf']);
    const pdf = merged.skills[0]!;
    assert.deepEqual(new Set(pdf.linkedDestinations), new Set(['agents', 'claude']));
    await service.disable(pdf.id);
    const local = path.join(home, 'download/pdf');
    await fs.cp(pdf.canonicalPath, local, { recursive: true, dereference: false, verbatimSymlinks: true });
    const again = await service.previewImport(local, { path: local });
    const imported = await service.applyImport({ previewId: again.previewId, skillIds: again.skills.map(item => item.id), destinations: ['agents'] });
    assert.equal(imported.ok, true);
    assert.equal(imported.skills[0]?.enabled, false);
    assert.equal((await fs.readdir(agents)).some(name => name.startsWith('pdf')), false);
    const restore = await service.restorePreview();
    await service.restoreApply(restore.previewId);
    assert.deepEqual((await fs.readdir(agents)).filter(name => name.startsWith('pdf')), ['pdf-tools']);
    assert.deepEqual((await fs.readdir(claude)).filter(name => name.startsWith('pdf')), ['pdf']);
    await record('destination-name-results.json', { ok: true, renamedDestinationEntries: ['other'], mergedAgentsEntries: ['pdf-tools'], mergedClaudeEntries: ['pdf'], disabledAfterReimport: true });
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});


test('undo preserves directory modes, removed roots, personal links and disabled link conflicts', async () => {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'skills-permissions-')));
  const paths = resolvePaths(home), service = createSkillsService(paths);
  try {
    const original = path.join(home, '.claude/skills/personal');
    const source = path.join(home, 'dotfiles/personal');
    await seed(source, 'personal');
    await fs.mkdir(path.dirname(original), { recursive: true });
    await fs.symlink(source, original);
    await fs.mkdir(path.join(home, '.pi/agent/skills'), { recursive: true });
    await fs.cp(source, path.join(home, '.pi/agent/skills/personal'), { recursive: true, verbatimSymlinks: true });
    const preview = await service.setupPreview();
    assert.equal(preview.skills[0]?.external, false);
    const applied = await service.setupApply({ previewId: preview.previewId, skillIds: preview.skills.map(skill => skill.id), destinations: ['agents', 'pi'] });
    assert.equal(applied.ok, true, JSON.stringify(applied.issues));
    const skill = applied.skills[0]!;
    assert.equal(await treeHash(source), skill.contentHash);
    await service.disable(skill.id);
    await fs.symlink(skill.canonicalPath, original);
    const unexpected = path.join(home, '.config/opencode/skills/other-name');
    await fs.mkdir(path.dirname(unexpected), { recursive: true });
    await fs.symlink(skill.canonicalPath, unexpected);
    const observed = (await service.list())[0]!;
    assert.equal(observed.enabled, false);
    assert.deepEqual(observed.linkedDestinations.sort(), ['claude', 'opencode']);
    assert.equal(observed.issues.filter(issue => issue.message === 'Disabled skill has an active link.').length, 2);
    assert.equal((await service.disable(skill.id)).ok, true);
    await assert.rejects(fs.lstat(original), { code: 'ENOENT' });
    await assert.rejects(fs.lstat(unexpected), { code: 'ENOENT' });
    // An identical reappearing directory is consolidated without enabling the skill.
    await fs.cp(source, original, { recursive: true, verbatimSymlinks: true });
    const disabledAlias = path.join(home, '.agents/skills/reappeared');
    const disabledChain = path.join(home, '.pi/agent/skills/reappeared');
    await fs.symlink(original, disabledAlias); await fs.symlink(disabledAlias, disabledChain);
    const again = await service.setupPreview();
    const merged = await service.setupApply({ previewId: again.previewId, skillIds: again.skills.map(skill => skill.id), destinations: [] });
    assert.equal(merged.ok, true, JSON.stringify(merged.issues));
    assert.equal(merged.skills[0]?.enabled, false);
    await assert.rejects(fs.lstat(disabledAlias), { code: 'ENOENT' });
    await assert.rejects(fs.lstat(disabledChain), { code: 'ENOENT' });
    await assert.rejects(fs.lstat(original), { code: 'ENOENT' });
    await fs.mkdir(path.join(skill.canonicalPath, 'group'));
    await fs.writeFile(path.join(skill.canonicalPath, 'group/data'), 'Keep group mode');
    await fs.chmod(path.join(skill.canonicalPath, 'group'), 0o775);
    await fs.mkdir(path.join(skill.canonicalPath, 'readonly'));
    await fs.writeFile(path.join(skill.canonicalPath, 'readonly/data'), 'Keep read-only contents');
    await fs.chmod(path.join(skill.canonicalPath, 'readonly'), 0o555);
    const kept = await service.acceptChanges(skill.id);
    const hash = kept.skills[0]!.contentHash;
    await fs.rm(path.join(home, '.pi'), { recursive: true });
    // Root was seen by this service before removal.
    const restore = await service.restorePreview();
    assert.deepEqual(restore.issues, []);
    const result = await service.restoreApply(restore.previewId);
    assert.equal(result.ok, true);
    const exported = path.join(restore.backupPath, skill.linkName);
    assert.equal(await treeHash(exported), hash);
    assert.equal((await fs.stat(path.join(exported, 'group'))).mode & 0o777, 0o775);
    assert.equal((await fs.stat(path.join(exported, 'readonly'))).mode & 0o777, 0o555);
    assert.equal(await fs.readFile(path.join(exported, 'readonly/data'), 'utf8'), 'Keep read-only contents');
    assert.equal(await treeHash(source), preview.skills[0]!.contentHash);
    assert.deepEqual(await fs.readdir(paths.skills), []);
    await seed(path.join(home, '.agents/skills/Case'), 'Case');
    await seed(path.join(home, '.claude/skills/case'), 'case');
    const casePreview = await service.setupPreview();
    assert.ok(casePreview.conflicts.some(conflict => conflict.skillIds.length === 2 && ['Case', 'case'].includes(conflict.name)));
    await record('permissions-observed-results.json', { hash, exportHash: await treeHash(exported), groupMode: '0775', readonlyMode: '0555', observedIssues: observed.issues, personalTargetIntact: true, removedAgentRootSkipped: true, disabledSetupPreserved: true });
    await fs.chmod(path.join(exported, 'readonly'), 0o755);
    for (const location of restore.skills[0]!.locations) await fs.chmod(path.join(location, 'readonly'), 0o755);
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});

test('shared physical roots and reused setup paths have one safe link plan and undo export', async () => {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'skills-physical-')));
  const results: unknown[] = [];
  try {
    const sharedHome = path.join(home, 'shared'), sharedPaths = resolvePaths(sharedHome), shared = createSkillsService(sharedPaths);
    const original = path.join(sharedHome, '.agents/skills/pdf-tools');
    await seed(original, 'pdf');
    const sourceHash = await treeHash(original);
    await fs.mkdir(path.join(sharedHome, '.claude'), { recursive: true });
    await fs.symlink(path.join(sharedHome, '.agents/skills'), path.join(sharedHome, '.claude/skills'));
    const preview = await shared.setupPreview();
    const added = await shared.setupApply({ previewId: preview.previewId, skillIds: preview.skills.map(skill => skill.id), destinations: ['agents', 'claude'] });
    assert.equal(added.ok, true, JSON.stringify(added.issues));
    const id = added.skills[0]!.id;
    assert.deepEqual((await fs.readdir(path.dirname(original))).filter(name => !name.startsWith('.')), ['pdf-tools']);
    const edited = await shared.setDestinations(id, ['agents']);
    assert.equal(edited.ok, true, JSON.stringify(edited.issues));
    assert.equal((await fs.lstat(original)).isSymbolicLink(), true);
    assert.deepEqual(edited.skills[0]!.issues, []);
    const undo = await shared.restorePreview();
    assert.deepEqual(undo.issues, []);
    assert.equal(undo.skills[0]!.locations.length, 1);
    assert.equal((await shared.restoreApply(undo.previewId)).ok, true);
    assert.equal(await treeHash(original), sourceHash);
    assert.equal(await treeHash(path.join(sharedHome, '.claude/skills/pdf-tools')), sourceHash);
    assert.deepEqual(await fs.readdir(sharedPaths.skills), []);
    results.push({ case: 'shared-root', sourceHash, restoredHash: await treeHash(original), restoreLocations: undo.skills[0]!.locations, retainedDestinationPresent: true });

    const unnamedHome = path.join(home, 'unnamed'), unnamed = createSkillsService(resolvePaths(unnamedHome));
    const unnamedSources = [path.join(unnamedHome, '.agents/skills/code-review'), path.join(unnamedHome, '.claude/skills/review')];
    for (const folder of unnamedSources) { await fs.mkdir(folder, { recursive: true }); await fs.writeFile(path.join(folder, 'SKILL.md'), '# Review\nKeep these identical unnamed instructions.\n'); }
    const unnamedPreview = await unnamed.setupPreview();
    assert.equal(new Set(unnamedPreview.skills.map(skill => skill.name)).size, 1);
    assert.equal(unnamedPreview.skills[0]!.name, 'code-review');
    const unnamedAdded = await unnamed.setupApply({ previewId: unnamedPreview.previewId, skillIds: unnamedPreview.skills.map(skill => skill.id), destinations: [] });
    assert.equal(unnamedAdded.ok, true, JSON.stringify(unnamedAdded.issues));
    assert.equal(unnamedAdded.skills.length, 1);
    const unnamedUndo = await unnamed.restorePreview();
    assert.equal((await unnamed.restoreApply(unnamedUndo.previewId)).ok, true);
    for (const folder of unnamedSources) assert.equal(await treeHash(folder), unnamedAdded.skills[0]!.contentHash);
    results.push({ case: 'unnamed-identical-copies', reviewedName: unnamedPreview.skills[0]!.name, canonicalCount: unnamedAdded.skills.length, originalNamesRestored: unnamedSources });

    const modesHome = path.join(home, 'modes'), modes = createSkillsService(resolvePaths(modesHome));
    const modeSources = [path.join(modesHome, '.agents/skills/mode-check'), path.join(modesHome, '.claude/skills/mode-check')];
    const accessModes = [0o700, 0o755];
    for (const [index, folder] of modeSources.entries()) { await seed(folder, 'mode-check'); await fs.chmod(path.join(folder, 'SKILL.md'), 0o444); await fs.chmod(folder, accessModes[index]!); }
    const modePreview = await modes.setupPreview();
    assert.equal(new Set(modePreview.skills.map(skill => skill.contentHash)).size, 2);
    assert.equal(modePreview.conflicts.length, 1);
    const modeAdded = await modes.setupApply({ previewId: modePreview.previewId, skillIds: modePreview.skills.map(skill => skill.id), names: modePreview.skills.map((skill, index) => ({ skillId: skill.id, name: `mode-check-${index + 2}` })), destinations: [] });
    assert.equal(modeAdded.ok, true, JSON.stringify(modeAdded.issues));
    for (const skill of modeAdded.skills) assert.equal((await fs.stat(path.join(skill.canonicalPath, 'SKILL.md'))).mode & 0o777, 0o444);
    const modeUndo = await modes.restorePreview();
    assert.equal((await modes.restoreApply(modeUndo.previewId)).ok, true);
    const restoredModes = [];
    for (const [index, folder] of modeSources.entries()) { const mode = (await fs.stat(folder)).mode & 0o777; assert.equal(mode, accessModes[index]); assert.equal((await fs.stat(path.join(folder, 'SKILL.md'))).mode & 0o777, 0o444); restoredModes.push(mode); }
    results.push({ case: 'top-folder-modes-and-readonly-rename', accessModes, restoredModes, skillFileModePreserved: 0o444, distinctCanonicalCount: modeAdded.skills.length });

    const historyHome = path.join(home, 'history'), history = createSkillsService(resolvePaths(historyHome));
    const reused = path.join(historyHome, '.claude/skills/foo');
    await seed(reused, 'foo');
    let review = await history.setupPreview();
    const first = await history.setupApply({ previewId: review.previewId, skillIds: review.skills.map(skill => skill.id), destinations: [] });
    assert.equal(first.ok, true);
    await history.disable(first.skills[0]!.id);
    await seed(reused, 'foo');
    await fs.writeFile(path.join(reused, 'z-data'), 'New version');
    review = await history.setupPreview();
    const second = await history.setupApply({ previewId: review.previewId, skillIds: review.skills.map(skill => skill.id), names: review.skills.map(skill => ({ skillId: skill.id, name: 'foo-2' })), destinations: [] });
    assert.equal(second.ok, true, JSON.stringify(second.issues));
    const newer = second.skills.find(skill => skill.name === 'foo-2')!;
    await history.disable(newer.id);
    const plan = await history.restorePreview();
    assert.deepEqual(plan.issues, []);
    for (const skill of plan.skills) { assert.deepEqual(skill.locations, []); assert.deepEqual(skill.exportOnlyLocations, [reused]); }
    assert.equal((await history.restoreApply(plan.previewId)).ok, true);
    for (const skill of second.skills) assert.equal(await treeHash(path.join(plan.backupPath, skill.linkName)), skill.contentHash);
    results.push({ case: 'reused-missing-original', plan: plan.skills, exportedBothVersions: true });

    const conflictHome = path.join(home, 'conflict'), conflictPaths = resolvePaths(conflictHome), conflicts = createSkillsService(conflictPaths);
    await seed(path.join(conflictHome, '.agents/skills/foo'), 'foo');
    await seed(path.join(conflictHome, '.claude/skills/foo'), 'foo');
    await fs.writeFile(path.join(conflictHome, '.claude/skills/foo/z-data'), 'Another version');
    const before = await treeHash(path.join(conflictHome, '.agents/skills/foo'));
    const choices = await conflicts.setupPreview();
    const request = { previewId: choices.previewId, skillIds: choices.skills.map(skill => skill.id), names: [{ skillId: choices.skills[0]!.id, name: 'foo-2' }], destinations: ['agents', 'claude'] };
    await assert.rejects(conflicts.setupApply(request), /Two selected skills use .*Clear Shared Agents/);
    assert.equal(await treeHash(path.join(conflictHome, '.agents/skills/foo')), before);
    await assert.rejects(fs.lstat(conflictPaths.operations), { code: 'ENOENT' });
    assert.equal((await fs.lstat(path.join(conflictHome, '.claude/skills/foo'))).isDirectory(), true);
    assert.equal((await conflicts.setupApply({ ...request, destinations: [] })).ok, true);
    const nestedHome = path.join(home, 'nested'), nested = createSkillsService(resolvePaths(nestedHome));
    const nestedSource = path.join(nestedHome, '.claude/skills/collection/foo');
    await seed(nestedSource, 'foo');
    const nestedPreview = await nested.setupPreview();
    const nestedAdded = await nested.setupApply({ previewId: nestedPreview.previewId, skillIds: nestedPreview.skills.map(skill => skill.id), destinations: [] });
    assert.equal(nestedAdded.ok, true);
    await nested.disable(nestedAdded.skills[0]!.id);
    await fs.rmdir(path.dirname(nestedSource));
    assert.equal((await nested.enable(nestedAdded.skills[0]!.id)).ok, true);
    assert.equal((await fs.lstat(nestedSource)).isSymbolicLink(), true);
    await fs.rm(path.dirname(nestedSource), { recursive: true });
    assert.equal((await nested.setDestinations(nestedAdded.skills[0]!.id, ['claude', 'pi'])).ok, true);
    assert.equal((await fs.lstat(nestedSource)).isSymbolicLink(), true);
    await nested.disable(nestedAdded.skills[0]!.id);
    await fs.rmdir(path.dirname(nestedSource));
    await fs.mkdir(path.join(nestedHome, '.agents/skills'), { recursive: true });
    await fs.cp(nestedAdded.skills[0]!.canonicalPath, path.join(nestedHome, '.agents/skills/foo'), { recursive: true, verbatimSymlinks: true });
    const reusePreview = await nested.setupPreview();
    assert.equal(reusePreview.existing[0]!.enabled, false);
    const reusedResult = await nested.setupApply({ previewId: reusePreview.previewId, skillIds: reusePreview.skills.map(skill => skill.id), destinations: [] });
    assert.equal(reusedResult.ok, true, JSON.stringify(reusedResult.issues));
    assert.equal(reusedResult.skills[0]!.enabled, false);
    await assert.rejects(fs.lstat(nestedSource), { code: 'ENOENT' });
    const nestedUndo = await nested.restorePreview();
    assert.deepEqual(nestedUndo.issues, []);
    assert.deepEqual(nestedUndo.skills[0]!.exportOnlyLocations, [nestedSource]);
    assert.equal((await nested.restoreApply(nestedUndo.previewId)).ok, true);
    assert.equal(await treeHash(path.join(nestedUndo.backupPath, 'foo')), nestedAdded.skills[0]!.contentHash);
    results.push({ case: 'preflight-and-missing-nested-parent', rejectedBeforeJournal: true, correctedSelectionSucceeded: true, nestedEnableAndLocationEditRecreatedParent: true, disabledReusePlanState: false, nestedExportHash: await treeHash(path.join(nestedUndo.backupPath, 'foo')) });
    await record('physical-locations-results.json', results);
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});


test('symlinked personal skills retain supporting dependencies and original aliases', async () => {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'skills-symlink-support-')));
  const storeVolume = path.join(home, 'store-volume');
  await fs.mkdir(storeVolume);
  await fs.symlink(storeVolume, path.join(home, '.skills-manager'));
  const service = createSkillsService(resolvePaths(home));
  try {
    const source = path.join(home, '.agents/skills/target');
    await seed(source, 'target');
    const alias = path.join(home, '.agents/skills/target-alias');
    await fs.symlink(source, alias);
    const preview = await service.setupPreview();
    const setup = await service.setupApply({ previewId: preview.previewId, skillIds: preview.skills.map(skill => skill.id), destinations: [] });
    assert.equal(setup.ok, true);
    const skill = setup.skills[0]!;
    const testPaths = resolvePaths(home);
    const rollbackAlias = path.join(home, '.claude/skills/target');
    const piRoot = path.join(home, '.pi/agent/skills');
    await fs.mkdir(path.dirname(rollbackAlias), { recursive: true });
    await fs.mkdir(piRoot, { recursive: true });
    const catalogBeforeLocations = await fs.readFile(testPaths.catalog, 'utf8');
    const locationFailures = [];
    for (const [kind, rawTarget] of [['chain', source], ['physical', await fs.realpath(skill.canonicalPath)]]) {
      await fs.symlink(rawTarget!, rollbackAlias);
      await fs.chmod(piRoot, 0o555);
      let failed;
      try { failed = await service.setDestinations(skill.id, ['claude', 'pi']); }
      finally { await fs.chmod(piRoot, 0o755); }
      assert.equal(failed.ok, false);
      assert.ok(failed.issues.some(issue => issue.message.includes('EACCES')), JSON.stringify(failed.issues));
      assert.ok(!failed.issues.some(issue => issue.message.includes('Invalid destination')));
      assert.equal(await fs.readlink(rollbackAlias), rawTarget);
      assert.equal(await fs.realpath(rollbackAlias), await fs.realpath(skill.canonicalPath));
      assert.equal(await fs.readFile(testPaths.catalog, 'utf8'), catalogBeforeLocations);
      await createSkillsService(testPaths).recover();
      assert.deepEqual(await fs.readdir(testPaths.operations), []);
      locationFailures.push({ kind, rawTarget, issues: failed.issues, restoredRawTarget: await fs.readlink(rollbackAlias), catalogUnchanged: true });
      await fs.unlink(rollbackAlias);
    }
    await fs.symlink(source, rollbackAlias);
    const editConfig = path.join(home, 'destinations-case.json');
    await fs.writeFile(editConfig, JSON.stringify({ home, phase: 'destinations-rewrite', skillId: skill.id, rewritePath: rollbackAlias }));
    let editStderr = '';
    const editStopped = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../fixtures/restore-crash-child.mjs', import.meta.url)), editConfig], { stdio: ['ignore', 'ignore', 'pipe'] });
      child.stderr.on('data', chunk => { editStderr += chunk; }); child.on('error', reject); child.on('exit', (code, signal) => resolve({ code, signal }));
    });
    assert.equal(editStopped.signal, 'SIGKILL', editStderr);
    await createSkillsService(testPaths).recover();
    assert.equal(await fs.readlink(rollbackAlias), source);
    assert.equal(await fs.readFile(testPaths.catalog, 'utf8'), catalogBeforeLocations);
    assert.deepEqual(await fs.readdir(testPaths.operations), []);
    assert.equal(await treeHash(skill.canonicalPath), skill.contentHash);
    await record('destination-recovery-results.json', { failures: locationFailures, stopped: editStopped, rawTargetAfterRestart: await fs.readlink(rollbackAlias), catalogUnchanged: true, canonicalHashAfterRestart: await treeHash(skill.canonicalPath), pendingOperations: await fs.readdir(testPaths.operations) });
    await fs.unlink(rollbackAlias);
    const physicalAlias = path.join(home, '.claude/skills/physical-target');
    const chainAlias = path.join(home, '.config/opencode/skills/target');
    await fs.mkdir(path.dirname(physicalAlias), { recursive: true });
    await fs.mkdir(path.dirname(chainAlias), { recursive: true });
    await fs.symlink(await fs.realpath(skill.canonicalPath), physicalAlias);
    await fs.symlink(physicalAlias, chainAlias);
    const keptChain = await service.setDestinations(skill.id, ['opencode']);
    assert.equal(keptChain.ok, true, JSON.stringify(keptChain.issues));
    assert.equal(await fs.realpath(chainAlias), await fs.realpath(skill.canonicalPath));
    assert.equal(await fs.readlink(chainAlias), skill.canonicalPath);
    await assert.rejects(fs.lstat(physicalAlias), { code: 'ENOENT' });
    assert.equal((await service.setDestinations(skill.id, ['agents'])).ok, true);
    await fs.symlink(await fs.realpath(skill.canonicalPath), physicalAlias);
    await fs.symlink(physicalAlias, chainAlias);
    await service.disable(skill.id);
    await assert.rejects(fs.lstat(physicalAlias), { code: 'ENOENT' });
    await assert.rejects(fs.lstat(chainAlias), { code: 'ENOENT' });
    assert.equal((await service.enable(skill.id)).ok, true);
    assert.equal((await fs.lstat(source)).isSymbolicLink(), true);
    assert.equal((await fs.lstat(alias)).isSymbolicLink(), true);
    assert.equal((await service.setDestinations(skill.id, ['agents'])).ok, true);
    assert.equal((await fs.lstat(alias)).isSymbolicLink(), true);
    const local = path.join(home, 'dotfiles/skills/local');
    await fs.mkdir(path.join(local, '.hidden'), { recursive: true });
    await fs.writeFile(path.join(local, 'SKILL.md'), '---\nname: local\n---\nKeep this external personal skill.');
    const physicalReference = path.join(await fs.realpath(skill.canonicalPath), 'z-data');
    await fs.symlink(physicalReference, path.join(local, '.hidden/shared'));
    await fs.symlink('..', path.join(local, '.hidden/cycle'));
    await fs.symlink('.hidden', path.join(local, 'references'));
    const localAlias = path.join(home, '.claude/skills/local');
    await fs.mkdir(path.dirname(localAlias), { recursive: true });
    await fs.symlink(local, localAlias);
    const deleted = await service.delete(skill.id);
    assert.equal(deleted.ok, false);
    assert.match(deleted.issues[0]!.message, /supporting link/);
    assert.equal(await treeHash(skill.canonicalPath), skill.contentHash);
    assert.equal((await fs.lstat(source)).isSymbolicLink(), true);
    const bulk = await service.bulk('delete', [skill.id]);
    assert.deepEqual(bulk.failedIds, [skill.id]);
    const undo = await service.restorePreview();
    assert.equal(undo.issues.length, 1);
    assert.match(undo.issues[0]!.message, /supporting link/);
    assert.equal(await fs.readlink(path.join(local, '.hidden/shared')), physicalReference);
    await fs.unlink(path.join(local, '.hidden/shared'));
    await fs.unlink(path.join(local, 'references'));
    const sharedReferences = path.join(home, 'shared-references');
    await fs.mkdir(sharedReferences);
    await fs.symlink(skill.canonicalPath, path.join(sharedReferences, 'target'));
    await fs.symlink(sharedReferences, path.join(local, 'references'));
    const indirect = await service.delete(skill.id);
    assert.equal(indirect.ok, false);
    assert.match(indirect.issues[0]!.message, /supporting link/);
    await fs.unlink(path.join(sharedReferences, 'target'));
    await fs.symlink(await fs.realpath(skill.canonicalPath), physicalAlias);
    await fs.symlink(physicalAlias, chainAlias);
    assert.equal((await service.delete(skill.id)).ok, true);
    await assert.rejects(fs.lstat(physicalAlias), { code: 'ENOENT' });
    await assert.rejects(fs.lstat(chainAlias), { code: 'ENOENT' });
    assert.equal(await fs.readlink(localAlias), local);
    assert.match(await fs.readFile(path.join(local, 'SKILL.md'), 'utf8'), /Keep this external personal skill/);
    await seed(path.join(home, '.agents/skills/standalone'), 'standalone');
    const standalonePreview = await service.setupPreview();
    const standalone = standalonePreview.skills.find(item => item.name === 'standalone')!;
    const standaloneResult = await service.setupApply({ previewId: standalonePreview.previewId, skillIds: [standalone.id], destinations: [] });
    assert.equal(standaloneResult.ok, true, JSON.stringify(standaloneResult.issues));
    const standaloneSkill = standaloneResult.skills[0]!;
    assert.equal(standaloneSkill.enabled, true);
    await fs.symlink(await fs.realpath(standaloneSkill.canonicalPath), physicalAlias);
    await fs.symlink(physicalAlias, chainAlias);
    const standaloneUndo = await service.restorePreview();
    assert.deepEqual(standaloneUndo.issues, []);
    assert.equal(standaloneUndo.skills[0]!.locations.length, 3);
    assert.equal((await service.restoreApply(standaloneUndo.previewId)).ok, true);
    for (const file of standaloneUndo.skills[0]!.locations) assert.equal(await treeHash(file), standaloneSkill.contentHash);
    assert.equal(await treeHash(path.join(standaloneUndo.backupPath, standaloneSkill.linkName)), standaloneSkill.contentHash);
    await record('symlink-support-results.json', { deleteBlocked: deleted.issues, bulkFailedIds: bulk.failedIds, undoBlocked: undo.issues, physicalHome: home, lexicalStore: path.join(home, '.skills-manager'), physicalStore: storeVolume, physicalFileReference: physicalReference, enabledInternalLinkDeleteSucceeded: true, enabledInternalLinkUndoSucceeded: true, physicalAndChainedAliasesDisabledAndDeleted: true, selectedChainSurvivesUnselectedAliasRemoval: true, physicalAndChainedAliasesIndependentlyRestored: standaloneUndo.skills[0]!.locations, externalSkillPreserved: true, hiddenDependencyDetected: true, externalSupportingDirectoryDependencyDetected: true, internalDirectoryAliasAndCycleTerminated: true, originalAliasesRetainedAfterEnableAndLocationEdit: true });
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});


test('safe edits after a setup commit crash remain reviewable and complete recovery', async () => {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'skills-committed-edits-')));
  const paths = resolvePaths(home);
  try {
    for (const name of ['alpha', 'beta']) await seed(path.join(home, '.agents/skills', name), name);
    const config = path.join(home, 'setup-commit.json');
    await fs.writeFile(config, JSON.stringify({ home, phase: 'setup-commit' }));
    let stderr = '';
    const stopped = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../fixtures/restore-crash-child.mjs', import.meta.url)), config], { stdio: ['ignore', 'ignore', 'pipe'] });
      child.stderr.on('data', chunk => { stderr += chunk; }); child.on('error', reject); child.on('exit', (code, signal) => resolve({ code, signal }));
    });
    assert.equal(stopped.signal, 'SIGKILL', stderr);
    const originalCatalog = JSON.parse(await fs.readFile(paths.catalog, 'utf8'));
    assert.equal(originalCatalog.length, 2);
    for (const skill of originalCatalog) await fs.writeFile(path.join(home, '.agents/skills', skill.name, 'SKILL.md'), `---\nname: ${skill.name}\ndescription: Edited after commit\n---\nKeep the new ${skill.name} bytes.\n`);
    const resumed = createSkillsService(paths);
    await resumed.recover();
    assert.deepEqual((await resumed.list()).map(skill => skill.contentState), ['changed', 'changed']);
    assert.equal((await resumed.restorePreview()).issues.length, 2);
    const journalFile = path.join(paths.operations, (await fs.readdir(paths.operations))[0]!);
    assert.equal(JSON.parse(await fs.readFile(journalFile, 'utf8')).committed, true);
    const first = await resumed.acceptChanges(originalCatalog[0].id);
    assert.equal(first.ok, true);
    assert.equal(first.skills.find(skill => skill.id === originalCatalog[0].id)?.contentState, 'ready');
    assert.equal(first.skills.find(skill => skill.id === originalCatalog[1].id)?.contentState, 'changed');
    assert.equal((await resumed.restorePreview()).issues.length, 1);
    await assert.rejects(resumed.disable(originalCatalog[0].id), /Review beta with Keep current files/);
    const reviewBulk = await resumed.bulk('disable', [originalCatalog[0].id]);
    assert.equal(reviewBulk.issues[0]?.path, originalCatalog[0].name);
    assert.match(reviewBulk.issues[0]!.message, /Review beta with Keep current files/);
    const second = await resumed.bulk('keep', originalCatalog.map((skill: { id: string }) => skill.id));
    assert.deepEqual(second.failedIds, []);
    assert.equal(second.ok, true);
    assert.ok(second.skills.every(skill => skill.contentState === 'ready'));
    assert.deepEqual(await fs.readdir(paths.operations), []);
    assert.equal((await resumed.disable(originalCatalog[0].id)).ok, true);
    const preview = await resumed.restorePreview();
    assert.deepEqual(preview.issues, []);
    assert.equal((await resumed.restoreApply(preview.previewId)).ok, true);
    const hashes = [];
    for (const skill of second.skills) {
      const restored = path.join(home, '.agents/skills', skill.name);
      const exported = path.join(preview.backupPath, skill.linkName);
      assert.equal(await treeHash(restored), skill.contentHash); assert.equal(await treeHash(exported), skill.contentHash);
      assert.match(await fs.readFile(path.join(restored, 'SKILL.md'), 'utf8'), /Edited after commit/);
      hashes.push({ name: skill.name, restored: await treeHash(restored), exported: await treeHash(exported) });
    }
    await record('committed-edits-results.json', { stopped, physicallyResolvedHome: home, committedStatePersistedBeforeReview: true, sequentialKeepCurrentFilesSucceeded: true, noPendingOperations: true, hashes });
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});

test('repository imports keep safe candidates and cancellation stops stalled Git helpers', async () => {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'skills-network-')));
  const paths = resolvePaths(home), service = createSkillsService(paths), run = promisify(execFile);
  const repository = path.join(home, 'owner/repository');
  const portServer = createServer();
  await new Promise<void>(resolve => portServer.listen(0, '127.0.0.1', resolve));
  const address = portServer.address(); assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((resolve, reject) => portServer.close(error => error ? reject(error) : resolve()));
  let daemon: ReturnType<typeof spawn> | undefined;
  let staged: Awaited<ReturnType<typeof stageImport>> | undefined;
  const additionalStages: Awaited<ReturnType<typeof stageImport>>[] = [];
  const controller = new AbortController();
  const initialTemporary = (await fs.readdir(os.tmpdir())).filter(name => name.startsWith('skills-manager-import-')).sort();
  let requestDeadline: ReturnType<typeof setTimeout> | undefined;
  let requestSeen!: () => void;
  const requested = new Promise<void>(resolve => { requestSeen = resolve; });
  const stalled = createServer(() => requestSeen());
  const helpers = async () => (await run('/bin/ps', ['-axo', 'pid=,pgid=,stat=,comm='])).stdout.split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line);
    return match && /git-remote-http/.test(match[4]!) && !match[3]!.startsWith('Z') ? [{ pid: Number(match[1]), group: Number(match[2]) }] : [];
  });
  let cancellation: Promise<Awaited<ReturnType<typeof stageImport>>> | undefined;
  try {
    for (const name of ['notes', 'internal-local', 'unsafe']) await seed(path.join(repository, name), name);
    await fs.writeFile(path.join(repository, 'notes/SKILL.md'), '# Notes\nNo frontmatter required.\n');
    await fs.writeFile(path.join(repository, 'internal-local/SKILL.md'), '---\nname: internal-local\nmetadata:\n  internal: true\n---\nOptional description.\n');
    await fs.symlink('../../outside', path.join(repository, 'unsafe/escaped'));
    await seed(path.join(home, 'external-skill'), 'external-skill');
    await fs.symlink(path.join(home, 'external-skill'), path.join(repository, 'linked-outside'));
    await run('/usr/bin/git', ['init', repository]);
    await run('/usr/bin/git', ['-C', repository, 'add', '.']);
    await run('/usr/bin/git', ['-C', repository, '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Skills Test', '-c', 'user.email=skills-test@localhost', 'commit', '-m', 'Owned import fixture']);
    const rootRepository = path.join(home, 'owner/My-Skill');
    await fs.mkdir(rootRepository, { recursive: true }); await fs.writeFile(path.join(rootRepository, 'SKILL.md'), '# Root skill\nUse the repository name.\n');
    await run('/usr/bin/git', ['init', rootRepository]);
    await run('/usr/bin/git', ['-C', rootRepository, 'add', '.']);
    await run('/usr/bin/git', ['-C', rootRepository, '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Skills Test', '-c', 'user.email=skills-test@localhost', 'commit', '-m', 'Owned root skill fixture']);
    daemon = spawn('/usr/bin/git', ['daemon', '--reuseaddr', '--export-all', '--listen=127.0.0.1', `--port=${port}`, `--base-path=${home}`, '--verbose'], { stdio: ['ignore', 'ignore', 'pipe'] });
    await new Promise<void>((resolve, reject) => { daemon!.once('error', reject); daemon!.once('exit', () => reject(new Error('Fixture Git server stopped.'))); daemon!.stderr!.on('data', chunk => { if (String(chunk).includes('Ready to rumble')) resolve(); }); });
    const branch = (await run('/usr/bin/git', ['-C', repository, 'branch', '--show-current'])).stdout.trim();
    staged = await stageImport(`git://127.0.0.1:${port}/owner/repository#${branch}`, paths);
    assert.deepEqual(new Set(Object.values(staged.origins).map(origin => origin.path)), new Set(['notes', 'internal-local']));
    assert.equal(staged.revision, branch);
    const skipped = staged.issues;
    assert.ok(skipped.every(issue => !issue.path.includes('skills-manager-import-') && !issue.message.includes('skills-manager-import-')));
    assert.ok(skipped.some(issue => issue.path === 'unsafe'));
    assert.ok(staged.issues.some(issue => issue.path === 'linked-outside'));
    const preview = await service.previewImport(staged.root, { path: '.', repository: staged.source, revision: staged.revision, subpath: staged.subpath }, undefined, staged.origins);
    assert.deepEqual(new Set(preview.skills.map(skill => skill.name)), new Set(['notes', 'internal-local']));
    const added = await service.applyImport({ previewId: preview.previewId, skillIds: preview.skills.map(skill => skill.id), destinations: ['agents'] });
    assert.equal(added.ok, true, JSON.stringify(added.issues));
    await staged.cleanup(); staged = undefined;
    const rootStage = await stageImport(`skills add git://127.0.0.1:${port}/owner/My-Skill --skill my-skill`, paths);
    additionalStages.push(rootStage);
    const rootPreview = await service.previewImport(rootStage.root, { path: '.', repository: rootStage.source, revision: rootStage.revision }, undefined, rootStage.origins);
    assert.equal(rootPreview.skills[0]!.name, 'My-Skill');
    await assert.rejects(fs.lstat(path.join(rootPreview.skills[0]!.realPath, '.git')), { code: 'ENOENT' });
    const repeatedRoot = await stageImport(`git://127.0.0.1:${port}/owner/My-Skill`, paths);
    additionalStages.push(repeatedRoot);
    const repeatedRootPreview = await service.previewImport(repeatedRoot.root, { path: '.', repository: repeatedRoot.source, revision: repeatedRoot.revision }, undefined, repeatedRoot.origins);
    assert.equal(repeatedRootPreview.skills[0]!.contentHash, rootPreview.skills[0]!.contentHash);
    await repeatedRoot.cleanup();
    const rootAdded = await service.applyImport({ previewId: rootPreview.previewId, skillIds: rootPreview.skills.map(skill => skill.id), destinations: ['agents'] });
    assert.equal(rootAdded.ok, true, JSON.stringify(rootAdded.issues)); await rootStage.cleanup();
    const commit = (await run('/usr/bin/git', ['-C', rootRepository, 'rev-parse', 'HEAD'])).stdout.trim();
    const committed = await stageImport(`git://127.0.0.1:${port}/owner/My-Skill#${commit}`, paths);
    additionalStages.push(committed);
    const committedPreview = await service.previewImport(committed.root, { path: '.', repository: committed.source, revision: committed.revision }, undefined, committed.origins);
    assert.equal(committedPreview.skills[0]!.name, 'My-Skill');
    const commitAdded = await service.applyImport({ previewId: committedPreview.previewId, skillIds: committedPreview.skills.map(skill => skill.id), destinations: ['agents'] });
    assert.equal(commitAdded.ok, true, JSON.stringify(commitAdded.issues));
    assert.ok(commitAdded.skills.some(skill => skill.sources.some(record => record.path === '.' && record.revision === commit && record.repository === committed.source)));
    await committed.cleanup();
    await assert.rejects(stageImportTrees(path.join(rootRepository, 'skilsl'), path.join(home, 'missing-stage'), paths, [], undefined, rootRepository), /^Error: This folder is not in the repository\.$/);
    await fs.symlink('/', path.join(rootRepository, 'docs'));
    await assert.rejects(stageImportTrees(path.join(rootRepository, 'docs'), path.join(home, 'escaped-stage'), paths, [], undefined, rootRepository), /Import folder leaves its repository/);
    await assert.rejects(fs.lstat(path.join(home, 'escaped-stage')), { code: 'ENOENT' });
    const restore = await service.restorePreview();
    assert.equal((await service.restoreApply(restore.previewId)).ok, true);
    const hashes = await Promise.all(rootAdded.skills.map(async skill => { const actual = await treeHash(path.join(restore.backupPath, skill.linkName)); assert.equal(actual, skill.contentHash); return { name: skill.name, expected: skill.contentHash, exported: actual }; }));
    const scanSource = path.join(home, 'large-source'); await fs.mkdir(scanSource);
    await Promise.all(Array.from({ length: 1200 }, (_, index) => fs.mkdir(path.join(scanSource, `collection-${index}`))));
    const scanController = new AbortController(), scanStarted = Date.now();
    const scanDeadline = setTimeout(() => scanController.abort(), 10);
    try { await assert.rejects(stageImport(scanSource, paths, scanController.signal), /Import canceled/); } finally { clearTimeout(scanDeadline); }
    const scanCancelMilliseconds = Date.now() - scanStarted; assert.ok(scanCancelMilliseconds < 5000);
    await new Promise<void>(resolve => stalled.listen(0, '127.0.0.1', resolve));
    const stalledAddress = stalled.address(); assert.ok(stalledAddress && typeof stalledAddress !== 'string');
    const before = await helpers();
    cancellation = stageImport(`http://127.0.0.1:${stalledAddress.port}/stalled/repository`, paths, controller.signal);
    // Observe the real Git HTTP helper before cancelling its import group.
    void cancellation.catch(() => undefined);
    requestDeadline = setTimeout(() => { controller.abort(); requestSeen(); }, 5000);
    await requested; clearTimeout(requestDeadline);
    const active = (await helpers()).filter(helper => !before.some(old => old.pid === helper.pid));
    assert.ok(active.length > 0, 'The stalled request must use a real Git HTTP helper.');
    const started = Date.now(); controller.abort();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try { await assert.rejects(Promise.race([cancellation, new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error('Cancellation did not settle.')), 5000); })]), /Import canceled/); }
    finally { clearTimeout(deadline); }
    const elapsed = Date.now() - started;
    const remaining = (await helpers()).filter(helper => active.some(old => old.pid === helper.pid));
    assert.deepEqual(remaining, []);
    const temporary = (await fs.readdir(os.tmpdir())).filter(name => name.startsWith('skills-manager-import-')).sort();
    assert.deepEqual(temporary, initialTemporary);
    await record('repository-import-results.json', { ok: true, ownRepositoryDownloaded: true, rootRepositoryFallbackAndFilter: 'My-Skill', repeatedRootTreeHashStableWithoutGitMetadata: true, escapedSubpathBlockedBeforeStaging: true, scanCancelMilliseconds, originalSourceLabels: true, repositoryRelativeLabelsWithRevision: true, commitReference: commit, missingSubpathMessage: 'This folder is not in the repository.', skipped, stagingFoldersAfter: temporary, optionalMetadataPreserved: true, hashes, helperProcessesBeforeCancel: active, helperProcessesAfterCancel: remaining, cancelMilliseconds: elapsed });
  } finally {
    clearTimeout(requestDeadline); controller.abort(); stalled.closeAllConnections();
    await new Promise<void>(resolve => stalled.close(() => resolve()));
    await cancellation?.then(result => result.cleanup(), () => undefined);
    if (daemon?.exitCode === null) { const stopped = new Promise<void>(resolve => daemon!.once('exit', () => resolve())); daemon.kill('SIGTERM'); await stopped; }
    await staged?.cleanup();
    for (const extra of additionalStages) await extra.cleanup();
    await fs.rm(home, { recursive: true, force: true });
  }
});
