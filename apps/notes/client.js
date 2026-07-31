/**
 * NOTES CLIENT — the browser half of the notes app, mounted in-place by a
 * shell (see apps/shell). Deliberately thin: it asks the shell-provided
 * `services` for exactly the two Services it needs and renders with
 * @qu/ui's Qu-Components - no path/id plumbing, no manual subscribe/
 * unsubscribe bookkeeping.
 *
 * Notes live under a per-identity space (`notes-<actorPub>`), so each user
 * sees only their own - `mount()` derives that from `services.actors`
 * before rendering anything.
 */
import '@qu/ui';
import { paths } from '@qu/services';

const COLLECTION_ID = 'all';

/**
 * @param {HTMLElement} container
 * @param {{qu: object, services: object}} ctx
 * @returns {() => void} stop function
 */
export function mount(container, { qu, services }) {
  let stopped = false;
  let cleanupList = null;

  (async () => {
    const actorPub = await services.actors.whoAmI();
    const spaceId = `notes-${actorPub}`;
    if (stopped) return;

    const form = document.createElement('form');
    const input = document.createElement('input');
    input.placeholder = 'New note…';
    input.required = true;
    const button = document.createElement('button');
    button.type = 'submit';
    button.textContent = 'Add';
    form.append(input, button);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      // Use ONE id for both the storage path and the embedded _id -
      // DocumentEngine only stamps a fresh random _id when the value
      // doesn't already have one (see @qu/engines/document-engine.js), so
      // setting it here keeps the collection entry's path and the
      // document's own _id in agreement instead of two independently
      // generated UUIDs.
      const noteId = crypto.randomUUID();
      await services.documents.create(spaceId, noteId, { _id: noteId, text });
      await services.collections.addItem(spaceId, COLLECTION_ID, paths.documentPath(spaceId, noteId));
      input.value = '';
    });

    // Only create the collection if it doesn't exist yet - CollectionService
    // .create() OVERWRITES, so calling it unconditionally on every mount
    // would silently wipe an existing user's notes back to empty.
    const existing = await services.collections.list(spaceId, COLLECTION_ID);
    if (existing === null) await services.collections.create(spaceId, COLLECTION_ID, []);

    const list = document.createElement('qu-list');
    list.setAttribute('path', paths.collectionPath(spaceId, COLLECTION_ID));
    const template = document.createElement('template');
    template.innerHTML = '<li><qu-view field="text"></qu-view></li>';
    list.appendChild(template);

    if (stopped) return;
    container.qu = qu;
    container.append(form, list);
    cleanupList = list;
  })();

  return () => {
    stopped = true;
    cleanupList?.remove();
  };
}
