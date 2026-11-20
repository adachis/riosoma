import { lstatSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, resolve } from 'node:path';

/** A name Vitest gives its folders: 21 random characters from the URL-safe alphabet. */
const FOLDER_NAME = /^[\w-]{21}$/;

/** The part of the test project Vitest passes to a global setup that this file reads. */
export interface VitestOwner {
  vitest: object;
}

/**
 * Removes `folder` when it looks like the module cache Vitest makes for a run: an existing folder
 * with a 21-character name directly in the temporary folder.  Anything else is left alone, so a
 * changed or missing value can never remove the wrong thing.  Returns whether it removed the folder.
 */
export async function removeVitestTempDir(folder: unknown, root: string = tmpdir()): Promise<boolean> {
  if (typeof folder !== 'string' || !isAbsolute(folder)) return false;
  const path = resolve(folder);
  if (dirname(path) !== resolve(root) || !FOLDER_NAME.test(basename(path))) return false;
  if (!lstatSync(path, { throwIfNoEntry: false })?.isDirectory()) return false;
  await rm(path, { recursive: true, force: true });
  return true;
}

/**
 * Removes the module cache folder of the whole run when the run ends.  Vitest 5.0 copied modules for
 * its workers into `_tmpDir`, a folder in the temporary folder with `client` and `ssr` inside, and
 * removed only each project's own folder when it closed, so every run left one behind.  Vitest 5.1
 * removes `_tmpDir` itself when it closes, and this stays as a guard that costs nothing if it's
 * already gone.  `_tmpDir` is internal to Vitest, so it's read when the run ends and checked before
 * anything is removed.
 */
export function removeVitestTempDirOnTeardown(project: VitestOwner): () => Promise<void> {
  return async () => {
    await removeVitestTempDir(Reflect.get(project.vitest, '_tmpDir'));
  };
}

/** Vitest global setup for packages that need nothing else from @riosoma/testkit's global setup. */
export default function setup(project: VitestOwner): () => Promise<void> {
  return removeVitestTempDirOnTeardown(project);
}
