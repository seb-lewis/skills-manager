import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSkillsService } from '../../src/main/service';
import { resolvePaths } from '../../src/main/paths';
import { stageImportTrees } from '../../src/main/import';

test('destination edits preserve content, remove old aliases, and reject occupied locations without changes', async () => {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'skills-core-')));
  try {
    const paths = resolvePaths(home);
    const agents = path.join(home, '.agents/skills');
    const claude = path.join(home, '.claude/skills');
    const pi = path.join(home, '.pi/agent/skills');
    const codex = path.join(home, '.codex/skills');
    const opencode = path.join(home, '.config/opencode/skills');
    await fs.mkdir(path.join(agents, 'sample'), { recursive: true });
    await fs.writeFile(path.join(agents, 'sample/SKILL.md'), '---\nname: sample\n---\nKeep all content');
    await fs.mkdir(codex, { recursive: true });
    await fs.symlink(path.join(agents, 'sample'), path.join(codex, 'old-name'));
    const service = createSkillsService(paths);
    const preview = await service.setupPreview();
    const applied = await service.setupApply({ previewId: preview.previewId, skillIds: preview.skills.map(s => s.id), destinations: ['claude'] });
    assert.equal(applied.ok, true);
    const skill = applied.skills[0]!;
    await fs.symlink(skill.canonicalPath, path.join(agents, 'other-name'));
    await fs.mkdir(pi, { recursive: true });
    await fs.writeFile(path.join(pi, skill.linkName), 'Unrelated file');
    const before = await fs.readFile(paths.catalog, 'utf8');
    assert.equal((await service.setDestinations(skill.id, ['claude', 'pi'])).ok, false);
    assert.equal(await fs.readFile(paths.catalog, 'utf8'), before);
    assert.equal(await fs.readlink(path.join(agents, 'other-name')), skill.canonicalPath);
    assert.equal(await fs.readlink(path.join(codex, 'old-name')), skill.canonicalPath);
    assert.equal(await fs.readFile(path.join(pi, skill.linkName), 'utf8'), 'Unrelated file');
    await fs.mkdir(opencode, { recursive: true });
    await fs.symlink(skill.canonicalPath, path.join(opencode, skill.linkName));
    await fs.unlink(path.join(agents, 'other-name'));
    await fs.writeFile(path.join(paths.operations, 'interrupted-destinations.json'), JSON.stringify({
      kind: 'destinations', id: 'interrupted-destinations', skillId: skill.id, committed: false, catalogBefore: before, catalogAfter: null,
      links: [{ file: path.join(opencode, skill.linkName), target: skill.canonicalPath }],
      removedLinks: [{ file: path.join(agents, 'other-name'), target: skill.canonicalPath, verifiedCanonical: skill.canonicalPath }],
    }));
    await service.recover();
    assert.equal(await fs.readFile(paths.catalog, 'utf8'), before);
    assert.equal(await fs.readlink(path.join(agents, 'other-name')), skill.canonicalPath);
    await assert.rejects(fs.lstat(path.join(opencode, skill.linkName)), { code: 'ENOENT' });
    const changed = await service.setDestinations(skill.id, ['claude', 'opencode', 'opencode']);
    assert.equal(changed.ok, true, JSON.stringify(changed.issues));
    assert.deepEqual(changed.skills[0]?.destinations, ['claude', 'opencode']);
    for (const file of [path.join(agents, 'sample'), path.join(agents, 'other-name'), path.join(codex, 'old-name')]) await assert.rejects(fs.lstat(file), { code: 'ENOENT' });
    assert.equal(await fs.readlink(path.join(opencode, 'sample')), skill.canonicalPath);
    assert.equal((await service.setDestinations(skill.id, ['claude', 'opencode'])).ok, true);
    await service.disable(skill.id);
    await fs.symlink(skill.canonicalPath, path.join(codex, 'stray'));
    const disabled = await service.setDestinations(skill.id, ['agents']);
    assert.equal(disabled.ok, true);
    assert.equal(disabled.skills[0]?.enabled, false);
    await assert.rejects(fs.lstat(path.join(agents, 'sample')), { code: 'ENOENT' });
    await assert.rejects(fs.lstat(path.join(codex, 'stray')), { code: 'ENOENT' });
    assert.equal((await service.enable(skill.id)).ok, true);
    assert.equal(await fs.readlink(path.join(agents, 'sample')), skill.canonicalPath);
    const empty = await service.setDestinations(skill.id, []);
    assert.equal(empty.ok, true);
    assert.equal(empty.skills[0]?.enabled, false);
    assert.deepEqual(empty.skills[0]?.destinations, []);
    assert.equal((await service.enable(skill.id)).ok, false);
    assert.equal((await service.setDestinations(skill.id, [])).ok, true);
    assert.match(await fs.readFile(path.join(skill.canonicalPath, 'SKILL.md'), 'utf8'), /Keep all content/);
    assert.equal(await fs.readFile(path.join(pi, skill.linkName), 'utf8'), 'Unrelated file');
    await assert.rejects(service.setDestinations(skill.id, ['unknown']), /destination/i);
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});

