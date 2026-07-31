import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validateManifest } from '@qu/foundation';

/**
 * Scans immediate subdirectories of `baseDir` for a `manifest.quapp` file
 * and returns the ones found, parsed and validated. This is how QuLoader
 * builds the pool of "available manifests" the DependencyResolver can pull
 * `requires` from (see loader.js) - e.g. every package under `packages/` or
 * `apps/` in this monorepo.
 *
 * Directories without a manifest.quapp are silently skipped (they're just
 * not Qu packages); a manifest that fails validation is skipped WITH a
 * warning, since a typo in one app's manifest shouldn't prevent every other
 * app from being discovered.
 *
 * @param {string} baseDir
 * @returns {Promise<Array<{manifest: import('@qu/foundation').Manifest, dir: string}>>}
 */
export async function discoverLocalPackages(baseDir) {
  const found = [];
  let entries;
  try {
    entries = await readdir(baseDir, { withFileTypes: true });
  } catch {
    return found; // baseDir doesn't exist - nothing to discover, not an error
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(baseDir, entry.name);
    let raw;
    try {
      raw = await readFile(join(dir, 'manifest.quapp'), 'utf8');
    } catch {
      continue; // no manifest.quapp here - not a Qu package
    }
    try {
      const manifest = validateManifest(JSON.parse(raw));
      found.push({ manifest, dir });
    } catch (err) {
      console.warn(`[discoverLocalPackages] skipping "${dir}": ${err.message}`);
    }
  }
  return found;
}
