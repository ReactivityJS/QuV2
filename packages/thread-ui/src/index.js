/**
 * THREAD VIEW — one message list + composer, the shared UI every Thread-
 * backed app (Forum, Chat, Inbox - see apps/forum, apps/chat, apps/inbox)
 * is built from. Exists as its own package rather than being duplicated
 * three times, or living inside one of those apps and imported cross-app,
 * because it's genuinely the SAME view three times over, differing only in
 * which `spaceId`/`threadId`/`config` it's pointed at - precisely the
 * "Forum/Chat/Inbox differ only by config" claim from ThreadService's own
 * doc comment, carried one layer up into the UI.
 *
 * Reactivity: rather than manually re-fetching after every post, this
 * watches the thread's underlying message COLLECTION path (see
 * @qu/services/paths.js) with @qu/reactive's `watch()`. That fires for
 * ANY change to that collection - this identity's own post (QuStore's
 * notify bus includes the writer, see @qu/core/events.js) just as much as
 * one arriving from another peer over sync - so there is exactly one
 * reload path for both cases, not a manual-refresh special case for local
 * posts and a separate live-update path for remote ones.
 */
import { watch } from '@qu/reactive';
import { paths } from '@qu/services';
import { renderAvatar } from '@qu/ui';

const STYLE_ID = 'qu-thread-view-style';
const STYLE = `
  .qu-thread-view { display: flex; flex-direction: column; gap: 0.6rem; }
  .qu-thread-messages { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.5rem; max-height: 60vh; overflow-y: auto; }
  .qu-thread-message { padding: 0.5rem 0.7rem; border: 1px solid #8884; border-radius: 0.5rem; }
  .qu-thread-author { display: block; font-size: 0.8em; font-weight: 600; opacity: 0.75; margin-bottom: 0.2rem; }
  .qu-thread-empty { opacity: 0.6; font-size: 0.9em; }
  .qu-thread-composer { display: flex; gap: 0.4rem; }
  .qu-thread-composer textarea { flex: 1; resize: vertical; min-height: 2.4rem; font: inherit; padding: 0.4rem; }
  .qu-thread-message-row { display: flex; align-items: flex-start; gap: 0.5rem; }
  .qu-thread-message-row .qu-thread-body-col { flex: 1; min-width: 0; }
  .qu-thread-edit-btn { background: none; border: none; cursor: pointer; opacity: 0.5; font-size: 0.85em; flex-shrink: 0; }
  .qu-thread-edit-btn:hover { opacity: 1; }
  .qu-thread-body[contenteditable="true"] { outline: 1px dashed #8888; border-radius: 0.3rem; padding: 0.2rem 0.3rem; }
  .qu-thread-edit-actions { display: flex; gap: 0.4rem; margin-top: 0.3rem; }
  .qu-thread-edited-mark { opacity: 0.5; font-size: 0.75em; margin-left: 0.4rem; }
`;

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  document.head.appendChild(style);
}

/**
 * @param {HTMLElement} container - appended to, not cleared (a caller may
 *   want its own heading/toolbar above this view - see apps/forum's topic
 *   header for an example).
 * @param {object} options
 * @param {import('@qu/core').QuCore} options.qu
 * @param {ReturnType<import('@qu/services').createServices>} options.services
 * @param {string|number} options.spaceId
 * @param {string} options.threadId
 * @param {object} options.threadConfig - Forwarded to `threads.createThread()` - see THREAD_PRESETS.
 * @param {string|number} [options.asSpaceId] - Post under a pseudonymous space identity instead of the main one.
 * @param {string} [options.composerPlaceholder]
 * @param {string} [options.emptyLabel]
 * @param {import('@qu/foundation').HookBus} [options.hooks] - The shell's
 *   client-side hook bus (`ctx.hooks`, see apps/shell/src/main.js), if the
 *   caller has one. Optional and defaults to no-op: this is the ONE place
 *   every Thread-backed app's compose form funnels through, so it's also
 *   the one natural seam for a future feature (e.g. @mentions parsing) to
 *   transform an outgoing message's `body` before it's signed and written,
 *   without ThreadService or any individual app needing to know that
 *   feature exists. See `thread.beforePostMessage` (can return `{body}` to
 *   replace the text) and `thread.afterPostMessage` (side-effects only,
 *   e.g. notifications) below.
 * @returns {() => void} stop function
 */