test('content state describes disk files and missing-record removal never deletes restored content', async () => {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'skills-core-')));
  try {
    const paths = resolvePaths(home);
    const root = path.join(home, '.agents/skills');
    for (const name of ['healthy', 'missing', 'no-instructions', 'changed', 'restored']) {
      await fs.mkdir(path.join(root, name), { recursive: true });
      await fs.writeFile(path.join(root, name, 'SKILL.md'), `---\nname: ${name}\n---\nOriginal ${name}`);
    }
    const service = createSkillsService(paths);
    const preview = await service.setupPreview();
    const result = await service.setupApply({ previewId: preview.previewId, skillIds: preview.skills.map(skill => skill.id), destinations: [] });
    assert.equal(result.ok, true);
    const healthy = result.skills.find(skill => skill.name === 'healthy');
    const missing = result.skills.find(skill => skill.name === 'missing');
    const noInstructions = result.skills.find(skill => skill.name === 'no-instructions');
    const changed = result.skills.find(skill => skill.name === 'changed');
    const restored = result.skills.find(skill => skill.name === 'restored');
    assert.ok(healthy && missing && noInstructions && changed && restored);
    await fs.rm(missing.canonicalPath, { recursive: true });
    await fs.unlink(path.join(noInstructions.canonicalPath, 'SKILL.md'));
    await fs.writeFile(path.join(changed.canonicalPath, 'SKILL.md'), 'Changed bytes');
    await fs.rm(restored.canonicalPath, { recursive: true });
    const catalog = JSON.parse(await fs.readFile(paths.catalog, 'utf8'));
    for (const skill of catalog) skill.contentState = 'ready';
    await fs.writeFile(paths.catalog, JSON.stringify(catalog));
    const beforeReads = await fs.readFile(paths.catalog, 'utf8');

    const summaries = await service.list();
    assert.equal(summaries.find(skill => skill.id === healthy.id)?.contentState, 'ready');
    assert.equal(summaries.find(skill => skill.id === missing.id)?.contentState, 'missing');
    assert.equal(summaries.find(skill => skill.id === noInstructions.id)?.contentState, 'invalid');
    assert.equal(summaries.find(skill => skill.id === changed.id)?.contentState, 'changed');
    const detail = await service.detail(missing.id);
    assert.equal(detail.contentState, 'missing');
    assert.equal(detail.markdown, '');
    assert.equal(detail.issues[0]?.message, 'Skill folder is missing.');
    assert.equal((await service.detail(noInstructions.id)).contentState, 'invalid');
    assert.equal((await service.enable(missing.id)).ok, false);
    assert.equal(await fs.readFile(paths.catalog, 'utf8'), beforeReads);
    assert.equal((await service.removeMissing(healthy.id)).ok, false);
    assert.equal((await service.removeMissing(noInstructions.id)).ok, false);
    await fs.mkdir(restored.canonicalPath);
    await fs.writeFile(path.join(restored.canonicalPath, 'keep'), 'Restored bytes');
    assert.equal((await service.removeMissing(restored.id)).ok, false);
    assert.equal(await fs.readFile(path.join(restored.canonicalPath, 'keep'), 'utf8'), 'Restored bytes');
    assert.equal(await fs.readlink(path.join(root, 'restored')), restored.canonicalPath);
    await fs.writeFile(path.join(root, 'unrelated'), 'Keep this');
    await fs.symlink(missing.canonicalPath, path.join(root, 'missing-alias'));
    const removed = await service.removeMissing(missing.id);
    assert.equal(removed.ok, true, JSON.stringify(removed.issues));
    assert.equal(removed.skills.length, 4);
    assert.equal(removed.skills.some(skill => skill.id === missing.id), false);
    await assert.rejects(fs.lstat(path.join(root, 'missing')), { code: 'ENOENT' });
    await assert.rejects(fs.lstat(path.join(root, 'missing-alias')), { code: 'ENOENT' });
    assert.equal(await fs.readFile(path.join(root, 'unrelated'), 'utf8'), 'Keep this');
    assert.match(await fs.readFile(path.join(healthy.canonicalPath, 'SKILL.md'), 'utf8'), /Original healthy/);
    const persisted = JSON.parse(await fs.readFile(paths.catalog, 'utf8'));
    assert.ok(persisted.every((skill: { enabled: boolean; contentState?: string }) => skill.enabled && !('contentState' in skill)));
    assert.equal((await service.disable(changed.id)).ok, true);
    assert.equal(await fs.readFile(path.join(changed.canonicalPath, 'SKILL.md'), 'utf8'), 'Changed bytes');
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});

