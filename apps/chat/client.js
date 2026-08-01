/**
 * CHAT — one room per Contact (see @qu/services' ContactsService), each
 * backed by THREAD_PRESETS.chat([myPub, theirPub]) - a fixed 2-member
 * private, encrypted thread. The room id is DERIVED (sha256 of the two
 * members' pubkeys, sorted first so it doesn't matter who opens it first)
 * rather than created-and-shared, so either side lands in the same room
 * with no separate "invite" step - Contacts is already the mutual-interest
 * signal a 1:1 room needs.
 *
 * A richer room view than @qu/thread-ui's shared mountThreadView() (which
 * Forum/Inbox still use) - ported from QUniverse V1's modules/chat.js +
 * modules/presence.js (calls/WebRTC deliberately excluded per the port
 * request): emoji reactions, pinned messages, online presence, replies,
 * forwarding, and a single attachment per message. Kept OUT of the shared
 * thread-ui component on purpose - Forum/Inbox don't need this much
 * chrome, and a generic component trying to serve all three would need a
 * pile of feature flags for no real benefit.
 *
 * Route: `#/chat` (room list = Contacts) or `#/chat/<peerActorPub>` (one room).
 */
import { QuCrypto } from '@qu/core';
import { THREAD_PRESETS, paths } from '@qu/services';
import { watch } from '@qu/reactive';
import { createI18n } from '@qu/i18n';

const SPACE = 'chat';
const REACTION_CHOICES = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

const DICT = {
  en: {
    title: 'Chat', empty: 'No contacts yet — add some from the User List to start chatting.', back: '← Chats',
    online: 'online', offline: 'offline', lastSeen: 'last seen {seconds}s ago',
    pinned: 'Pinned', unpin: 'Unpin', pin: 'Pin', react: 'React',
    replyingTo: 'Replying to {name}', cancelReply: 'Cancel',
    forwardedFrom: 'Forwarded from {name}',
    attach: 'Attach file', removeAttachment: 'Remove attachment', download: 'Download',
    send: 'Send', composerPlaceholder: 'Message…',
  },
  de: {
    title: 'Chat', empty: 'Noch keine Kontakte — in der Nutzerliste hinzufügen, um zu chatten.', back: '← Chats',
    online: 'online', offline: 'offline', lastSeen: 'zuletzt online vor {seconds}s',
    pinned: 'Angeheftet', unpin: 'Lösen', pin: 'Anheften', react: 'Reagieren',
    replyingTo: 'Antwort an {name}', cancelReply: 'Abbrechen',
    forwardedFrom: 'Weitergeleitet von {name}',
    attach: 'Datei anhängen', removeAttachment: 'Anhang entfernen', download: 'Herunterladen',
    send: 'Senden', composerPlaceholder: 'Nachricht…',
  },
};
const { t } = createI18n(DICT);

