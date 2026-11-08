import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { StoredSkill } from '../shared/types';
import { exists } from './discovery';
export async function atomicJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  await fs.rename(temporary, file);
}
export async function readCatalog(file: string): Promise<StoredSkill[]> {
  if (!await exists(file)) return [];
  const parsed: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error('Invalid catalog');
  for (const item of parsed) {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !/^[a-f0-9-]+$/.test(item.id) || typeof item.canonicalPath !== 'string' || typeof item.linkName !== 'string' || !Array.isArray(item.sources) || !Array.isArray(item.destinations)) throw new Error('Invalid catalog entry');
  }
  return parsed.map(({ contentState: _observedState, ...stored }) => stored);
}