test('broken link repair restores verified skills and preserves changed entries and missing records', async () => {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'skills-core-')));
  try {
    const paths = resolvePaths(home);
    const root = path.join(home, '.agents/skills');
    for (const name of ['healthy', 'missing', 'disabled']) {
      await fs.mkdir(path.join(root, name), { recursive: true });
      await fs.writeFile(path.join(root, name, 'SKILL.md'), `---\nname: ${name}\n---\n${name}`);
    }
    const alias = path.join(root, 'recorded-alias');
    await fs.symlink('healthy', alias);
    const service = createSkillsService(paths);
    const setup = await service.setupPreview();
    const applied = await service.setupApply({ previewId: setup.previewId, skillIds: setup.skills.map(skill => skill.id), destinations: [] });
    assert.equal(applied.ok, true, JSON.stringify(applied.issues));
    const healthy = applied.skills.find(skill => skill.name === 'healthy');
    const missing = applied.skills.find(skill => skill.name === 'missing');
    const disabled = applied.skills.find(skill => skill.name === 'disabled');
    assert.ok(healthy && missing && disabled);
    await service.disable(disabled.id);
    await fs.unlink(alias);
    await fs.symlink('wrong-dead-target', alias);
    await fs.unlink(path.join(root, 'healthy'));
    await fs.symlink('other-dead-target', path.join(root, 'healthy'));
    await fs.rm(missing.canonicalPath, { recursive: true });
    await fs.symlink('disabled-dead-target', path.join(root, 'disabled'));

    const outside = path.join(home, 'outside');
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'keep'), 'external bytes');
    await fs.symlink(outside, path.join(root, 'external'));
    await fs.writeFile(path.join(root, 'unrelated-file'), 'keep file');
    await fs.mkdir(path.join(root, 'unrelated-folder'));
    await fs.writeFile(path.join(root, 'unrelated-folder', 'keep'), 'keep folder');
    await fs.symlink('dead-support', path.join(root, 'unrelated-folder', 'support'));
    for (const name of ['stale-alive', 'stale-target', 'stale-file', 'stale-folder']) await fs.symlink('old-dead-target', path.join(root, name));
    const catalogBefore = await fs.readFile(paths.catalog, 'utf8');
    const preview = await service.setupPreview();
    assert.equal(preview.brokenLinks.find(link => link.path === alias)?.kind, 'restore');
    assert.equal(preview.brokenLinks.find(link => link.path === path.join(root, 'healthy'))?.kind, 'restore');
    assert.equal(preview.brokenLinks.find(link => link.path === path.join(root, 'missing'))?.kind, 'remove');
    assert.equal(preview.brokenLinks.find(link => link.path === path.join(root, 'disabled'))?.kind, 'remove');
    assert.equal(preview.brokenLinks.some(link => link.path.endsWith('/support')), false);
    for (const name of ['stale-alive', 'stale-target', 'stale-file', 'stale-folder']) await fs.unlink(path.join(root, name));
    await fs.symlink(outside, path.join(root, 'stale-alive'));
    await fs.symlink('different-dead-target', path.join(root, 'stale-target'));
    await fs.writeFile(path.join(root, 'stale-file'), 'new file');
    await fs.mkdir(path.join(root, 'stale-folder'));

    const repaired = await service.fixBrokenLinks(preview.previewId);
    assert.equal(repaired.ok, false);
    assert.deepEqual(repaired.issues.map(issue => path.basename(issue.path)).sort(), ['stale-alive', 'stale-file', 'stale-folder', 'stale-target']);
    assert.equal(await fs.realpath(alias), await fs.realpath(healthy.canonicalPath));
    assert.equal(await fs.realpath(path.join(root, 'healthy')), await fs.realpath(healthy.canonicalPath));
    await assert.rejects(fs.lstat(path.join(root, 'missing')), { code: 'ENOENT' });
    await assert.rejects(fs.lstat(path.join(root, 'disabled')), { code: 'ENOENT' });
    assert.ok(repaired.skills.find(skill => skill.id === missing.id)?.issues.length);
    assert.equal(repaired.skills.find(skill => skill.id === disabled.id)?.enabled, false);
    assert.equal(await fs.readFile(paths.catalog, 'utf8'), catalogBefore);
    assert.equal(await fs.readFile(path.join(outside, 'keep'), 'utf8'), 'external bytes');
    assert.equal(await fs.realpath(path.join(root, 'external')), await fs.realpath(outside));
    assert.equal(await fs.realpath(path.join(root, 'stale-alive')), await fs.realpath(outside));
    assert.equal(await fs.readlink(path.join(root, 'stale-target')), 'different-dead-target');
    assert.equal(await fs.readFile(path.join(root, 'stale-file'), 'utf8'), 'new file');
    assert.ok((await fs.stat(path.join(root, 'stale-folder'))).isDirectory());
    assert.equal(await fs.readFile(path.join(root, 'unrelated-file'), 'utf8'), 'keep file');
    assert.equal(await fs.readFile(path.join(root, 'unrelated-folder', 'keep'), 'utf8'), 'keep folder');
    assert.equal(await fs.readlink(path.join(root, 'unrelated-folder', 'support')), 'dead-support');
    assert.deepEqual((await service.fixBrokenLinks(preview.previewId)).issues, repaired.issues);

    const fresh = await service.setupPreview();
    assert.equal((await service.fixBrokenLinks(fresh.previewId)).ok, true);
    assert.equal((await service.fixBrokenLinks(fresh.previewId)).ok, true);
    assert.equal(await fs.readFile(paths.catalog, 'utf8'), catalogBefore);
    const imported = await service.previewImport(outside);
    assert.deepEqual(imported.brokenLinks, []);
    await assert.rejects(service.fixBrokenLinks(imported.previewId), /setup/i);
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});

test('setup, disable, enable and delete preserve unrelated files', async () => {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'skills-core-')));
  try {
    const root = path.join(home, '.agents/skills'); const source = path.join(root, 'sample');
    await fs.mkdir(source, { recursive: true }); await fs.writeFile(path.join(source, 'SKILL.md'), '---\nname: sample\ndescription: A sample\n---\nHello');
    await fs.writeFile(path.join(source, 'tool'), 'bytes'); await fs.chmod(path.join(source, 'tool'), 0o755); await fs.symlink('tool', path.join(source, 'alias'));
    const service = createSkillsService(resolvePaths(home)); const preview = await service.setupPreview();
    const result = await service.setupApply({ previewId: preview.previewId, skillIds: preview.skills.map(s => s.id), destinations: ['claude'] });
    assert.equal(result.ok, true, JSON.stringify(result.issues)); const skill = result.skills[0]; assert.ok(skill);
    assert.equal((await fs.lstat(source)).isSymbolicLink(), true);
    await fs.writeFile(path.join(root, 'unrelated'), 'keep'); await fs.symlink(skill.canonicalPath, path.join(root, 'other-alias'));
    assert.equal((await service.disable(skill.id)).ok, true); assert.equal(await fs.readFile(path.join(skill.canonicalPath, 'tool'), 'utf8'), 'bytes');
    await assert.rejects(fs.lstat(path.join(root, 'other-alias'))); assert.equal((await service.enable(skill.id)).ok, true);
    assert.equal((await service.delete(skill.id)).ok, true); await assert.rejects(fs.lstat(skill.canonicalPath)); assert.equal(await fs.readFile(path.join(root, 'unrelated'), 'utf8'), 'keep');
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});

