/**
 * QU LOADER — turns a manifest.quapp into a running, registered package.
 *
 * This is the concrete answer to "can the relay load apps from other repos
 * at startup": `loadLocal()` resolves a package's `requires` against a pool
 * of locally discovered manifests (see discover.js) and loads them in
 * dependency order; `loadRemote()` does the same for a package published at
 * a URL, with mandatory integrity checking and optional signature
 * verification before a single byte of remote code ever runs.
 *
 * -----------------------------------------------------------------------
 * What changed vs. the original prototype:
 * -----------------------------------------------------------------------
 *   - `loadLocal()` used to log a warning and silently skip `requires`
 *     entirely ("Dependencies... are not yet resolved locally"). It now
 *     actually resolves and loads them, via @qu/foundation's
 *     DependencyResolver, in the correct order, and throws a clear error if
 *     something required is missing.
 *   - `loadRemote()` used to just throw "not implemented yet". It's
 *     implemented here: fetch manifest -> fetch main module source ->
 *     verify SHA-256 integrity against `manifest.integrity` (REQUIRED,
 *     loading refuses to proceed without it) -> optionally verify an
 *     Ed25519 signature against a caller-supplied allow-list of trusted
 *     publisher keys -> import via a `data:` URL (no temp files needed).
 *
 * Constraint worth knowing: a `data:` URL module has no real base URL, so a
 * remotely loaded main module CANNOT have relative `import`s of its own
 * files - it must be a single, self-contained ES module. This is exactly
 * what a bundler (see the root `npm run build` / esbuild setup) produces,
 * so in practice "publish a remote-loadable Qu package" just means
 * "publish your bundled dist file and its manifest".
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { QuCrypto } from '@qu/core';
import { validateManifest, DependencyResolver } from '@qu/foundation';

export class QuLoader {
  /**
   * @param {import('@qu/core').QuCore} qu
   * @param {import('@qu/foundation').Registry} registry
   */
  constructor(qu, registry) {
    this.qu = qu;
    this.registry = registry;
    this.resolver = new DependencyResolver(registry);
    /** @type {Map<string, object>} manifest name -> imported module */
    this._loaded = new Map();
  }

  /** @param {string} name @returns {boolean} */
  isLoaded(name) {
    return this._loaded.has(name);
  }

  /** @returns {string[]} Names of every package loaded so far, in load order. */
  listLoaded() {
    return Array.from(this._loaded.keys());
  }

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
      await this.#finishLoad(mod, dep);
    }

    return this._loaded.get(manifest.name);
  }

  /**
   * Loads a package published at `manifestUrl`. The manifest MUST declare
   * `integrity` (a `"sha256-<base64>"` hash of the main module's bytes) -
   * loading throws if it's missing, so "remote" never silently means
   * "unpinned".
   *
   * `requires` for remote packages is intentionally NOT auto-resolved
   * against other remote sources (that would mean silently fetching and
   * running code from wherever a manifest points, transitively, with no
   * operator review). Remote packages may only `require` names the caller
   * has already loaded/registered (built-in Engines, or local packages
   * loaded first) - resolve() will throw a clear "not registered" error
   * otherwise, same as any other missing dependency.
   *
   * @param {string} manifestUrl
   * @param {object} [options]
   * @param {string[]} [options.trustedPublisherPubs] - base64url Ed25519
   *   public keys. If the manifest carries a `signature`, it must verify
   *   against one of these to be accepted. If the manifest is unsigned, or
   *   no trusted keys are given, only the integrity hash is enforced.
   * @param {boolean} [options.forceReload=false]
   * @returns {Promise<object>} The imported module.
   */
  async loadRemote(manifestUrl, { trustedPublisherPubs = [], forceReload = false } = {}) {
    const manifestRes = await fetch(manifestUrl);
    if (!manifestRes.ok) {
      throw new Error(`QuLoader.loadRemote: failed to fetch manifest at ${manifestUrl} (HTTP ${manifestRes.status})`);
    }
    const manifest = validateManifest(await manifestRes.json());

    if (this._loaded.has(manifest.name) && !forceReload) return this._loaded.get(manifest.name);

    if (!manifest.integrity) {
      throw new Error(
        `QuLoader.loadRemote: manifest for "${manifest.name}" has no "integrity" field. ` +
          'Remote packages must be pinned to a sha256 hash - refusing to load unpinned code.'
      );
    }

    // Unresolved `requires` must already be satisfiable locally - see doc comment above.
    this.resolver.resolve(manifest, []);

    const mainUrl = new URL(manifest.main, manifestUrl).href;
    const sourceRes = await fetch(mainUrl);
    if (!sourceRes.ok) {
      throw new Error(`QuLoader.loadRemote: failed to fetch main module at ${mainUrl} (HTTP ${sourceRes.status})`);
    }
    const sourceBytes = new Uint8Array(await sourceRes.arrayBuffer());

    const actualDigest = QuCrypto.toBase64(await QuCrypto.sha256(sourceBytes));
    const expectedDigest = manifest.integrity.replace(/^sha256-/, '');
    if (actualDigest !== expectedDigest) {
      throw new Error(
        `QuLoader.loadRemote: integrity check failed for "${manifest.name}" - ` +
          `expected sha256-${expectedDigest}, got sha256-${actualDigest}. Refusing to load.`
      );
    }

    if (manifest.signature) {
      if (trustedPublisherPubs.length === 0) {
        console.warn(
          `[QuLoader] "${manifest.name}" is signed but no trustedPublisherPubs were provided - signature was NOT verified`
        );
      } else {
        const signature = QuCrypto.fromBase64Url(manifest.signature);
        const verified = await anyKeyVerifies(sourceBytes, signature, trustedPublisherPubs);
        if (!verified) {
          throw new Error(`QuLoader.loadRemote: signature on "${manifest.name}" does not match any trusted publisher`);
        }
      }
    }

    // No relative imports are possible from a data: URL module - see class doc.
    const dataUrl = `data:text/javascript;base64,${QuCrypto.toBase64(sourceBytes)}`;
    const mod = await import(dataUrl);
    await this.#finishLoad(mod, manifest);
    return this._loaded.get(manifest.name);
  }

  async #finishLoad(mod, manifest) {
    if (typeof mod.register === 'function') {
      await mod.register(this.qu, manifest, this.registry);
    }
    for (const provided of manifest.provides ?? []) {
      if (!this.registry.has(provided)) {
        console.warn(`[QuLoader] "${manifest.name}" declared it provides "${provided}" but never registered it`);
      }
    }
    this._loaded.set(manifest.name, mod);
  }
}

async function anyKeyVerifies(data, signature, base64UrlPubKeys) {
  for (const pub of base64UrlPubKeys) {
    if (await QuCrypto.verify(data, signature, QuCrypto.fromBase64Url(pub))) return true;
  }
  return false;
}