export function mountThreadView(container, {
  qu, services, spaceId, threadId, threadConfig,
  asSpaceId = null, composerPlaceholder = 'Message…', emptyLabel = 'No messages yet.', hooks = null,
}) {
  ensureStyle();
  let stopped = false;
  let unwatch = null;
  let myActorPub = null; // resolved before the first render - see the IIFE below

  const root = document.createElement('div');
  root.className = 'qu-thread-view';

  const listEl = document.createElement('ul');
  listEl.className = 'qu-thread-messages';

  const form = document.createElement('form');
  form.className = 'qu-thread-composer';
  const input = document.createElement('textarea');
  input.placeholder = composerPlaceholder;
  input.required = true;
  const sendBtn = document.createElement('button');
  sendBtn.type = 'submit';
  sendBtn.textContent = '➤';
  sendBtn.title = 'Send';
  form.append(input, sendBtn);

  root.append(listEl, form);
  container.appendChild(root);

  async function reload() {
    if (stopped) return;
    const messages = await services.threads.listMessages(spaceId, threadId);
    if (stopped) return;
    listEl.textContent = '';
    if (messages.length === 0) {
      const li = document.createElement('li');
      li.className = 'qu-thread-empty';
      li.textContent = emptyLabel;
      listEl.appendChild(li);
      return;
    }
    // One profile lookup per unique author, not per message - a thread
    // with many messages from the same few people shouldn't re-resolve
    // the same profile over and over.
    const profiles = new Map();
    await Promise.all([...new Set(messages.map((m) => m.author))].map(async (authorPub) => {
      const profile = await services.profile.getPublicProfile(authorPub).catch(() => null);
      if (profile) profiles.set(authorPub, profile);
    }));
    if (stopped) return;
    for (const message of messages) listEl.appendChild(messageRow(message, profiles.get(message.author) ?? null));
    listEl.scrollTop = listEl.scrollHeight;
  }

  function messageRow(message, profile) {
    const li = document.createElement('li');
    li.className = 'qu-thread-message';
    const fallbackName = `~${message.author.slice(0, 10)}…`;
    const authorName = profile?.alias || fallbackName;

    const author = document.createElement('span');
    author.className = 'qu-thread-author';
    author.textContent = authorName;
    if (message.editedAt) {
      const edited = document.createElement('span');
      edited.className = 'qu-thread-edited-mark';
      edited.textContent = '(edited)';
      author.appendChild(edited);
    }

    const body = document.createElement('span');
    body.className = 'qu-thread-body';
    renderBody(body, message);

    const row = document.createElement('div');
    row.className = 'qu-thread-message-row';
    row.appendChild(renderAvatar(message.author, authorName, profile?.avatar ?? null, { size: '1.8rem' }));
    const bodyCol = document.createElement('div');
    bodyCol.className = 'qu-thread-body-col';
    bodyCol.append(author, body);
    row.appendChild(bodyCol);

    // Own messages only - ThreadService.editMessage() enforces this same
    // check server/store-side too (see its own doc comment for why a
    // public thread's `writers: '*'` ACL alone isn't enough to stop
    // someone overwriting a DIFFERENT author's message by path); this is
    // just the UI not offering an edit affordance that would fail anyway.
    if (message.author === myActorPub) {
      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'qu-thread-edit-btn';
      editBtn.textContent = '✎';
      editBtn.title = 'Edit';
      editBtn.addEventListener('click', () => startEdit(body, bodyCol, message));
      row.appendChild(editBtn);
    }

    li.appendChild(row);
    return li;
  }

  function renderBody(body, message) {
    if (message.formattedHtml) {
      // Safe by construction - ThreadService only ever populates this via
      // thread-formatting.js's formatMarkdown(), which HTML-escapes the
      // body FIRST and only then substitutes a small whitelisted set of
      // tags (see that file's own doc comment) - never raw user input.
      body.innerHTML = message.formattedHtml;
    } else {
      body.textContent = message.body;
    }
  }

  function startEdit(body, bodyCol, message) {
    body.contentEditable = 'true';
    body.textContent = message.body; // edit the raw body, not the rendered markdown HTML
    body.focus();

    const actions = document.createElement('div');
    actions.className = 'qu-thread-edit-actions';
    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.textContent = 'Save';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.textContent = 'Cancel';
    actions.append(saveBtn, cancelBtn);
    bodyCol.appendChild(actions);

    const endEdit = () => {
      body.contentEditable = 'false';
      actions.remove();
    };
    cancelBtn.addEventListener('click', () => {
      renderBody(body, message);
      endEdit();
    });
    saveBtn.addEventListener('click', async () => {
      const newBody = body.textContent.trim();
      endEdit();
      if (!newBody || newBody === message.body) {
        renderBody(body, message);
        return;
      }
      await services.threads.editMessage(spaceId, threadId, message.id, { body: newBody, asSpaceId });
      // The edit lands at the MESSAGE's own path, not the collection path
      // watch() below observes (see that watch() call's own doc comment
      // for why only collection changes retrigger it) - reload explicitly
      // so this tab sees its own edit immediately. Another tab with this
      // same thread open won't see the edit until it next reloads for an
      // unrelated reason (a new message arriving) - a known limitation of
      // not watching every individual message path, not a silent bug.
      reload();
    });
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    let body = input.value.trim();
    if (!body) return;
    input.value = '';
    if (hooks) {
      const patched = await hooks.run('thread.beforePostMessage', { spaceId, threadId, body });
      body = patched.body ?? body;
    }
    const message = await services.threads.postMessage(spaceId, threadId, { body, asSpaceId });
    if (hooks) hooks.notify('thread.afterPostMessage', { spaceId, threadId, message });
    // No manual reload() call here - see the module doc comment above for
    // why the watch() below already covers this.
  });

  /**
   * `postMessage()` writes the message itself, THEN updates the thread's
   * message collection to reference it - two SEPARATE writes, in that
   * order, when they both happen locally. Over sync, though, they travel
   * as two INDEPENDENT messages with no ordering guarantee between them
   * (see @qu/sync/sync-engine.js) - another peer can receive the
   * collection update (which is what `watch()` below reacts to) before the
   * message it now references has arrived. `listMessages()` silently skips
   * a reference it can't resolve yet (see ThreadService), so a reload
   * triggered at exactly that moment would render one message short - not
   * wrong forever, just until the message itself lands a moment later, but
   * nothing re-renders for THAT arrival since watch() only watches the
   * collection path, not every message path inside it. One short,
   * unconditional extra reload after the watch-triggered one catches that
   * gap without needing to watch anything new.
   */
  function reloadThenSettle() {
    reload();
    setTimeout(reload, 400);
  }

  (async () => {
    myActorPub = asSpaceId ? null : await services.actors.whoAmI();
    await services.threads.createThread(spaceId, threadId, threadConfig);
    if (stopped) return;
    await reload();
    if (stopped) return;
    const collectionPath = paths.collectionPath(spaceId, paths.threadMessagesCollectionId(threadId));
    unwatch = watch(qu, collectionPath, reloadThenSettle, { initial: false });
  })();

  return () => {
    stopped = true;
    unwatch?.();
    root.remove();
  };
}