test('setup consolidates a skill shared by two harness roots once', async () => {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'skills-core-')));
  try {
    const source = path.join(home, '.agents/skills/shared');
    await fs.mkdir(source, { recursive: true });
    await fs.writeFile(path.join(source, 'SKILL.md'), '---\nname: shared\n---\nShared');
    const claudeRoot = path.join(home, '.claude/skills');
    await fs.mkdir(claudeRoot, { recursive: true });
    await fs.symlink('../../.agents/skills/shared', path.join(claudeRoot, 'shared'));

    const service = createSkillsService(resolvePaths(home));
    const preview = await service.setupPreview();
    assert.equal(preview.skills.length, 1);
    const result = await service.setupApply({ previewId: preview.previewId, skillIds: preview.skills.map(s => s.id), destinations: [] });
    assert.equal(result.ok, true, JSON.stringify(result.issues));
    assert.equal((await fs.lstat(source)).isSymbolicLink(), true);
    assert.equal(await fs.realpath(path.join(claudeRoot, 'shared')), await fs.realpath(result.skills[0]!.canonicalPath));
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});

test('setup adopts an existing source alias before linking its destination', async () => {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'skills-core-')));
  try {
    const source = path.join(home, '.agents/skills/agents-sdk');
    await fs.mkdir(source, { recursive: true });
    await fs.writeFile(path.join(source, 'SKILL.md'), '---\nname: agents-sdk\n---\nShared');
    const claudeRoot = path.join(home, '.claude/skills');
    await fs.mkdir(claudeRoot, { recursive: true });
    const alias = path.join(claudeRoot, 'agents-sdk');
    await fs.symlink('../../.agents/skills/agents-sdk', alias);

    const service = createSkillsService(resolvePaths(home));
    const preview = await service.setupPreview();
    const result = await service.setupApply({ previewId: preview.previewId, skillIds: preview.skills.map(skill => skill.id), destinations: ['agents', 'claude'] });
    assert.equal(result.ok, true, JSON.stringify(result.issues));
    assert.equal(result.skills.length, 1);
    const canonicalPath = await fs.realpath(result.skills[0]!.canonicalPath);
    assert.equal(await fs.realpath(source), canonicalPath);
    assert.equal(await fs.realpath(alias), canonicalPath);
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});

test('disable does not remove a catalog source outside managed roots', async () => {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'skills-core-')));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'skills-outside-'));
  try {
    const source = path.join(home, '.agents/skills/sample');
    await fs.mkdir(source, { recursive: true });
    await fs.writeFile(path.join(source, 'SKILL.md'), '---\nname: sample\n---\nSample');
    const service = createSkillsService(resolvePaths(home));
    const preview = await service.setupPreview();
    const result = await service.setupApply({ previewId: preview.previewId, skillIds: preview.skills.map(skill => skill.id), destinations: [] });
    assert.equal(result.ok, true, JSON.stringify(result.issues));
    const externalAlias = path.join(outside, 'alias');
    await fs.symlink(result.skills[0]!.canonicalPath, externalAlias);
    const catalog = JSON.parse(await fs.readFile(resolvePaths(home).catalog, 'utf8'));
    catalog[0].sources.push({ path: externalAlias });
    await fs.writeFile(resolvePaths(home).catalog, JSON.stringify(catalog));

    assert.equal((await service.disable(result.skills[0]!.id)).ok, true);
    assert.equal((await fs.lstat(externalAlias)).isSymbolicLink(), true);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test('setup reports external skills without adopting their links or walking collections', async () => {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'skills-core-')));
  const externalHome = await fs.mkdtemp(path.join(os.tmpdir(), 'skills-outside-'));
  const outside = path.join(externalHome, '.cache');
  await fs.mkdir(outside);
  try {
    await fs.writeFile(path.join(outside, 'SKILL.md'), '---\nname: outside\n---\nOutside');
    const root = path.join(home, '.agents/skills');
    await fs.mkdir(root, { recursive: true });
    await fs.symlink(outside, path.join(root, 'outside'));
    await fs.symlink(outside, path.join(root, 'alias'));
    const broken = path.join(root, 'broken');
    await fs.symlink(path.join(home, 'missing'), broken);
    const collection = path.join(home, 'collection');
    await fs.mkdir(path.join(collection, 'nested'), { recursive: true });
    await fs.writeFile(path.join(collection, 'nested/SKILL.md'), '---\nname: nested\n---\nNested');
    await fs.symlink(collection, path.join(root, 'collection'));

    const service = createSkillsService(resolvePaths(home));
    const preview = await service.setupPreview();
    assert.equal(preview.skills.length, 1);
    const skill = preview.skills[0];
    assert.ok(skill);
    assert.equal(skill.external, true);
    assert.equal(skill.name, 'outside');
    assert.equal(skill.aliases.length, 1);
    assert.deepEqual(skill.issues, []);
    assert.deepEqual(preview.issues, [{ path: broken, message: 'Broken link.' }]);
    await assert.rejects(service.setupApply({ previewId: preview.previewId, skillIds: [skill.id], destinations: [] }), /Resolve skill issues first/);
    assert.deepEqual(await service.list(), []);
    assert.equal(await fs.readlink(path.join(root, 'outside')), outside);
    assert.equal(await fs.readlink(path.join(root, 'alias')), outside);
    assert.equal(await fs.readFile(path.join(outside, 'SKILL.md'), 'utf8'), '---\nname: outside\n---\nOutside');
    const staging = path.join(home, 'staging');
    const importIssues = await stageImportTrees(root, staging, resolvePaths(home), []);
    assert.ok(importIssues.issues.some(issue => /Skill link leaves the configured roots/.test(issue.message)));
    assert.deepEqual(await fs.readdir(staging), []);
    await fs.writeFile(path.join(outside, 'SKILL.md'), '---\nname: [broken\n---\n');
    assert.ok((await service.scan()).issues.some(issue => issue.path === skill.path));
    await fs.unlink(path.join(outside, 'SKILL.md'));
    await fs.symlink(path.join(collection, 'nested/SKILL.md'), path.join(outside, 'SKILL.md'));
    const unsafe = await service.scan();
    assert.equal(unsafe.skills[0]?.contentHash, '');
    assert.ok(unsafe.skills[0]?.issues.some(issue => issue.message.includes('Link leaves skill folder')));
    assert.notEqual(unsafe.skills[0]?.name, 'nested');
  } finally {
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(externalHome, { recursive: true, force: true });
  }
});

