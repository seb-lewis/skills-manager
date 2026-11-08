import { spawn } from "node:child_process";
import { cp, mkdtemp, mkdir, rm, lstat, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, relative } from "node:path";
import { exists, scanRoots, treeHash } from './discovery';
import type { ImportOrigin } from '../shared/types';
import { writableDirectories } from './files';
import { skillFolderName, inside, type RuntimePaths } from './paths';

/** Validate original trees before copying any supporting file or link. */
export async function stageImportTrees(sourceRoot: string, root: string, paths: RuntimePaths, names: string[], signal?: AbortSignal, boundary = sourceRoot) {
  if (signal?.aborted) throw new Error('Import canceled.');
  const realBoundary = await realpath(boundary);
  let realSource: string;
  try { realSource = await realpath(sourceRoot); }
  catch (error) {
    if (boundary !== sourceRoot && error instanceof Error && 'code' in error && ['ENOENT', 'ENOTDIR'].includes(String(error.code))) throw new Error('This folder is not in the repository.');
    throw error;
  }
  if (!inside(realBoundary, realSource)) throw new Error('Import folder leaves its repository.');
  const scan = await scanRoots(paths, [{ id: 'import', name: 'Import', path: sourceRoot, writable: false, availableTo: [] }], 'repository', signal);
  const origins: Record<string, ImportOrigin> = {};
  const selected = scan.skills.filter((skill) => !names.length || names.includes('*') || names.some((name) => name.toLowerCase() === skill.name.toLowerCase()));
  for (const skill of selected) if (skillFolderName(skill.name) === 'plugins') skill.issues.push({ path: skill.path, message: 'This name is reserved. Rename this skill before importing.' });
  const issues = [...scan.issues, ...selected.flatMap(skill => skill.issues)];
  if (!selected.length && !issues.length) throw new Error('No skills found in this repository.');
  await mkdir(root);
  for (const [index, skill] of selected.filter(skill => !skill.issues.length).entries()) {
    if (signal?.aborted) throw new Error('Import canceled.');
    // Normalize only the copied folder name; preserve the complete skill tree.
    const target = join(root, String(index), skillFolderName(skill.name));
    await mkdir(join(root, String(index)));
    await cp(skill.realPath, target, { recursive: true, dereference: false, verbatimSymlinks: true, errorOnExist: true, force: false, filter: () => { if (signal?.aborted) throw new Error('Import canceled.'); return true; } });
    if (await treeHash(target, signal) !== skill.contentHash) throw new Error(`Import copy did not match: ${skill.name}`);
    origins[await realpath(target)] = { path: skill.path, name: skill.name };
  }
  return { issues, origins };
}

