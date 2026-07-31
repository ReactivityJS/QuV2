/**
 * REMOTE LOADER — the isomorphic half of @qu/loader: everything needed to
 * fetch, verify and import a package published at a URL. Deliberately kept
 * in its OWN file with zero Node built-ins (`fetch`, `URL`, `TextEncoder`,
 * dynamic `import()` of a `data:` URL - all standard, available in both
 * Node and browsers), so a browser bundle (e.g. apps/shell) can import
 * `@qu/loader/remote` directly without pulling in `node:fs`/`node:path`
 * from loader.js's `loadLocal()`, which only ever makes sense server-side.
 *
 * `QuLoader` (loader.js, Node-only) extends this with `loadLocal()`. See
 * that file for the full "why remote loading is safe" writeup - this file
 * is the mechanism, that one adds the local-filesystem half of it.
 */
import { QuCrypto } from '@qu/core';
import { validateManifest, DependencyResolver } from '@qu/foundation';

export class RemoteLoader {
  /**
   * @param {*} qu - Passed through to a loaded module's `register(qu, manifest, registry)`.
   * @param {import('@qu/foundation').Registry} registry
   */
  constructor(qu, registry) {
    this.qu = qu;
    this.registry = registry;
    this.resolver = new DependencyResolver(registry);
    /** @type {Map<string, {mod: object, manifest: import('@qu/foundation').Manifest, originUrl: string|null}>} */
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

  /** @param {string} name @returns {object|undefined} The loaded module. */
  getModule(name) {
    return this._loaded.get(name)?.mod;
  }

  /** @param {string} name @returns {import('@qu/foundation').Manifest|undefined} */
  getManifest(name) {
    return this._loaded.get(name)?.manifest;
  }

  /**
   * @param {string} name
   * @returns {string|null|undefined} The manifest URL this package was
   *   loaded from (loadRemote()), `null` for a local package (loadLocal()),
   *   or `undefined` if `name` isn't loaded. Used by @qu/relay to resolve
   *   an app's `clientMain` to an absolute URL for /apps.json.
   */
  getOriginUrl(name) {
    return this._loaded.get(name)?.originUrl;
  }

  /** @returns {Array<{manifest: import('@qu/foundation').Manifest, originUrl: string|null}>} Every loaded package's manifest + origin, in load order. */
  listManifests() {
    return Array.from(this._loaded.values()).map(({ manifest, originUrl }) => ({ manifest, originUrl }));
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
   * has already loaded/registered - resolve() throws a clear "not
   * registered" error otherwise, same as any other missing dependency.
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

    if (this._loaded.has(manifest.name) && !forceReload) return this.getModule(manifest.name);

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
    const mod = await import(/* @vite-ignore */ dataUrl);
    await this._finishLoad(mod, manifest, manifestUrl);
    return this.getModule(manifest.name);
  }

  /**
   * @protected Shared by loadRemote() and QuLoader.loadLocal() - calls the
   * loaded module's `register()` export (if any) and records it as loaded.
   * @param {object} mod
   * @param {import('@qu/foundation').Manifest} manifest
   * @param {string|null} [originUrl] - The manifest URL this came from
   *   (loadRemote), or `null` for a local package (loadLocal) - see getOriginUrl().
   */
  async _finishLoad(mod, manifest, originUrl = null) {
    if (typeof mod.register === 'function') {
      await mod.register(this.qu, manifest, this.registry);
    }
    for (const provided of manifest.provides ?? []) {
      if (!this.registry.has(provided)) {
        console.warn(`[QuLoader] "${manifest.name}" declared it provides "${provided}" but never registered it`);
      }
    }
    this._loaded.set(manifest.name, { mod, manifest, originUrl });
  }
}

async function anyKeyVerifies(data, signature, base64UrlPubKeys) {
  for (const pub of base64UrlPubKeys) {
    if (await QuCrypto.verify(data, signature, QuCrypto.fromBase64Url(pub))) return true;
  }
  return false;
}