test('setup merges identical skills from separate harness folders', async () => {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'skills-core-')));
  try {
    const content = '---\nname: shared\ndescription: Same content\n---\nShared';
    const agentsSkill = path.join(home, '.agents/skills/shared-agents');
    const claudeSkill = path.join(home, '.claude/skills/shared-claude');
    await fs.mkdir(agentsSkill, { recursive: true });
    await fs.mkdir(claudeSkill, { recursive: true });
    await fs.writeFile(path.join(agentsSkill, 'SKILL.md'), content);
    await fs.writeFile(path.join(claudeSkill, 'SKILL.md'), content);

    const service = createSkillsService(resolvePaths(home));
    const preview = await service.setupPreview();
    assert.equal(preview.conflicts.length, 0);
    assert.equal(preview.duplicates.length, 1);
    assert.deepEqual(preview.duplicates[0]?.skillIds.sort(), preview.skills.map(skill => skill.id).sort());

    const result = await service.setupApply({ previewId: preview.previewId, skillIds: preview.skills.map(skill => skill.id), destinations: [] });
    assert.equal(result.ok, true, JSON.stringify(result.issues));
    assert.equal(result.skills.length, 1);
    assert.equal(result.skills[0]?.sources.length, 2);
    assert.equal((await fs.lstat(agentsSkill)).isSymbolicLink(), true);
    assert.equal((await fs.lstat(claudeSkill)).isSymbolicLink(), true);
    const canonicalPath = await fs.realpath(result.skills[0]!.canonicalPath);
    assert.equal(await fs.realpath(agentsSkill), canonicalPath);
    assert.equal(await fs.realpath(claudeSkill), canonicalPath);
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});

test('setup auto-merges identical copies within a name conflict', async () => {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'skills-core-')));
  try {
    const roots = [
      path.join(home, '.agents/skills/shared-one'),
      path.join(home, '.claude/skills/shared-two'),
      path.join(home, '.config/opencode/skills/shared-variant'),
    ];
    const same = '---\nname: shared\n---\nSame';
    const different = '---\nname: shared\n---\nDifferent';
    for (const folder of roots) await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(roots[0]!, 'SKILL.md'), same);
    await fs.writeFile(path.join(roots[1]!, 'SKILL.md'), same);
    await fs.writeFile(path.join(roots[2]!, 'SKILL.md'), different);

    const service = createSkillsService(resolvePaths(home));
    const preview = await service.setupPreview();
    assert.equal(preview.conflicts.length, 1);
    assert.equal(preview.duplicates.length, 1);
    const sameHash = preview.skills.find((skill) => skill.path === roots[0])?.contentHash;
    assert.ok(sameHash);
    const selected = preview.skills.filter((skill) => skill.contentHash === sameHash).map((skill) => skill.id);
    const result = await service.setupApply({ previewId: preview.previewId, skillIds: selected, destinations: [] });
    assert.equal(result.ok, true, JSON.stringify(result.issues));
    assert.equal(result.skills.length, 1);
    assert.equal(result.skills[0]?.sources.length, 2);
    assert.equal((await fs.lstat(roots[2]!)).isDirectory(), true);
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});

test('adopts the hyphenated store and reuses its canonical skill', async () => {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'skills-core-')));
  try {
    const paths = resolvePaths(home);
    const canonical = path.join(paths.skills, 'legacy-skill');
    const source = path.join(home, '.claude/skills/legacy-copy');
    await fs.mkdir(canonical, { recursive: true });
    await fs.mkdir(source, { recursive: true });
    const content = '---\nname: legacy\n---\nLegacy';
    await fs.writeFile(path.join(canonical, 'SKILL.md'), content);
    await fs.writeFile(path.join(source, 'SKILL.md'), content);
    await fs.mkdir(path.join(home, '.agents/skills'), { recursive: true });
    await fs.symlink('../../.skills-manager/skills/legacy-skill', path.join(home, '.agents/skills/legacy-skill'));

    const service = createSkillsService(paths);
    await service.recover();
    assert.equal((await service.list()).length, 1);
    const preview = await service.setupPreview();
    const result = await service.setupApply({ previewId: preview.previewId, skillIds: preview.skills.map((skill) => skill.id), destinations: ['claude'] });
    assert.equal(result.ok, true, JSON.stringify(result.issues));
    assert.equal(result.skills.length, 1);
    assert.equal(result.skills[0]?.canonicalPath, canonical);
    assert.equal((await fs.lstat(source)).isSymbolicLink(), true);
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});

