/**
 * NOTES — the smallest possible example of a manifest-loadable Qu app.
 *
 * This is the concrete "apps become almost only UI" claim from the
 * architecture brainstorming, made real: `manifest.quapp` declares that
 * this app `requires` document-service and collection-service, both
 * already registered by whatever booted it (see @qu/relay's boot sequence,
 * which registers every built-in Service into the Foundation Registry
 * before loading any app). By the time `register()` runs here, all the
 * storage paths, signing, chunking, and reference resolution already
 * happened two layers down - this file just needs to know it's allowed to
 * ask the Registry for a document-service and a collection-service by name.
 *
 * A real UI app would import a rendering library and call these same two
 * Services from its components; this file stops at the data layer to stay
 * a minimal, runnable example.
 */
export async function register(qu, manifest, registry) {
  const documents = registry.getService('document-service');
  const collections = registry.getService('collection-service');

  const NOTES_COLLECTION = 'all';

  globalThis.NotesApp = {
    /**
     * @param {string|number} spaceId
     * @param {string} text
     * @returns {Promise<object>} The created note.
     */
    async addNote(spaceId, text) {
      const id = globalThis.crypto.randomUUID();
      const note = await documents.create(spaceId, id, { text });
      await collections.addItem(spaceId, NOTES_COLLECTION, `/store/${spaceId}/docs/${id}`);
      return note;
    },

    /** @param {string|number} spaceId @returns {Promise<Array<object>>} */
    async listNotes(spaceId) {
      return (await collections.list(spaceId, NOTES_COLLECTION)) ?? [];
    },
  };

  console.log(`[notes] registered (${manifest.name}@${manifest.version}) - try NotesApp.addNote('demo', 'hello')`);
}