const STYLE_ID = 'qu-chat-style';
const STYLE = `
  .qu-chat-rooms { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.4rem; }
  .qu-chat-rooms li { padding: 0.5rem 0.7rem; border: 1px solid #8884; border-radius: 0.4rem; }
  .qu-chat-rooms a { text-decoration: none; color: inherit; font-family: ui-monospace, monospace; }
  .qu-chat-header { display: flex; align-items: center; gap: 0.6rem; }
  .qu-chat-presence { font-size: 0.85em; opacity: 0.7; display: flex; align-items: center; gap: 0.3rem; }
  .qu-chat-presence-dot { width: 0.5rem; height: 0.5rem; border-radius: 50%; background: #888; }
  .qu-chat-presence-dot[data-online="true"] { background: #3cb371; }
  .qu-chat-pinned { display: flex; flex-direction: column; gap: 0.3rem; margin: 0.5rem 0; padding: 0.4rem 0.6rem; border: 1px solid #8884; border-radius: 0.4rem; }
  .qu-chat-pinned-row { display: flex; align-items: center; gap: 0.5rem; font-size: 0.85em; }
  .qu-chat-pinned-row span { flex: 1; opacity: 0.8; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .qu-chat-messages { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.6rem; max-height: 60vh; overflow-y: auto; }
  .qu-chat-message { padding: 0.5rem 0.7rem; border: 1px solid #8884; border-radius: 0.5rem; }
  .qu-chat-author { display: block; font-family: ui-monospace, monospace; font-size: 0.75em; opacity: 0.6; margin-bottom: 0.2rem; }
  .qu-chat-reply-quote, .qu-chat-forward-note { font-size: 0.8em; opacity: 0.65; border-left: 2px solid #8884; padding-left: 0.4rem; margin-bottom: 0.3rem; }
  .qu-chat-attachment img { max-width: 100%; max-height: 16rem; border-radius: 0.4rem; margin-top: 0.3rem; display: block; }
  .qu-chat-attachment a { display: inline-block; margin-top: 0.3rem; }
  .qu-chat-message-actions { display: flex; gap: 0.4rem; margin-top: 0.4rem; align-items: center; flex-wrap: wrap; }
  .qu-chat-message-actions button { background: none; border: none; cursor: pointer; opacity: 0.6; font-size: 0.9em; }
  .qu-chat-message-actions button:hover { opacity: 1; }
  .qu-chat-reaction-chip { border: 1px solid #8884; border-radius: 1rem; padding: 0.05rem 0.4rem; font-size: 0.85em; cursor: pointer; background: none; }
  .qu-chat-reaction-chip[data-mine="true"] { background: #8882; }
  .qu-chat-reaction-picker { display: flex; gap: 0.2rem; }
  .qu-chat-reply-banner { display: flex; align-items: center; gap: 0.5rem; font-size: 0.85em; opacity: 0.8; padding: 0.3rem 0.5rem; border: 1px solid #8884; border-radius: 0.4rem; margin-bottom: 0.3rem; }
  .qu-chat-reply-banner span { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .qu-chat-composer { display: flex; gap: 0.4rem; align-items: flex-end; }
  .qu-chat-composer textarea { flex: 1; resize: vertical; min-height: 2.4rem; font: inherit; padding: 0.4rem; }
  .qu-chat-pending-attachment { font-size: 0.8em; opacity: 0.8; display: flex; align-items: center; gap: 0.4rem; margin-bottom: 0.3rem; }
`;

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  document.head.appendChild(style);
}

/** @returns {Promise<string>} A deterministic room id both members derive independently, order-independent. */
async function roomId(memberPubs) {
  const sorted = [...memberPubs].sort();
  const hash = await QuCrypto.sha256(new TextEncoder().encode(sorted.join(',')));
  return `r-${QuCrypto.toHex(hash).slice(0, 32)}`;
}