test('setup reports different skills that share a destination link name', async () => {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'skills-core-')));
  try {
    const agentsSkill = path.join(home, '.agents/skills/shared-folder');
    const claudeSkill = path.join(home, '.claude/skills/shared-folder');
    await fs.mkdir(agentsSkill, { recursive: true });
    await fs.mkdir(claudeSkill, { recursive: true });
    await fs.writeFile(path.join(agentsSkill, 'SKILL.md'), '---\nname: agents-copy\n---\nAgents');
    await fs.writeFile(path.join(claudeSkill, 'SKILL.md'), '---\nname: claude-copy\n---\nClaude');

    const preview = await createSkillsService(resolvePaths(home)).setupPreview();
    assert.equal(preview.conflicts.length, 1);
    assert.deepEqual(preview.conflicts[0]?.reasons, ['link-name']);
    assert.equal(preview.conflicts[0]?.skillIds.length, 2);
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});

test('escaping links are rejected and destination conflicts roll setup back', async () => {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'skills-core-')));
  try {
    const source = path.join(home, '.agents/skills/sample'); await fs.mkdir(source, { recursive: true }); await fs.writeFile(path.join(source, 'SKILL.md'), '---\nname: sample\n---\nHello');
    await fs.symlink('/etc/passwd', path.join(source, 'escape')); const service = createSkillsService(resolvePaths(home));
    assert.equal((await service.setupPreview()).skills[0]?.issues.length, 1); await fs.unlink(path.join(source, 'escape'));
    const other = path.join(home, '.claude/skills/sample'); await fs.mkdir(other, { recursive: true }); await fs.writeFile(path.join(other, 'keep'), 'unrelated');
    const preview = await service.setupPreview(); const result = await service.setupApply({ previewId: preview.previewId, skillIds: preview.skills.map(s => s.id), destinations: ['claude'] });
    assert.equal(result.ok, false); assert.equal((await fs.lstat(source)).isDirectory(), true); assert.equal(await fs.readFile(path.join(other, 'keep'), 'utf8'), 'unrelated'); assert.deepEqual(await service.list(), []);
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});

test('recovery restores an original folder after interrupted replacement', async () => {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'skills-core-')));
  try {
    const paths = resolvePaths(home); const source = path.join(home, '.agents/skills/sample');
    const id = 'aabb'; const operation = '1234'; const target = path.join(paths.skills, id); const backup = path.join(path.dirname(source), `.skills-manager-${operation}-0.backup`);
    await fs.mkdir(backup, { recursive: true }); await fs.writeFile(path.join(backup, 'SKILL.md'), 'original');
    await fs.mkdir(target, { recursive: true }); await fs.writeFile(path.join(target, 'SKILL.md'), 'copy'); await fs.symlink(target, source);
    await fs.mkdir(paths.operations, { recursive: true });
    const reserved = await fs.lstat(target);
    await fs.writeFile(path.join(paths.operations, operation + '.json'), JSON.stringify({ id: operation, committed: false, catalogBefore: '[]', catalogAfter: null, createdFolders: [{ path: target, dev: reserved.dev, ino: reserved.ino }], links: [], skills: [{ id, canonicalPath: target, linkName: 'sample', sources: [{ path: source }], destinations: [] }], replacements: [{ source, backup, target }] }));
    const service = createSkillsService(paths); await service.recover(); await service.recover();
    assert.equal(await fs.readFile(path.join(source, 'SKILL.md'), 'utf8'), 'original'); await assert.rejects(fs.lstat(target));
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});

