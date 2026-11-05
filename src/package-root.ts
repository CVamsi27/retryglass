import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Walk up from `start` until a `package.json` that declares this package is found.
 *
 * Counting `../` segments does not work here: the same module lives at `src/package-root.ts` in a
 * checkout and at `dist/src/package-root.js` when built, so the depth differs. Reading the manifest
 * is layout-independent and works for a checkout, a packed install and a pnpm symlink farm alike.
 */
export function findPackageRoot(start: string): string {
  let directory = dirname(start);
  for (;;) {
    const manifest = join(directory, 'package.json');
    if (existsSync(manifest)) {
      try {
        const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: unknown };
        if (parsed.name === 'retryglass') return directory;
      } catch {
        // An unreadable manifest is not ours; keep walking rather than guessing.
      }
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error('Could not locate the retryglass package root (package.json with name "retryglass")');
}

/**
 * The retryglass package root, resolved from this module rather than from `process.cwd()`.
 *
 * The CLI needs its tool-image Dockerfile, its build context and its exported test templates on
 * disk, and the user's working directory is not where the package lives. Anything that reads a file
 * shipped with the package must go through this constant.
 */
export const PACKAGE_ROOT = findPackageRoot(fileURLToPath(import.meta.url));
