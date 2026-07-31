/**
 * MANIFEST — the declarative description every loadable Qu package
 * (Engine, Service or App) ships as `manifest.quapp` (a plain JSON file).
 *
 * This is the concrete implementation of the "Foundation" idea from the
 * architecture brainstorming: packages declare what they need and what they
 * provide, so the Loader can resolve dependencies and third parties can
 * write Engines/Services/Apps without ever touching Qu Core directly.
 *
 * Example (an app):
 *   {
 *     "name": "forum",
 *     "version": "1.0.0",
 *     "kind": "app",
 *     "main": "./index.js",
 *     "requires": ["thread-engine", "document-service", "notification-service"]
 *   }
 *
 * Example (an engine that registers itself):
 *   {
 *     "name": "thread-engine",
 *     "version": "1.0.0",
 *     "kind": "engine",
 *     "main": "./index.js",
 *     "requires": ["document-service"],
 *     "provides": ["thread-engine"]
 *   }
 */

/** Fields every manifest must have. */
export const REQUIRED_FIELDS = Object.freeze(['name', 'version', 'main']);

/** The three kinds of package the Loader understands. Apps are UI-only by convention (see brainstorming). */
export const MANIFEST_KINDS = Object.freeze(['engine', 'service', 'app']);

/**
 * @typedef {Object} Manifest
 * @property {string} name - Unique registry name, e.g. "thread-engine".
 * @property {string} version - Semver string. Only used for display today;
 *   the DependencyResolver checks *presence*, not version ranges (see there
 *   for why we deliberately don't do semver resolution yet).
 * @property {string} main - Path (relative to the manifest) to the ES module
 *   to `import()`.
 * @property {'engine'|'service'|'app'} [kind='app']
 * @property {string[]} [requires] - Names that must already be registered
 *   (or become registered as a side effect of loading) before this package
 *   loads.
 * @property {string[]} [provides] - Names this package registers into the
 *   Registry once loaded. Used to verify the package kept its promise.
 * @property {string[]} [capabilities] - Action names this package
 *   contributes (e.g. "reply", "pin", "mute") - see Registry.registerCapability.
 * @property {string} [integrity] - "sha256-<base64>" of the main module's
 *   source, required for remote loading (see @qu/loader).
 */

/**
 * Validates a parsed manifest object. Throws a descriptive error on the
 * first problem found rather than collecting all of them - manifests are
 * small and meant to be fixed one mistake at a time during development.
 *
 * @param {*} manifest
 * @returns {Manifest} the same object, for chaining.
 */
export function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('Invalid manifest: expected a JSON object');
  }
  for (const field of REQUIRED_FIELDS) {
    if (!manifest[field] || typeof manifest[field] !== 'string') {
      throw new Error(`Invalid manifest: missing or non-string required field "${field}"`);
    }
  }
  if (manifest.kind !== undefined && !MANIFEST_KINDS.includes(manifest.kind)) {
    throw new Error(`Invalid manifest: "kind" must be one of ${MANIFEST_KINDS.join(', ')}, got "${manifest.kind}"`);
  }
  for (const field of ['requires', 'provides', 'capabilities']) {
    if (manifest[field] !== undefined) {
      if (!Array.isArray(manifest[field]) || !manifest[field].every((x) => typeof x === 'string')) {
        throw new Error(`Invalid manifest: "${field}" must be an array of strings`);
      }
    }
  }
  if (manifest.integrity !== undefined && !/^sha256-[A-Za-z0-9+/]+=*$/.test(manifest.integrity)) {
    throw new Error('Invalid manifest: "integrity" must look like "sha256-<base64>"');
  }
  return manifest;
}