test('reuse verifies canonical bytes and failed imports restore links and catalog', async () => {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'skills-core-')));
  try {
    const paths = resolvePaths(home);
    const source = path.join(home, 'download/sample');
    await fs.mkdir(source, { recursive: true });
    await fs.chmod(source, 0o700);
    const markdown = '---\nname: sample\ndescription: Original\n---\nBody';
    await fs.writeFile(path.join(source, 'SKILL.md'), markdown);
    const service = createSkillsService(paths);
    async function importCopy(destinations: string[], name?: string) {
      const preview = await service.previewImport(path.dirname(source));
      return service.applyImport({ previewId: preview.previewId, skillIds: preview.skills.map(s => s.id), destinations,
        names: name ? preview.skills.map(s => ({ skillId: s.id, name })) : [] });
    }
    const first = await importCopy(['agents']);
    assert.equal(first.ok, true);
    const skill = first.skills[0]!;
    assert.equal(skill.canonicalPath, path.join(paths.skills, 'sample'));
    assert.notEqual(skill.id, 'sample');
    assert.equal((await fs.stat(skill.canonicalPath)).mode & 0o777, 0o700);
    await service.disable(skill.id);
    const before = await fs.readFile(paths.catalog, 'utf8');
    const blocked = path.join(home, '.pi/agent/skills/sample');
    await fs.mkdir(blocked, { recursive: true });
    await fs.writeFile(path.join(blocked, 'keep'), 'unrelated');
    const failed = await importCopy(['claude', 'pi']);
    assert.equal(failed.ok, false);
    assert.equal(await fs.readFile(paths.catalog, 'utf8'), before);
    await assert.rejects(fs.lstat(path.join(home, '.agents/skills/sample')));
    await assert.rejects(fs.lstat(path.join(home, '.claude/skills/sample')));
    assert.equal(await fs.readFile(path.join(skill.canonicalPath, 'SKILL.md'), 'utf8'), markdown);
    const renamedBlocked = path.join(home, '.pi/agent/skills/renamed');
    await fs.mkdir(renamedBlocked);
    assert.equal((await importCopy(['claude', 'pi'], 'renamed')).ok, false);
    assert.equal(await fs.readFile(paths.catalog, 'utf8'), before);
    assert.deepEqual(await fs.readdir(paths.skills), [skill.linkName]);
    const occupied = path.join(paths.skills, 'renamed');
    await fs.mkdir(occupied);
    await fs.writeFile(path.join(occupied, 'keep'), 'unrelated');
    assert.equal((await importCopy(['claude'], 'renamed')).ok, false);
    assert.equal(await fs.readFile(path.join(occupied, 'keep'), 'utf8'), 'unrelated');
    assert.equal(await fs.readFile(paths.catalog, 'utf8'), before);
    await fs.rm(occupied, { recursive: true });
    await assert.rejects(fs.lstat(path.join(home, '.claude/skills/renamed')));
    await fs.writeFile(path.join(skill.canonicalPath, 'SKILL.md'), 'damaged');
    assert.equal((await importCopy(['agents'])).ok, false);
    const setupSource = path.join(home, '.claude/skills/good-copy');
    await fs.cp(source, setupSource, { recursive: true });
    const setup = await service.setupPreview();
    const setupResult = await service.setupApply({ previewId: setup.previewId, skillIds: setup.skills.map(s => s.id), destinations: [] });
    assert.equal(setupResult.ok, false);
    assert.equal((await fs.lstat(setupSource)).isDirectory(), true);
    assert.equal(await fs.readFile(path.join(setupSource, 'SKILL.md'), 'utf8'), markdown);
    await fs.rm(setupSource, { recursive: true });
    assert.equal(await fs.readFile(path.join(source, 'SKILL.md'), 'utf8'), markdown);
    assert.equal(await fs.readFile(paths.catalog, 'utf8'), before);
    assert.ok((await service.list())[0]!.issues.length);
    await fs.writeFile(path.join(skill.canonicalPath, 'SKILL.md'), markdown);
    const enabled = await importCopy(['claude']);
    assert.equal(enabled.ok, true);
    assert.equal(enabled.skills[0]!.enabled, false);
    await service.enable(skill.id);
    const claudeLink = path.join(home, '.claude/skills/sample');
    await fs.unlink(claudeLink);
    const unlinked = (await service.list())[0]!;
    assert.deepEqual(unlinked.linkedDestinations, ['agents']);
    assert.deepEqual(unlinked.issues, [{ path: skill.canonicalPath, message: 'Some links are missing.' }]);
    assert.equal((await service.enable(skill.id)).ok, true);
    const outside = path.join(home, 'outside.md');
    await fs.writeFile(outside, 'Outside content must not appear');
    await fs.unlink(path.join(skill.canonicalPath, 'SKILL.md'));
    await fs.symlink(outside, path.join(skill.canonicalPath, 'SKILL.md'));
    const escaped = await service.detail(skill.id);
    assert.equal(escaped.markdown, '');
    assert.ok(escaped.issues.length);
    assert.equal(await fs.readFile(outside, 'utf8'), 'Outside content must not appear');
    await fs.rm(skill.canonicalPath, { recursive: true });
    const missing = (await service.list())[0]!;
    assert.equal(missing.enabled, true);
    assert.deepEqual(missing.linkedDestinations, []);
    assert.equal(missing.issues.length, 1);
    assert.equal(missing.issues[0]?.path, skill.canonicalPath);
    assert.equal(missing.contentState, 'missing');
    assert.equal(missing.issues[0]?.message, 'Skill folder is missing.');
    const missingDetail = await service.detail(skill.id);
    assert.equal(missingDetail.markdown, '');
    assert.ok(missingDetail.issues.length);
    assert.equal((await service.enable(skill.id)).ok, false);
    assert.equal((await service.disable(skill.id)).ok, true);
    assert.equal((await service.delete(skill.id)).ok, true);
    assert.deepEqual(await service.list(), []);
    assert.equal(await fs.readFile(path.join(blocked, 'keep'), 'utf8'), 'unrelated');
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});

test('renamed identical copies share one verified canonical and preserve metadata', async () => {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'skills-core-')));
  try {
    const sources = ['.agents/skills/one', '.claude/skills/two'].map(p => path.join(home, p));
    for (const source of sources) {
      await fs.mkdir(source, { recursive: true });
      await fs.writeFile(path.join(source, 'SKILL.md'), '---\nname: old # keep comment\ndescription: Keep this\n---\nBody');
      await fs.writeFile(path.join(source, 'run'), 'support');
      await fs.chmod(path.join(source, 'run'), 0o755);
    }
    const service = createSkillsService(resolvePaths(home));
    const preview = await service.setupPreview();
    const result = await service.setupApply({ previewId: preview.previewId, skillIds: preview.skills.map(s => s.id), destinations: [], names: preview.skills.map(s => ({ skillId: s.id, name: 'new-name' })) });
    assert.equal(result.ok, true, JSON.stringify(result.issues));
    assert.equal(result.skills.length, 1);
    const skill = result.skills[0]!;
    assert.match((await service.detail(skill.id)).markdown, /name: new-name/);
    assert.match((await service.detail(skill.id)).markdown, /description: Keep this/);
    assert.equal(await fs.readFile(path.join(skill.canonicalPath, 'run'), 'utf8'), 'support');
    assert.equal((await fs.stat(path.join(skill.canonicalPath, 'run'))).mode & 0o777, 0o755);
    assert.deepEqual((await service.list())[0]!.issues, []);
    for (const source of sources) assert.equal(await fs.realpath(source), await fs.realpath(skill.canonicalPath));
    assert.equal((await fs.readdir(service.paths.skills)).length, 1);
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});

