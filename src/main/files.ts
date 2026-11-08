import fs from 'node:fs/promises';
import path from 'node:path';

// Call only after validating ownership of the containing tree. Never follow links.
export async function writableDirectories(folder: string): Promise<void> {
  const stat = await fs.lstat(folder);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Folder changed: ${folder}`);
  await fs.chmod(folder, stat.mode & 0o777 | 0o700);
  const entries = await fs.readdir(folder, { withFileTypes: true });
  for (const entry of entries) if (entry.isDirectory()) await writableDirectories(path.join(folder, entry.name));
}