function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function mount(container, { qu, services, segments, subscribe }) {
  ensureStyle();
  let stopped = false;
  let unwatch = null;
  let stopHeartbeat = null;
  let presenceTimer = null;

  // See apps/forum/client.js's identical call for why this is needed - the
  // shell's own default subscriptions don't cover this app's space. Two
  // separate subscriptions, not one: an attachment's binary CHUNKS live
  // under the `blob` mount (`/blob/<space>/...`, see @qu/engines'
  // AssetEngine and its `toBlobPath()`), a completely different top-level
  // prefix from the message/metadata documents under `/store/<space>/...`
  // - subscribing to only one silently leaves the other never syncing (an
  // attachment's metadata would arrive - `message.attachment` populated -
  // but `services.assets.download()` would find its chunks perpetually
  // missing and return null, showing nothing).
  subscribe(`/store/${SPACE}`);
  subscribe(`/blob/${SPACE}`);

  const peerActorPub = segments[1] ?? null;

  (async () => {
    const myActorPub = await services.actors.whoAmI();
    if (stopped) return;

    if (peerActorPub) await renderRoom(myActorPub, peerActorPub);
    else await renderRoomList();
  })();

  async function renderRoomList() {
    const contacts = await services.contacts.listContacts();
    if (stopped) return;
    container.textContent = '';

    const heading = document.createElement('h1');
    heading.textContent = t('title');
    container.appendChild(heading);

    if (contacts.length === 0) {
      const empty = document.createElement('p');
      empty.textContent = t('empty');
      container.appendChild(empty);
      return;
    }

    const list = document.createElement('ul');
    list.className = 'qu-chat-rooms';
    for (const { actorPub, profile } of contacts) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = `#/chat/${actorPub}`;
      a.textContent = profile?.alias ?? `~${actorPub.slice(0, 16)}…`;
      li.appendChild(a);
      list.appendChild(li);
    }
    container.appendChild(list);
  }

  async function renderRoom(myActorPub, theirActorPub) {
    container.textContent = '';
    const back = document.createElement('a');
    back.href = '#/chat';
    back.textContent = t('back');
    container.appendChild(back);

    const id = await roomId([myActorPub, theirActorPub]);
    if (stopped) return;
    const spaceId = SPACE;
    const threadId = id;
    const memberPubs = [myActorPub, theirActorPub];
    const threadConfig = THREAD_PRESETS.chat(memberPubs);
    await services.threads.createThread(spaceId, threadId, threadConfig);
    if (stopped) return;

    const theirProfile = await services.profile.getPublicProfile(theirActorPub);
    if (stopped) return;
    const theirName = theirProfile?.alias || `~${theirActorPub.slice(0, 10)}…`;

    const header = document.createElement('div');
    header.className = 'qu-chat-header';
    const heading = document.createElement('h1');
    heading.textContent = theirName;
    const presenceEl = document.createElement('span');
    presenceEl.className = 'qu-chat-presence';
    header.append(heading, presenceEl);
    container.appendChild(header);

    const pinnedEl = document.createElement('div');
    container.appendChild(pinnedEl);

    const listEl = document.createElement('ul');
    listEl.className = 'qu-chat-messages';
    container.appendChild(listEl);

    const replyBanner = document.createElement('div');
    replyBanner.className = 'qu-chat-reply-banner';
    replyBanner.hidden = true;
    container.appendChild(replyBanner);

    const pendingAttachmentEl = document.createElement('div');
    pendingAttachmentEl.className = 'qu-chat-pending-attachment';
    pendingAttachmentEl.hidden = true;
    container.appendChild(pendingAttachmentEl);

    const form = document.createElement('form');
    form.className = 'qu-chat-composer';
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.hidden = true;
    const attachBtn = document.createElement('button');
    attachBtn.type = 'button';
    attachBtn.textContent = '📎';
    attachBtn.title = t('attach');
    const input = document.createElement('textarea');
    input.placeholder = t('composerPlaceholder');
    input.required = true;
    const sendBtn = document.createElement('button');
    sendBtn.type = 'submit';
    sendBtn.textContent = '➤';
    sendBtn.title = t('send');
    form.append(fileInput, attachBtn, input, sendBtn);
    container.appendChild(form);

    let replyTo = null; // { id, author, body }
    let pendingFile = null;

    function setReplyTo(message) {
      replyTo = message ? { id: message.id, author: message.author, body: message.body } : null;
      replyBanner.hidden = !replyTo;
      replyBanner.textContent = '';
      if (replyTo) {
        const label = document.createElement('span');
        label.textContent = t('replyingTo', { name: replyTo.body.slice(0, 60) });
        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.textContent = t('cancelReply');
        cancel.addEventListener('click', () => setReplyTo(null));
        replyBanner.append(label, cancel);
        input.focus();
      }
    }

    attachBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      pendingFile = fileInput.files[0] ?? null;
      pendingAttachmentEl.hidden = !pendingFile;
      pendingAttachmentEl.textContent = '';
      if (pendingFile) {
        const label = document.createElement('span');
        label.textContent = `📎 ${pendingFile.name} (${fmtSize(pendingFile.size)})`;
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.textContent = '✕';
        remove.title = t('removeAttachment');
        remove.addEventListener('click', () => {
          pendingFile = null;
          fileInput.value = '';
          pendingAttachmentEl.hidden = true;
        });
        pendingAttachmentEl.append(label, remove);
      }
    });

    async function reload() {
      if (stopped) return;
      const messages = await services.threads.listMessages(spaceId, threadId);
      const pinnedIds = await services.threads.listPinned(spaceId, threadId);
      if (stopped) return;

      renderPinned(pinnedEl, messages, pinnedIds);

      listEl.textContent = '';
      if (messages.length === 0) {
        const li = document.createElement('li');
        li.textContent = t('empty');
        listEl.appendChild(li);
      } else {
        for (const message of messages) {
          listEl.appendChild(await messageRow(message, messages, pinnedIds.includes(message.id)));
        }
        listEl.scrollTop = listEl.scrollHeight;
      }
    }

    function renderPinned(el, messages, pinnedIds) {
      el.textContent = '';
      if (pinnedIds.length === 0) return;
      el.className = 'qu-chat-pinned';
      const heading = document.createElement('strong');
      heading.textContent = t('pinned');
      el.appendChild(heading);
      for (const pinnedId of pinnedIds) {
        const message = messages.find((m) => m.id === pinnedId);
        const row = document.createElement('div');
        row.className = 'qu-chat-pinned-row';
        const text = document.createElement('span');
        text.textContent = message?.body ?? pinnedId;
        const unpinBtn = document.createElement('button');
        unpinBtn.type = 'button';
        unpinBtn.textContent = t('unpin');
        unpinBtn.addEventListener('click', async () => {
          await services.threads.setPinned(spaceId, threadId, pinnedId, false);
          await reload();
        });
        row.append(text, unpinBtn);
        el.appendChild(row);
      }
    }

    async function messageRow(message, allMessages, isPinned) {
      const li = document.createElement('li');
      li.className = 'qu-chat-message';

      const author = document.createElement('span');
      author.className = 'qu-chat-author';
      author.textContent = `~${message.author.slice(0, 10)}…`;
      li.appendChild(author);

      if (message.forwardedFrom) {
        const note = document.createElement('div');
        note.className = 'qu-chat-forward-note';
        note.textContent = t('forwardedFrom', { name: message.forwardedFrom.author?.slice(0, 10) ?? '?' });
        li.appendChild(note);
      }
      if (message.replyTo) {
        const quoted = allMessages.find((m) => m.id === message.replyTo);
        if (quoted) {
          const quote = document.createElement('div');
          quote.className = 'qu-chat-reply-quote';
          quote.textContent = quoted.body.slice(0, 80);
          li.appendChild(quote);
        }
      }

      const body = document.createElement('div');
      body.textContent = message.body;
      li.appendChild(body);

      if (message.attachment) {
        const attEl = document.createElement('div');
        attEl.className = 'qu-chat-attachment';
        if (message.attachment.mime?.startsWith('image/')) {
          const img = document.createElement('img');
          services.assets.download(spaceId, message.attachment.assetId).then((asset) => {
            if (stopped || !asset) return;
            img.src = URL.createObjectURL(new Blob([asset.data], { type: asset.meta.mime }));
          });
          attEl.appendChild(img);
        } else {
          const link = document.createElement('a');
          link.textContent = `📎 ${message.attachment.name} (${fmtSize(message.attachment.size)})`;
          link.href = '#';
          link.addEventListener('click', async (e) => {
            e.preventDefault();
            const asset = await services.assets.download(spaceId, message.attachment.assetId);
            if (!asset) return;
            const url = URL.createObjectURL(new Blob([asset.data], { type: asset.meta.mime }));
            const a = document.createElement('a');
            a.href = url;
            a.download = asset.meta.name;
            a.click();
            URL.revokeObjectURL(url);
          });
          attEl.appendChild(link);
        }
        li.appendChild(attEl);
      }

      const actions = document.createElement('div');
      actions.className = 'qu-chat-message-actions';

      const reactions = await services.threads.getReactions(spaceId, threadId, message.id);
      for (const [emoji, reactorPubs] of Object.entries(reactions)) {
        if (reactorPubs.length === 0) continue;
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'qu-chat-reaction-chip';
        const mine = reactorPubs.includes(myActorPub);
        chip.dataset.mine = String(mine);
        chip.textContent = `${emoji} ${reactorPubs.length}`;
        chip.addEventListener('click', async () => {
          await services.threads.setReaction(spaceId, threadId, message.id, mine ? null : emoji);
          await reload();
        });
        actions.appendChild(chip);
      }

      const reactBtn = document.createElement('button');
      reactBtn.type = 'button';
      reactBtn.textContent = t('react');
      const picker = document.createElement('span');
      picker.className = 'qu-chat-reaction-picker';
      picker.hidden = true;
      for (const emoji of REACTION_CHOICES) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = emoji;
        btn.addEventListener('click', async () => {
          await services.threads.setReaction(spaceId, threadId, message.id, emoji);
          picker.hidden = true;
          await reload();
        });
        picker.appendChild(btn);
      }
      reactBtn.addEventListener('click', () => { picker.hidden = !picker.hidden; });

      const replyBtn = document.createElement('button');
      replyBtn.type = 'button';
      replyBtn.textContent = '↩';
      replyBtn.addEventListener('click', () => setReplyTo(message));

      const pinBtn = document.createElement('button');
      pinBtn.type = 'button';
      pinBtn.textContent = isPinned ? '📌' : '📍';
      pinBtn.title = isPinned ? t('unpin') : t('pin');
      pinBtn.addEventListener('click', async () => {
        await services.threads.setPinned(spaceId, threadId, message.id, !isPinned);
        await reload();
      });

      actions.append(reactBtn, picker, replyBtn, pinBtn);
      li.appendChild(actions);
      return li;
    }

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const body = input.value.trim();
      if (!body) return;
      input.value = '';

      const extra = {};
      if (replyTo) extra.replyTo = replyTo.id; // also passed as the top-level param below - kept in sync, never diverging
      if (pendingFile) {
        // NOT encrypted, unlike the message body/text (see ThreadService's
        // own readers-based encryption) - AssetEngine chunks a file into
        // many small QuBits, and encrypting each chunk consistently for a
        // Thread's reader list is real future work, not implemented here.
        // A relay operator (or anyone syncing this space) can read
        // attached file bytes even in an otherwise end-to-end-encrypted
        // room - documented, not hidden.
        const assetId = crypto.randomUUID();
        const meta = await services.assets.upload(spaceId, assetId, pendingFile);
        extra.attachment = { assetId, name: meta.name, mime: meta.mime, size: meta.size };
      }

      const replyToId = replyTo?.id ?? null;
      pendingFile = null;
      fileInput.value = '';
      pendingAttachmentEl.hidden = true;
      setReplyTo(null);

      await services.threads.postMessage(spaceId, threadId, { body, replyTo: replyToId, extra });
      await reload();
    });

    await reload();
    unwatch = watch(qu, paths.collectionPath(spaceId, paths.threadMessagesCollectionId(threadId)), reload, { initial: false });

    stopHeartbeat = services.threads.startHeartbeat(spaceId, threadId);
    async function refreshPresence() {
      if (stopped) return;
      const presence = await services.threads.getPresence(spaceId, threadId, memberPubs);
      const theirs = presence[theirActorPub];
      presenceEl.textContent = '';
      const dot = document.createElement('span');
      dot.className = 'qu-chat-presence-dot';
      dot.dataset.online = String(!!theirs?.online);
      const label = document.createElement('span');
      if (theirs?.online) label.textContent = t('online');
      else if (theirs) label.textContent = t('lastSeen', { seconds: Math.round((Date.now() - theirs.lastSeen) / 1000) });
      else label.textContent = t('offline');
      presenceEl.append(dot, label);
    }
    await refreshPresence();
    presenceTimer = setInterval(refreshPresence, 5000);
  }

  return () => {
    stopped = true;
    unwatch?.();
    stopHeartbeat?.();
    if (presenceTimer) clearInterval(presenceTimer);
  };
}