test('different tree boundaries never discard a source during consolidation', async () => {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'skills-core-')));
  try {
    const a = path.join(home, '.agents/skills/one');
    const b = path.join(home, '.claude/skills/two');
    for (const source of [a, b]) {
      await fs.mkdir(source, { recursive: true });
      await fs.writeFile(path.join(source, 'SKILL.md'), '---\nname: same\n---\nBody');
    }
    await fs.writeFile(path.join(a, 'a.txt'), '["b.txt",420]filepayload', { mode: 0o644 });
    await fs.writeFile(path.join(b, 'a.txt'), '', { mode: 0o644 });
    await fs.writeFile(path.join(b, 'b.txt'), 'payload', { mode: 0o644 });
    const service = createSkillsService(resolvePaths(home));
    const preview = await service.setupPreview();
    assert.equal(preview.duplicates.length, 0);
    const result = await service.setupApply({ previewId: preview.previewId, skillIds: preview.skills.map(s => s.id), destinations: [], names: preview.skills.map((s, i) => ({ skillId: s.id, name: `copy-${i}` })) });
    assert.equal(result.ok, true, JSON.stringify(result.issues));
    assert.equal(result.skills.length, 2);
    assert.equal(await fs.readFile(path.join(a, 'a.txt'), 'utf8'), '["b.txt",420]filepayload');
    assert.equal(await fs.readFile(path.join(b, 'b.txt'), 'utf8'), 'payload');
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});

test('recovery rolls back reused links and recognizes a committed catalog', async () => {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'skills-core-')));
  try {
    const paths = resolvePaths(home);
    const source = path.join(home, '.agents/skills/sample');
    await fs.mkdir(source, { recursive: true });
    await fs.writeFile(path.join(source, 'SKILL.md'), '---\nname: sample\n---\nBody');
    const service = createSkillsService(paths);
    const preview = await service.setupPreview();
    const result = await service.setupApply({ previewId: preview.previewId, skillIds: preview.skills.map(s => s.id), destinations: [] });
    const skill = result.skills[0]!;
    const before = JSON.parse(await fs.readFile(paths.catalog, 'utf8'));
    const added = path.join(home, '.claude/skills/sample');
    await fs.mkdir(path.dirname(added), { recursive: true });
    await fs.symlink(skill.canonicalPath, added);
    const record = path.join(paths.operations, 'interrupted.json');
    await fs.writeFile(record, JSON.stringify({ id: 'interrupted', skills: [], createdFolders: [], replacements: [], links: [{ file: added, target: skill.canonicalPath }], catalogBefore: JSON.stringify(before), catalogAfter: null, committed: false }));
    await service.recover();
    await service.recover();
    await assert.rejects(fs.lstat(added));
    assert.equal((await fs.lstat(source)).isSymbolicLink(), true);
    assert.equal((await service.detail(skill.id)).markdown, '---\nname: sample\n---\nBody');
    const replacement = path.join(home, '.claude/skills/original');
    const backup = path.join(path.dirname(replacement), '.skills-manager-interrupted-0.backup');
    await fs.mkdir(backup);
    await fs.writeFile(path.join(backup, 'SKILL.md'), 'backup');
    await fs.symlink(skill.canonicalPath, replacement);
    const after = before.map((entry: { id: string }) => entry.id === skill.id ? { ...entry, sources: [...skill.sources, { path: replacement }] } : entry);
    await fs.writeFile(paths.catalog, JSON.stringify(after));
    await fs.writeFile(record, JSON.stringify({ id: 'interrupted', skills: [], createdFolders: [], replacements: [{ source: replacement, backup, target: skill.canonicalPath }], links: [], catalogBefore: JSON.stringify(before), catalogAfter: JSON.stringify(after), committed: false }));
    await service.recover();
    await service.recover();
    await assert.rejects(fs.lstat(backup));
    assert.equal((await fs.lstat(replacement)).isSymbolicLink(), true);
    assert.equal((await service.list()).length, 1);
    assert.deepEqual(await fs.readdir(paths.operations), []);
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});

test('setup preview keeps healthy skills when a configured root is broken', async () => {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'skills-core-')));
  try {
    await fs.mkdir(path.join(home, '.agents'), { recursive: true });
    await fs.symlink(path.join(home, 'missing'), path.join(home, '.agents/skills'));
    const source = path.join(home, '.claude/skills/healthy');
    await fs.mkdir(source, { recursive: true });
    await fs.writeFile(path.join(source, 'SKILL.md'), '---\nname: healthy\n---\nBody');
    const service = createSkillsService(resolvePaths(home));
    const preview = await service.setupPreview();
    assert.equal(preview.skills.length, 1);
    assert.equal(preview.skills[0]!.name, 'healthy');
    assert.ok(preview.issues.some(issue => issue.path === path.join(home, '.agents/skills')));
    const result = await service.setupApply({ previewId: preview.previewId, skillIds: preview.skills.map(s => s.id), destinations: [] });
    assert.equal(result.ok, true, JSON.stringify(result.issues));
    assert.equal((await fs.lstat(source)).isSymbolicLink(), true);
    assert.ok((await service.setupPreview()).issues.some(issue => issue.path === path.join(home, '.agents/skills')));
    await fs.unlink(path.join(home, '.agents/skills'));
    await fs.symlink(await fs.realpath(service.paths.skills), path.join(home, '.agents/skills'));
    const alias = path.join(home, 'home-alias');
    await fs.symlink(home, alias);
    const overlap = await createSkillsService(resolvePaths(alias)).setupPreview();
    assert.ok(overlap.issues.some(issue => issue.message.includes('Skill root overlaps the catalog')));
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});