/** Read only the source and skill names. Pasted commands are never executed. */
export function parseImportSource(input: string): {
  source: string;
  skills: string[];
  url?: string;
  ref?: string;
  subpath?: string;
  localPath?: string;
} {
  const value = input.trim();
  if (!value) throw new Error("Enter a repository or a supported skills command.");
  if (isAbsolute(value)) return { source: value, skills: [], localPath: value };
  if (value.startsWith('~/')) { const localPath = resolve(process.env.SKILLS_MANAGER_HOME || homedir(), value.slice(2)); return { source: localPath, skills: [], localPath }; }
  if (/[\n\r`;|&<>$\\]/.test(value)) throw new Error('Enter a repository or a supported skills command.');
  if (value.startsWith("https://skills.sh/")) {
    const url = new URL(value);
    const parts = url.pathname.split("/").filter(Boolean);
    if (
      url.hostname !== "skills.sh" ||
      parts.length !== 3 ||
      url.search ||
      url.hash ||
      parts.some((part) => !/^[\w.-]+$/.test(part))
    )
      throw new Error("Use a skills.sh skill page link.");
    return parseImportSource(`${parts[0]}/${parts[1]}@${parts[2]}`);
  }
  const tokens =
    value
      .match(/"[^"\n]*"|'[^'\n]*'|[^\s]+/g)
      ?.map((token) => token.replace(/^(['"])(.*)\1$/, "$2")) ?? [];
  if (tokens.some(token => /["']/.test(token))) throw new Error('Close quoted names and paths.');
  if (tokens[0] === "npx") {
    tokens.shift();
    if (["-y", "--yes"].includes(tokens.at(0) ?? "")) tokens.shift();
  }
  if (/^skills(?:@[\w.-]+)?$/.test(tokens[0] ?? "")) {
    tokens.shift();
    if (tokens.shift() !== "add")
      throw new Error("Only skills add commands are supported.");
  }
  const source = tokens.shift();
  if (!source) throw new Error('Enter a repository or local folder.');
  const skills: string[] = [];
  while (tokens.length) {
    const flag = tokens.shift();
    if (flag !== "--skill" && flag !== "-s")
      throw new Error(`Unsupported command option: ${flag}`);
    let count = 0;
    while (tokens.length && !tokens[0]!.startsWith('-')) {
      const name = tokens.shift()!;
      if (name !== '*' && !/^[\w. -]+$/.test(name)) throw new Error('Enter a valid skill name.');
      skills.push(name); count++;
    }
    if (!count) throw new Error('Enter a valid skill name.');
  }
  if (source.startsWith('~/')) { const localPath = resolve(process.env.SKILLS_MANAGER_HOME || homedir(), source.slice(2)); return { source: localPath, skills, localPath }; }
  if (isAbsolute(source) || source.startsWith('./') || source.startsWith('../') || source === '.' || source === '..') return { source, skills, localPath: resolve(source) };
  const [reference, fragment, ...extra] = source.split('#');
  if (extra.length) throw new Error('Enter a valid repository reference.');
  const [ref, fragmentSkill, ...extraFilters] = (fragment ?? '').split('@').map(decodeURIComponent);
  if (extraFilters.length || (ref && (ref.startsWith('-') || !/^[\w./-]+$/.test(ref)))) throw new Error('Enter a valid repository revision.');
  let repository = reference!.replace(/^github:/, '').replace(/^gitlab:/, 'https://gitlab.com/');
  if (repository.split('/').includes('..')) throw new Error('Invalid repository path.');
  const shorthand = /^([\w.-]+)\/([\w.-]+)(?:@([\w. -]+)|\/(.+))?$/.exec(repository);
  let subpath = shorthand?.[4];
  if (shorthand) {
    repository = `https://github.com/${shorthand[1]}/${shorthand[2]}`;
    if (shorthand[3] && !fragmentSkill) skills.push(shorthand[3]);
  }
  if (fragmentSkill) skills.push(fragmentSkill);
  let revision = ref || undefined;
  if (/^git@[\w.-]+:[\w./-]+$/.test(repository)) {
    if (repository.split('/').includes('..')) throw new Error('Invalid repository path.');
    return { source, skills, url: repository, ref: revision };
  }
  let url: URL;
  try { url = new URL(repository); } catch { throw new Error('Enter a repository URL or owner/repository.'); }
  if (!['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol) || url.password || url.search || url.hash || !url.hostname || !/^\/[\w./-]+$/.test(url.pathname)) throw new Error('Enter a valid Git repository URL.');
  const parts = url.pathname.split('/').filter(Boolean);
  const tree = url.hostname === 'github.com' ? parts.indexOf('tree', 2) : parts.indexOf('-');
  if (tree >= 0) {
    const refIndex = url.hostname === 'github.com' ? tree + 1 : tree + 2;
    if ((url.hostname !== 'github.com' && parts[tree + 1] !== 'tree') || !parts[refIndex]) throw new Error('Enter a repository tree URL.');
    revision = parts[refIndex]; subpath = parts.slice(refIndex + 1).join('/') || undefined;
    parts.splice(tree);
  }
  if (parts.length < 2 || parts.includes('..') || subpath?.split('/').some(part => part === '..' || part === '.')) throw new Error('Invalid repository path.');
  url.pathname = '/' + parts.join('/');
  return { source, skills, url: url.toString().replace(/\/$/, ''), ref: revision, subpath };
}

export async function stageImport(
  input: string,
  paths: RuntimePaths,
  signal?: AbortSignal,
) {
  const parsed = parseImportSource(input);
  const base = await mkdtemp(join(tmpdir(), "skills-manager-import-"));
  const project = join(base, "project");
  const home = join(base, "home");
  const identity = await lstat(base);
  const removeTemporary = async (folder: string) => {
    if (!await exists(base)) return;
    const current = await lstat(base);
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino || !inside(base, folder)) throw new Error('Temporary import folder changed.');
    if (await exists(folder) && (await lstat(folder)).isDirectory()) await writableDirectories(folder);
    await rm(folder, { recursive: true, force: true });
  };
  let cleanupTask: Promise<void> | undefined;
  const cleanup = () => {
    if (!cleanupTask) cleanupTask = removeTemporary(base).catch(error => { cleanupTask = undefined; throw error; });
    return cleanupTask;
  };
  try {
    await Promise.all([mkdir(project), mkdir(home), mkdir(join(base, "tmp"))]);
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_CACHE_HOME: join(home, ".cache"),
      XDG_DATA_HOME: join(home, ".local/share"),
      TMPDIR: join(base, "tmp"),
      CI: "1",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    };
    if (!parsed.localPath) await new Promise<void>((resolve, reject) => {
      const git = spawn("/usr/bin/git", ["--version"], {
        shell: false,
        env,
        stdio: "ignore",
      });
      git.once("error", () =>
        reject(
          new Error(
            "Install Git with the Apple Command Line Tools to import repositories.",
          ),
        ),
      );
      git.once("close", (code) =>
        code === 0
          ? resolve()
          : reject(
              new Error(
                "Install Git with the Apple Command Line Tools to import repositories.",
              ),
            ),
      );
    });
    const run = (executable: string, args: string[]) => new Promise<void>((resolve, reject) => {
      const child = spawn(
        executable,
        args,
        {
          cwd: project,
          env,
          shell: false,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let timedOut = false;
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => { stdout = (stdout + chunk).slice(-4000); });
      child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-4000); });
      const abort = () => {
        if (!child.pid) return;
        try { process.kill(-child.pid, 'SIGKILL'); }
        catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) reject(error); }
      };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      const timer = setTimeout(() => {
        timedOut = true;
        abort();
      }, 120_000);
      child.stdout.resume();
      child.stderr.resume();
      child.once("error", (error) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        reject(
          error.name === "AbortError"
            ? new Error("Import canceled.")
            : new Error(`Cannot start Git: ${error.message}`),
        );
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (signal?.aborted) reject(new Error('Import canceled.'));
        else if (timedOut)
          reject(
            new Error("Import timed out. Check your connection and try again."),
          );
        else if (code !== 0)
          reject(new Error([
            `Import failed with code ${code}.`,
            stderr.trim() || stdout.trim(),
          ].filter(Boolean).join(" ")));
        else resolve();
      });
    });
    // Download repositories without executing them; all imports use the same tree validator.
    const checkout = join(base, 'checkout');
    const repositoryName = parsed.url?.split(/[/:]/).at(-1)?.replace(/\.git$/, '') ?? '';
    const repository = join(checkout, repositoryName || 'unnamed-skill');
    if (!parsed.localPath) {
      await mkdir(checkout);
      if (/^[a-f0-9]{40}$/i.test(parsed.ref ?? '')) {
        await mkdir(repository);
        await run('/usr/bin/git', ['init', repository]);
        await run('/usr/bin/git', ['-C', repository, 'fetch', '--depth', '1', '--', parsed.url!, parsed.ref!.toLowerCase()]);
        await run('/usr/bin/git', ['-C', repository, 'checkout', '--detach', 'FETCH_HEAD']);
      } else await run('/usr/bin/git', ['clone', '--depth', '1', ...(parsed.ref ? ['--branch', parsed.ref] : []), '--', parsed.url!, repository]);
      await removeTemporary(join(repository, '.git'));
    }
    if (signal?.aborted) throw new Error('Import canceled.');
    const sourceRoot = parsed.localPath ?? join(repository, parsed.subpath ?? '');
    const root = join(base, 'skills');
    const staged = await stageImportTrees(sourceRoot, root, paths, parsed.skills, signal, parsed.localPath ?? repository);
    const repositoryReal = !parsed.localPath ? await realpath(repository) : '';
    const describe = (file: string) => parsed.localPath ? file : relative(repository, file) || '.';
    const issues = staged.issues.map(issue => ({ path: describe(issue.path), message: parsed.localPath ? issue.message : issue.message.replaceAll(repositoryReal, '.').replaceAll(repository, '.') }));
    const origins = Object.fromEntries(Object.entries(staged.origins).map(([file, original]) => [file, { ...original, path: describe(original.path) }]));
    await removeTemporary(checkout);
    return {
      root,
      issues,
      origins,
      source: parsed.url ?? parsed.source,
      revision: parsed.ref,
      subpath: parsed.subpath,
      localPath: parsed.localPath,
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
