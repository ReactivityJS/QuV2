/**
 * FORUM — server-side half. UI-only (see client.js) - see apps/app-list/index.js for why this stays a documented no-op. `requires` still lists document/collection/thread-service so the DependencyResolver would catch a relay that somehow booted without them, even though this file itself never calls the Registry.
 */
export async function register(qu, manifest) {
  console.log(`[forum] registered (${manifest.name}@${manifest.version}) - UI-only, see client.js`);
}
