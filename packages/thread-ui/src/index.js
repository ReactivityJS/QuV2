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

const STYLE_ID = 'qu-thread-view-style';
const STYLE = `
  .qu-thread-view { display: flex; flex-direction: column; gap: 0.6rem; }
  .qu-thread-messages { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.5rem; max-height: 60vh; overflow-y: auto; }
  .qu-thread-message { padding: 0.5rem 0.7rem; border: 1px solid #8884; border-radius: 0.5rem; }
  .qu-thread-author { display: block; font-family: ui-monospace, monospace; font-size: 0.75em; opacity: 0.6; margin-bottom: 0.2rem; }
  .qu-thread-empty { opacity: 0.6; font-size: 0.9em; }
  .qu-thread-composer { display: flex; gap: 0.4rem; }
  .qu-thread-composer textarea { flex: 1; resize: vertical; min-height: 2.4rem; font: inherit; padding: 0.4rem; }
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
 * @returns {() => void} stop function
 */
export function mountThreadView(container, {
  qu, services, spaceId, threadId, threadConfig,
  asSpaceId = null, composerPlaceholder = 'Message…', emptyLabel = 'No messages yet.',
}) {
  ensureStyle();
  let stopped = false;
  let unwatch = null;

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
    for (const message of messages) listEl.appendChild(messageRow(message));
    listEl.scrollTop = listEl.scrollHeight;
  }

  function messageRow(message) {
    const li = document.createElement('li');
    li.className = 'qu-thread-message';
    const author = document.createElement('span');
    author.className = 'qu-thread-author';
    author.textContent = `~${message.author.slice(0, 10)}…`;
    const body = document.createElement('span');
    body.className = 'qu-thread-body';
    if (message.formattedHtml) {
      // Safe by construction - ThreadService only ever populates this via
      // thread-formatting.js's formatMarkdown(), which HTML-escapes the
      // body FIRST and only then substitutes a small whitelisted set of
      // tags (see that file's own doc comment) - never raw user input.
      body.innerHTML = message.formattedHtml;
    } else {
      body.textContent = message.body;
    }
    li.append(author, body);
    return li;
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const body = input.value.trim();
    if (!body) return;
    input.value = '';
    await services.threads.postMessage(spaceId, threadId, { body, asSpaceId });
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
