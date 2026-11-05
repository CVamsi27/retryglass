import { mkdir, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { PACKAGE_ROOT } from './package-root.js';

const STARTER_FILES = [
  'scenario.json', 'scenario-buggy.json', 'schema.sql', 'seed.sql',
  'retry.test.ts', 'README.md', 'Dockerfile.worker', 'processor/example.js',
] as const;

export interface StarterResult { target: string; files: string[]; }

/** Copy reviewed synthetic templates only. No dependency, processor or container is executed. */
export async function initializeStarter(target: string): Promise<StarterResult> {
  if (typeof target !== 'string' || !target.trim() || target.includes('\0')) throw new Error('A non-empty new starter directory is required');
  if (target.split(/[\\/]/).includes('..')) throw new Error('Starter target must not contain path traversal');
  const destination = resolve(target);
  // Read the closed template list before creating anything. These package-owned inputs are small.
  const contents = await Promise.all(STARTER_FILES.map(file => readFile(join(PACKAGE_ROOT, 'templates', 'starter', file), 'utf8')));
  try { await mkdir(destination); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Starter target already exists; choose a new directory');
    throw new Error('Starter directory could not be created; its parent must exist and be writable');
  }
  const written: string[] = [];
  const directories: string[] = [];
  try {
    for (const [index, file] of STARTER_FILES.entries()) {
      const path = join(destination, file);
      if (dirname(file) !== '.') {
        const directory = dirname(path);
        await mkdir(directory);
        directories.push(directory);
      }
      await writeFile(path, contents[index]!, { encoding: 'utf8', flag: 'wx' });
      written.push(path);
    }
    return { target: destination, files: [...STARTER_FILES] };
  } catch {
    // Remove only the files we created; never recursively erase another writer's additions.
    let cleanupFailed = false;
    for (const path of written.reverse()) await unlink(path).catch(() => { cleanupFailed = true; });
    for (const path of directories.reverse()) await rmdir(path).catch(() => { cleanupFailed = true; });
    await rmdir(destination).catch(() => { cleanupFailed = true; });
    throw new Error(cleanupFailed ? 'Starter creation failed and cleanup was incomplete; inspect the selected target' : 'Starter creation failed; partial starter files were removed');
  }
}
