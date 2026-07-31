/**
 * QU LOADER — the Node-only half: loads a package from a local directory.
 * See remote-loader.js for `loadRemote()` (isomorphic, also usable
 * standalone from a browser via `@qu/loader/remote`) and its own doc
 * comment for the full remote-loading security writeup.
 *
 * `loadLocal()` used to just log a warning and silently skip `requires`
 * ("Dependencies... are not yet resolved locally"). It now actually
 * resolves and loads them, via @qu/foundation's DependencyResolver, in the
 * correct order, and throws a clear error if something required is missing.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateManifest } from '@qu/foundation';
import { RemoteLoader } from './remote-loader.js';

export class QuLoader extends RemoteLoader {
  /**
   * Loads the package at `packageDir` (must contain `manifest.quapp`),
   * first loading anything it `requires` that isn't already registered.
   *
   * @param {string} packageDir
   * @param {object} [options]
   * @param {Array<{manifest: import('@qu/foundation').Manifest, dir: string}>} [options.availableManifests]
   *   Candidate packages (e.g. from discoverLocalPackages()) that can
   *   satisfy `requires`. The target package itself does not need to be in
   *   this list.
   * @param {boolean} [options.forceReload=false]
   * @returns {Promise<object>} The target package's imported module.
   */
  async loadLocal(packageDir, { availableManifests = [], forceReload = false } = {}) {
    const manifest = validateManifest(JSON.parse(await readFile(join(packageDir, 'manifest.quapp'), 'utf8')));

    const dirByName = new Map([[manifest.name, packageDir]]);
    for (const entry of availableManifests) dirByName.set(entry.manifest.name, entry.dir);

    const loadOrder = this.resolver.resolve(
      manifest,
      availableManifests.map((entry) => entry.manifest)
    );

    for (const dep of loadOrder) {
      if (this._loaded.has(dep.name) && !forceReload) continue;
      const dir = dirByName.get(dep.name);
      if (!dir) {
        // Should be unreachable: the resolver only returns manifests it
        // was given, and every one of those came with a `dir` via
        // dirByName above. Kept as a defensive check, not a normal path.
        throw new Error(`QuLoader.loadLocal: resolved dependency "${dep.name}" has no known directory`);
      }
      const mainPath = join(dir, dep.main);
      const mod = await import(pathToFileURL(mainPath).href);
      await this._finishLoad(mod, dep, null);
    }

    return this.getModule(manifest.name);
  }
}
