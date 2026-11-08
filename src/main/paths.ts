import os from 'node:os';
import path from 'node:path';
import type { Destination } from '../shared/types';
export interface RuntimePaths { home: string; store: string; skills: string; catalog: string; operations: string; staging: string; destinations: Destination[] }
export function resolvePaths(requestedHome?: string, env: NodeJS.ProcessEnv = process.env): RuntimePaths {
  const home = path.resolve(requestedHome || env.SKILLS_MANAGER_HOME || env.HOME || os.homedir());
  const store = path.join(home, '.skills-manager');
  const root = (id: string, name: string, folder: string, writable = true, availableTo = [name]): Destination => ({ id, name, path: path.resolve(folder), writable, availableTo });
  const isolated = Boolean(env.SKILLS_MANAGER_HOME) || home !== path.resolve(env.HOME || os.homedir());
  return { home, store, skills: path.join(store, 'skills'), catalog: path.join(store, 'catalog.json'), operations: path.join(store, 'operations'), staging: path.join(store, 'staging'), destinations: [
    root('agents', 'Shared Agents', path.join(home, '.agents/skills'), true, ['Codex', 'OpenCode']),
    root('claude', 'Claude Code', path.join(home, '.claude/skills'), true, ['Claude Code', 'OpenCode']),
    root('pi', 'Pi', path.join(home, '.pi/agent/skills')),
    root('opencode', 'OpenCode', path.join(!isolated && env.XDG_CONFIG_HOME || path.join(home, '.config'), 'opencode/skills')),
    root('codex', 'Codex', path.join(!isolated && env.CODEX_HOME || path.join(home, '.codex'), 'skills')),
  ] };
}
export function inside(root: string, target: string): boolean { const rel = path.relative(root, target); return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel)); }
export { validName } from '../shared/validation';
/** Normalize imported folder names for agent skill paths. */
export function skillFolderName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9._]+/g, '-').replace(/^[.\-]+|[.\-]+$/g, '').substring(0, 255) || 'unnamed-skill';
}
