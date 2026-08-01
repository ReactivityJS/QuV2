/**
 * APP LIST — server-side half. Purely a UI app (browses the shell's own
 * `/apps.json` client-side, see client.js) - nothing to register here, but
 * every loadable package still needs a `main` module per its manifest (see
 * @qu/foundation's manifest schema), so this stays a documented no-op
 * rather than pointing `main` at nothing.
 */
export async function register(qu, manifest) {
  console.log(`[app-list] registered (${manifest.name}@${manifest.version}) - UI-only, see client.js`);
}
