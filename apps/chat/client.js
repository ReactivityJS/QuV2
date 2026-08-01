/**
 * CHAT — Telegram/WhatsApp/Signal-style messenger: a room list (1:1 rooms
 * derived from Contacts, plus groups this identity has been invited to)
 * and a room view with grouped message bubbles, avatars, reactions, pins,
 * replies, forwarding, and attachments.
 *
 * A richer room view than @qu/thread-ui's shared mountThreadView() (which
 * Forum/Inbox still use) - ported from QUniverse V1's modules/chat.js +
 * modules/presence.js (calls/WebRTC deliberately excluded per the port
 * request), then given group-chat support and a bubble-based redesign.
 * Kept OUT of the shared thread-ui component on purpose - Forum/Inbox
 * don't need this much chrome, and a generic component trying to serve
 * all three would need a pile of feature flags for no real benefit.
 *
 * ENCRYPTION IS THE DEFAULT for both room kinds, not an opt-in: a 1:1 room
 * (THREAD_PRESETS.chat) and a group (THREAD_PRESETS.group) both set
 * `readers` to the fixed member list, which makes every message body AND
 * every attachment (see the `readerPubs` passed to `services.assets.upload()`
 * below) end-to-end encrypted for exactly those members - a relay operator,
 * or anyone else syncing the space, sees ciphertext only.
 *
 * GROUP MEMBERSHIP IS FIXED AT CREATION - adding/removing members would
 * mean re-keying every future message for a different reader set, which is
 * real future work, not implemented here (create a new group instead, the
 * same workaround many messengers' own encrypted-group implementations
 * reach for too).
 *
 * Routes: `#/chat` (room list), `#/chat/<peerActorPub>` (1:1 room),
 * `#/chat/g/<groupId>` (group room).
 */
import { QuCrypto } from '@qu/core';
import { THREAD_PRESETS, paths } from '@qu/services';
import { watch } from '@qu/reactive';
import { createI18n } from '@qu/i18n';

const SPACE = 'chat';
const REACTION_CHOICES = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
const AVATAR_PALETTE = ['#e17076', '#faa774', '#a695e7', '#7bc862', '#6ec9cb', '#65aadd', '#ee7aae', '#f2c94c'];

const DICT = {
  en: {
    title: 'Chats', empty: 'No chats yet — add a contact from the User List, or start a group.', back: '←',
    online: 'online', offline: 'offline', lastSeen: 'last seen {seconds}s ago',
    pinned: 'Pinned', unpin: 'Unpin', pin: 'Pin', react: 'React',
    replyingTo: 'Replying to {name}', cancelReply: 'Cancel',
    forwardedFrom: 'Forwarded from {name}',
    attach: 'Attach file', removeAttachment: 'Remove attachment', download: 'Download',
    send: 'Send', composerPlaceholder: 'Message',
    newGroup: 'New group', groupName: 'Group name', selectMembers: 'Add members', create: 'Create', cancel: 'Cancel',
    membersCount: '{count} members', you: 'You', noContacts: 'No contacts yet — add some from the User List first.',
    groupNotFound: 'This group doesn\'t exist, or you\'re not a member.', encrypted: 'Messages and files are end-to-end encrypted.',
    photo: 'Photo', video: 'Video', file: 'File', members: 'Members', close: 'Close',
  },
  de: {
    title: 'Chats', empty: 'Noch keine Chats — Kontakt aus der Nutzerliste hinzufügen oder eine Gruppe starten.', back: '←',
    online: 'online', offline: 'offline', lastSeen: 'zuletzt online vor {seconds}s',
    pinned: 'Angeheftet', unpin: 'Lösen', pin: 'Anheften', react: 'Reagieren',
    replyingTo: 'Antwort an {name}', cancelReply: 'Abbrechen',
    forwardedFrom: 'Weitergeleitet von {name}',
    attach: 'Datei anhängen', removeAttachment: 'Anhang entfernen', download: 'Herunterladen',
    send: 'Senden', composerPlaceholder: 'Nachricht',
    newGroup: 'Neue Gruppe', groupName: 'Gruppenname', selectMembers: 'Mitglieder hinzufügen', create: 'Erstellen', cancel: 'Abbrechen',
    membersCount: '{count} Mitglieder', you: 'Du', noContacts: 'Noch keine Kontakte — zuerst in der Nutzerliste hinzufügen.',
    groupNotFound: 'Diese Gruppe existiert nicht, oder du bist kein Mitglied.', encrypted: 'Nachrichten und Dateien sind Ende-zu-Ende-verschlüsselt.',
    photo: 'Foto', video: 'Video', file: 'Datei', members: 'Mitglieder', close: 'Schließen',
  },
};
const { t } = createI18n(DICT);

const STYLE_ID = 'qu-chat-style';
const STYLE = `
  .qu-chat-app { display: flex; flex-direction: column; height: 100%; min-height: 0; }
  .qu-chat-list-header { display: flex; align-items: center; justify-content: space-between; gap: 0.6rem; margin-bottom: 0.6rem; }
  .qu-chat-list-header h1 { margin: 0; }
  .qu-chat-new-group-btn { border: none; background: #3390ec; color: #fff; border-radius: 50%; width: 2.4rem; height: 2.4rem; font-size: 1.2rem; cursor: pointer; flex-shrink: 0; }
  .qu-chat-new-group-btn:hover { background: #2b7cd3; }
  .qu-chat-rooms { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
  .qu-chat-room-link { display: flex; align-items: center; gap: 0.7rem; padding: 0.5rem 0.4rem; text-decoration: none; color: inherit; border-radius: 0.5rem; }
  .qu-chat-room-link:hover { background: #8881; }
  .qu-chat-room-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 0.1rem; }
  .qu-chat-room-top { display: flex; align-items: baseline; justify-content: space-between; gap: 0.5rem; }
  .qu-chat-room-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .qu-chat-room-time { font-size: 0.75em; opacity: 0.55; flex-shrink: 0; }
  .qu-chat-room-bottom { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; }
  .qu-chat-room-preview { font-size: 0.85em; opacity: 0.65; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .qu-chat-unread-badge { background: #3390ec; color: #fff; font-size: 0.72em; border-radius: 1rem; min-width: 1.3rem; height: 1.3rem; display: flex; align-items: center; justify-content: center; padding: 0 0.35rem; flex-shrink: 0; }

  .qu-chat-avatar { flex-shrink: 0; width: 2.7rem; height: 2.7rem; border-radius: 50%; display: flex; align-items: center; justify-content: center; color: #fff; font-weight: 600; font-size: 1.05em; overflow: hidden; user-select: none; }
  .qu-chat-avatar img { width: 100%; height: 100%; object-fit: cover; }
  .qu-chat-avatar-sm { width: 1.8rem; height: 1.8rem; font-size: 0.8em; }

  .qu-chat-room-view { display: flex; flex-direction: column; height: 100%; min-height: 0; }
  .qu-chat-header { display: flex; align-items: center; gap: 0.6rem; padding-bottom: 0.5rem; border-bottom: 1px solid #8883; margin-bottom: 0.5rem; }
  .qu-chat-back { text-decoration: none; color: inherit; font-size: 1.3em; padding: 0 0.3rem; }
  .qu-chat-header-info { flex: 1; min-width: 0; display: flex; flex-direction: column; cursor: default; }
  .qu-chat-header-info button { all: unset; cursor: pointer; }
  .qu-chat-header-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .qu-chat-presence { font-size: 0.8em; opacity: 0.65; display: flex; align-items: center; gap: 0.3rem; }
  .qu-chat-presence-dot { width: 0.5rem; height: 0.5rem; border-radius: 50%; background: #888; }
  .qu-chat-presence-dot[data-online="true"] { background: #3cb371; }
  .qu-chat-encrypted-hint { font-size: 0.72em; opacity: 0.5; display: flex; align-items: center; gap: 0.25rem; }

  .qu-chat-members { padding: 0.5rem 0.6rem; border: 1px solid #8884; border-radius: 0.5rem; margin-bottom: 0.5rem; display: flex; flex-direction: column; gap: 0.4rem; }
  .qu-chat-members-row { display: flex; align-items: center; gap: 0.5rem; }
  .qu-chat-members-close { margin-left: auto; background: none; border: none; cursor: pointer; opacity: 0.6; }

  .qu-chat-pinned { display: flex; flex-direction: column; gap: 0.3rem; margin-bottom: 0.5rem; padding: 0.4rem 0.6rem; border-radius: 0.5rem; background: #3390ec14; border: 1px solid #3390ec33; }
  .qu-chat-pinned strong { font-size: 0.8em; opacity: 0.8; }
  .qu-chat-pinned-row { display: flex; align-items: center; gap: 0.5rem; font-size: 0.85em; }
  .qu-chat-pinned-row span { flex: 1; opacity: 0.8; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .qu-chat-pinned-row button { background: none; border: none; cursor: pointer; opacity: 0.6; font-size: 0.85em; }

  .qu-chat-messages { list-style: none; margin: 0; padding: 0.3rem 0; display: flex; flex-direction: column; gap: 0.15rem; flex: 1; min-height: 0; overflow-y: auto; }
  .qu-chat-msg-row { display: flex; gap: 0.5rem; align-items: flex-end; max-width: 100%; }
  .qu-chat-msg-row[data-mine="true"] { flex-direction: row-reverse; }
  .qu-chat-msg-row[data-grouped="true"] { margin-top: -0.05rem; }
  .qu-chat-msg-row:not([data-grouped="true"]) { margin-top: 0.5rem; }
  .qu-chat-msg-avatar-slot { width: 1.8rem; flex-shrink: 0; }
  .qu-chat-message { max-width: min(32rem, 78%); padding: 0.4rem 0.65rem; border-radius: 1rem; background: #8882; position: relative; }
  .qu-chat-msg-row[data-mine="true"] .qu-chat-message { background: #3390ec; color: #fff; border-bottom-right-radius: 0.25rem; }
  .qu-chat-msg-row[data-mine="false"] .qu-chat-message { border-bottom-left-radius: 0.25rem; }
  .qu-chat-author { display: block; font-size: 0.78em; font-weight: 600; opacity: 0.85; margin-bottom: 0.1rem; }
  .qu-chat-reply-quote, .qu-chat-forward-note { font-size: 0.8em; opacity: 0.75; border-left: 2px solid currentColor; padding-left: 0.4rem; margin-bottom: 0.3rem; }
  .qu-chat-body { white-space: pre-wrap; overflow-wrap: break-word; }
  .qu-chat-attachment img, .qu-chat-attachment video { max-width: 100%; max-height: 18rem; border-radius: 0.6rem; margin-top: 0.3rem; display: block; }
  .qu-chat-attachment a { display: inline-flex; align-items: center; gap: 0.3rem; margin-top: 0.3rem; color: inherit; }
  .qu-chat-msg-footer { display: flex; align-items: center; gap: 0.35rem; margin-top: 0.15rem; font-size: 0.68em; opacity: 0.65; }
  .qu-chat-message-actions { display: flex; gap: 0.3rem; align-items: center; flex-wrap: wrap; margin-top: 0.25rem; }
  .qu-chat-message-actions button { background: none; border: none; cursor: pointer; opacity: 0.55; font-size: 0.85em; padding: 0.1rem 0.2rem; }
  .qu-chat-message-actions button:hover { opacity: 1; }
  .qu-chat-reaction-chip { border: 1px solid #8886; border-radius: 1rem; padding: 0.05rem 0.4rem; font-size: 0.85em; cursor: pointer; background: #fff2; }
  .qu-chat-reaction-chip[data-mine="true"] { background: #3390ec33; border-color: #3390ec; }
  .qu-chat-reaction-picker { display: flex; gap: 0.2rem; }
  .qu-chat-reply-banner { display: flex; align-items: center; gap: 0.5rem; font-size: 0.85em; opacity: 0.85; padding: 0.35rem 0.6rem; border-radius: 0.5rem; background: #8882; margin-bottom: 0.4rem; }
  .qu-chat-reply-banner span { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .qu-chat-reply-banner button { background: none; border: none; cursor: pointer; opacity: 0.6; }
  .qu-chat-composer { display: flex; gap: 0.4rem; align-items: center; padding-top: 0.4rem; }
  .qu-chat-composer textarea { flex: 1; resize: none; max-height: 7rem; font: inherit; padding: 0.55rem 0.9rem; border-radius: 1.3rem; border: 1px solid #8884; background: transparent; color: inherit; }
  .qu-chat-attach-btn, .qu-chat-send-btn { border: none; background: #8882; border-radius: 50%; width: 2.4rem; height: 2.4rem; flex-shrink: 0; cursor: pointer; font-size: 1.1em; display: flex; align-items: center; justify-content: center; }
  .qu-chat-send-btn { background: #3390ec; color: #fff; }
  .qu-chat-send-btn:hover { background: #2b7cd3; }
  .qu-chat-pending-attachment { font-size: 0.8em; opacity: 0.8; display: flex; align-items: center; gap: 0.4rem; margin-bottom: 0.3rem; }

  .qu-chat-new-group { border: 1px solid #8884; border-radius: 0.6rem; padding: 0.7rem; margin-bottom: 0.7rem; display: flex; flex-direction: column; gap: 0.6rem; }
  .qu-chat-new-group input[type="text"] { padding: 0.5rem 0.7rem; border-radius: 0.5rem; border: 1px solid #8884; background: transparent; color: inherit; font: inherit; }
  .qu-chat-member-picker { display: flex; flex-direction: column; gap: 0.3rem; max-height: 12rem; overflow-y: auto; }
  .qu-chat-member-picker label { display: flex; align-items: center; gap: 0.5rem; }
  .qu-chat-new-group-actions { display: flex; gap: 0.5rem; justify-content: flex-end; }
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

function fmtTime(ts) {
  if (!ts) return '';
  const date = new Date(ts);
  const sameDay = date.toDateString() === new Date().toDateString();
  return sameDay ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : date.toLocaleDateString([], { day: '2-digit', month: '2-digit' });
}

function colorFor(seed) {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_PALETTE[hash % AVATAR_PALETTE.length];
}

function initialsOf(name) {
  return (name || '?').trim().slice(0, 1).toUpperCase();
}

/** @param {string} seed - Stable identity for color (a pub, or a groupId). @param {string} label - Display name/alias to derive initials from. @param {string|null} [avatarValue] - Profile `avatar` field: an emoji/short string, or an image URL. */
function renderAvatar(seed, label, avatarValue, { small = false } = {}) {
  const el = document.createElement('div');
  el.className = small ? 'qu-chat-avatar qu-chat-avatar-sm' : 'qu-chat-avatar';
  el.style.background = colorFor(seed);
  if (avatarValue && /^https?:\/\//.test(avatarValue)) {
    const img = document.createElement('img');
    img.src = avatarValue;
    img.alt = '';
    el.appendChild(img);
  } else if (avatarValue) {
    el.textContent = avatarValue;
  } else {
    el.textContent = initialsOf(label);
  }
  return el;
}

function attachmentPreviewLabel(attachment) {
  if (!attachment) return '';
  if (attachment.mime?.startsWith('image/')) return `📷 ${t('photo')}`;
  if (attachment.mime?.startsWith('video/')) return `🎥 ${t('video')}`;
  return `📎 ${t('file')}`;
}

export function mount(container, { qu, services, segments, subscribe }) {
  ensureStyle();
  let stopped = false;
  let unwatch = null;
  let unwatchPins = null;
  const reactionUnwatches = new Map(); // messageId -> unwatch(), see reload()'s watchReactions() below
  let stopHeartbeat = null;
  let presenceTimer = null;

  container.classList.add('qu-chat-app');

  // See apps/forum/client.js's identical call for why this is needed - the
  // shell's own default subscriptions don't cover this app's space. Two
  // separate subscriptions, not one: an attachment's binary CHUNKS live
  // under the `blob` mount (`/blob/<space>/...`, see @qu/engines'
  // AssetEngine and its `toBlobPath()`), a completely different top-level
  // prefix from the message/metadata documents under `/store/<space>/...`.
  subscribe(`/store/${SPACE}`);
  subscribe(`/blob/${SPACE}`);

  const isGroupRoute = segments[1] === 'g';
  const groupId = isGroupRoute ? (segments[2] ?? null) : null;
  const peerActorPub = !isGroupRoute ? (segments[1] ?? null) : null;

  (async () => {
    const myActorPub = await services.actors.whoAmI();
    if (stopped) return;

    // Group invites arrive here (see @qu/services' ChatService) - subscribed
    // unconditionally, not just on the room-list route, so a group room
    // opened directly via a shared groupId still gets live invite traffic
    // (e.g. this identity's OWN createGroup() call, from another tab).
    const inviteSpace = await services.chat.myInviteSpace();
    if (stopped) return;
    subscribe(`/store/${inviteSpace}`);

    if (groupId) await renderRoom(myActorPub, { type: 'group', groupId });
    else if (peerActorPub) await renderRoom(myActorPub, { type: 'direct', peerActorPub });
    else await renderRoomList(myActorPub);
  })();

  async function renderRoomList(myActorPub) {
    if (stopped) return;
    container.textContent = '';

    const header = document.createElement('div');
    header.className = 'qu-chat-list-header';
    const heading = document.createElement('h1');
    heading.textContent = t('title');
    const newGroupBtn = document.createElement('button');
    newGroupBtn.type = 'button';
    newGroupBtn.className = 'qu-chat-new-group-btn';
    newGroupBtn.textContent = '+';
    newGroupBtn.title = t('newGroup');
    header.append(heading, newGroupBtn);
    container.appendChild(header);

    const formSlot = document.createElement('div');
    container.appendChild(formSlot);
    newGroupBtn.addEventListener('click', () => renderNewGroupForm(formSlot, myActorPub));

    const [contacts, groupIds] = await Promise.all([services.contacts.listContacts(), services.chat.listMyGroups()]);
    if (stopped) return;

    const rooms = [];
    for (const { actorPub, profile } of contacts) {
      const id = await roomId([myActorPub, actorPub]);
      rooms.push({ type: 'direct', href: `#/chat/${actorPub}`, seed: actorPub, name: profile?.alias || `~${actorPub.slice(0, 10)}…`, avatar: profile?.avatar ?? null, spaceId: SPACE, threadId: id });
    }
    for (const id of groupIds) {
      const config = await services.threads.getConfig(SPACE, id);
      if (!config) continue; // invited, but the group's own config hasn't synced to this session yet
      rooms.push({ type: 'group', href: `#/chat/g/${id}`, seed: id, name: config.name || id, avatar: '👥', spaceId: SPACE, threadId: id });
    }
    if (stopped) return;

    if (rooms.length === 0) {
      const empty = document.createElement('p');
      empty.textContent = t('empty');
      container.appendChild(empty);
      return;
    }

    // Enrich with last message + unread count, then sort newest-activity-first.
    await Promise.all(rooms.map(async (room) => {
      const [messages, lastReadAt] = await Promise.all([
        services.threads.listMessages(room.spaceId, room.threadId),
        services.threads.getLastReadAt(room.spaceId, room.threadId),
      ]);
      const last = messages[messages.length - 1] ?? null;
      room.lastTs = last?.ts ?? 0;
      room.previewText = last ? (last.body?.trim() || attachmentPreviewLabel(last.attachment)) : '';
      room.unread = messages.filter((m) => (m.ts ?? 0) > lastReadAt && m.author !== myActorPub).length;
    }));
    if (stopped) return;
    rooms.sort((a, b) => b.lastTs - a.lastTs);

    const list = document.createElement('ul');
    list.className = 'qu-chat-rooms';
    for (const room of rooms) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.className = 'qu-chat-room-link';
      a.href = room.href;
      a.append(renderAvatar(room.seed, room.name, room.avatar));

      const main = document.createElement('div');
      main.className = 'qu-chat-room-main';
      const top = document.createElement('div');
      top.className = 'qu-chat-room-top';
      const name = document.createElement('span');
      name.className = 'qu-chat-room-name';
      name.textContent = room.name;
      top.appendChild(name);
      if (room.lastTs) {
        const time = document.createElement('span');
        time.className = 'qu-chat-room-time';
        time.textContent = fmtTime(room.lastTs);
        top.appendChild(time);
      }
      const bottom = document.createElement('div');
      bottom.className = 'qu-chat-room-bottom';
      const preview = document.createElement('span');
      preview.className = 'qu-chat-room-preview';
      preview.textContent = room.previewText;
      bottom.appendChild(preview);
      if (room.unread > 0) {
        const badge = document.createElement('span');
        badge.className = 'qu-chat-unread-badge';
        badge.textContent = String(room.unread);
        bottom.appendChild(badge);
      }
      main.append(top, bottom);
      a.appendChild(main);
      li.appendChild(a);
      list.appendChild(li);
    }
    container.appendChild(list);
  }

  async function renderNewGroupForm(slot, myActorPub) {
    slot.textContent = '';
    const contacts = await services.contacts.listContacts();
    if (stopped) return;

    const form = document.createElement('form');
    form.className = 'qu-chat-new-group';

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.placeholder = t('groupName');
    nameInput.required = true;
    form.appendChild(nameInput);

    if (contacts.length === 0) {
      const note = document.createElement('p');
      note.textContent = t('noContacts');
      form.appendChild(note);
    } else {
      const label = document.createElement('div');
      label.textContent = t('selectMembers');
      form.appendChild(label);
      const picker = document.createElement('div');
      picker.className = 'qu-chat-member-picker';
      for (const { actorPub, profile } of contacts) {
        const row = document.createElement('label');
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.value = actorPub;
        const span = document.createElement('span');
        span.textContent = profile?.alias || `~${actorPub.slice(0, 10)}…`;
        row.append(checkbox, span);
        picker.appendChild(row);
      }
      form.appendChild(picker);
    }

    const actions = document.createElement('div');
    actions.className = 'qu-chat-new-group-actions';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.textContent = t('cancel');
    cancelBtn.addEventListener('click', () => { slot.textContent = ''; });
    const createBtn = document.createElement('button');
    createBtn.type = 'submit';
    createBtn.textContent = t('create');
    actions.append(cancelBtn, createBtn);
    form.appendChild(actions);

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const name = nameInput.value.trim();
      if (!name) return;
      const memberPubs = [...form.querySelectorAll('input[type="checkbox"]:checked')].map((el) => el.value);
      createBtn.disabled = true;
      const { groupId: newGroupId } = await services.chat.createGroup({ name, memberPubs });
      location.hash = `#/chat/g/${newGroupId}`;
    });

    slot.appendChild(form);
  }

  async function renderRoom(myActorPub, target) {
    container.textContent = '';

    let spaceId, threadId, config, headerName, headerAvatar, headerSeed;
    if (target.type === 'group') {
      spaceId = SPACE;
      threadId = target.groupId;
      config = await services.threads.getConfig(spaceId, threadId);
      if (stopped) return;
      if (!config || config.kind !== 'group' || !config.readers?.includes(myActorPub)) {
        const back = document.createElement('a');
        back.className = 'qu-chat-back';
        back.href = '#/chat';
        back.textContent = t('back');
        const msg = document.createElement('p');
        msg.textContent = t('groupNotFound');
        container.append(back, msg);
        return;
      }
      headerName = config.name || threadId;
      headerAvatar = '👥';
      headerSeed = threadId;
    } else {
      spaceId = SPACE;
      threadId = await roomId([myActorPub, target.peerActorPub]);
      if (stopped) return;
      config = await services.threads.createThread(spaceId, threadId, THREAD_PRESETS.chat([myActorPub, target.peerActorPub]));
      if (stopped) return;
      const theirProfile = await services.profile.getPublicProfile(target.peerActorPub);
      if (stopped) return;
      headerName = theirProfile?.alias || `~${target.peerActorPub.slice(0, 10)}…`;
      headerAvatar = theirProfile?.avatar ?? null;
      headerSeed = target.peerActorPub;
    }

    const memberPubs = config.readers;
    const readerPubsForEncryption = config.readers !== '*' ? config.readers : null;
    const isGroup = target.type === 'group';

    const header = document.createElement('div');
    header.className = 'qu-chat-header';
    const back = document.createElement('a');
    back.className = 'qu-chat-back';
    back.href = '#/chat';
    back.textContent = t('back');
    header.appendChild(back);
    header.appendChild(renderAvatar(headerSeed, headerName, headerAvatar));

    const headerInfo = document.createElement('div');
    headerInfo.className = 'qu-chat-header-info';
    const nameEl = document.createElement('span');
    nameEl.className = 'qu-chat-header-name';
    nameEl.textContent = headerName;
    headerInfo.appendChild(nameEl);

    const presenceEl = document.createElement('span');
    presenceEl.className = 'qu-chat-presence';
    const membersToggle = document.createElement('button');
    membersToggle.type = 'button';
    membersToggle.textContent = t('membersCount', { count: memberPubs.length });
    if (isGroup) headerInfo.appendChild(membersToggle);
    else headerInfo.appendChild(presenceEl);
    header.appendChild(headerInfo);
    container.appendChild(header);

    const membersEl = document.createElement('div');
    membersEl.className = 'qu-chat-members';
    membersEl.hidden = true;
    if (isGroup) container.appendChild(membersEl);
    membersToggle.addEventListener('click', async () => {
      if (!membersEl.hidden) { membersEl.hidden = true; return; }
      membersEl.textContent = '';
      const heading = document.createElement('strong');
      heading.textContent = t('members');
      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'qu-chat-members-close';
      closeBtn.textContent = t('close');
      closeBtn.addEventListener('click', () => { membersEl.hidden = true; });
      const headRow = document.createElement('div');
      headRow.className = 'qu-chat-members-row';
      headRow.append(heading, closeBtn);
      membersEl.appendChild(headRow);
      for (const pub of memberPubs) {
        const profile = pub === myActorPub ? null : await services.profile.getPublicProfile(pub);
        const row = document.createElement('div');
        row.className = 'qu-chat-members-row';
        row.append(renderAvatar(pub, profile?.alias || pub, profile?.avatar ?? null, { small: true }));
        const label = document.createElement('span');
        label.textContent = pub === myActorPub ? t('you') : (profile?.alias || `~${pub.slice(0, 10)}…`);
        row.appendChild(label);
        membersEl.appendChild(row);
      }
      membersEl.hidden = false;
    });

    const encHint = document.createElement('div');
    encHint.className = 'qu-chat-encrypted-hint';
    encHint.textContent = `🔒 ${t('encrypted')}`;
    container.appendChild(encHint);

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
    attachBtn.className = 'qu-chat-attach-btn';
    attachBtn.textContent = '📎';
    attachBtn.title = t('attach');
    const input = document.createElement('textarea');
    input.rows = 1;
    input.placeholder = t('composerPlaceholder');
    input.required = true;
    const sendBtn = document.createElement('button');
    sendBtn.type = 'submit';
    sendBtn.className = 'qu-chat-send-btn';
    sendBtn.textContent = '➤';
    sendBtn.title = t('send');
    form.append(fileInput, attachBtn, input, sendBtn);
    container.appendChild(form);

    let replyTo = null; // { id, author, body }
    let pendingFile = null;
    let profileCache = new Map();

    async function nameFor(actorPub) {
      if (actorPub === myActorPub) return t('you');
      if (!isGroup) return headerName;
      if (!profileCache.has(actorPub)) {
        profileCache.set(actorPub, await services.profile.getPublicProfile(actorPub));
      }
      const profile = profileCache.get(actorPub);
      return profile?.alias || `~${actorPub.slice(0, 10)}…`;
    }

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

    // reload() is triggered from two places that can land close together -
    // a direct call right after posting, and watch()'s own callback firing
    // for that same write - and messageRow() below has several real await
    // points (attachment lookups, reactions, profile resolution). Without
    // a generation guard, a second reload() starting mid-build of the
    // first would race it: the first's now-stale `await messageRow(...)`
    // calls keep resolving and appending into `listEl` even after the
    // second reload() already cleared and rebuilt it, leaving duplicated
    // or stale rows behind. Each reload() checks it's still the LATEST
    // one before every DOM mutation and bails out otherwise.
    let renderToken = 0;
    async function reload() {
      if (stopped) return;
      const myToken = ++renderToken;
      const messages = await services.threads.listMessages(spaceId, threadId);
      const pinnedIds = await services.threads.listPinned(spaceId, threadId);
      if (stopped || myToken !== renderToken) return;

      watchReactions(messages);
      renderPinned(pinnedEl, messages, pinnedIds);

      listEl.textContent = '';
      if (messages.length === 0) {
        const li = document.createElement('li');
        li.textContent = t('empty');
        listEl.appendChild(li);
      } else {
        let prevAuthor = null;
        for (const message of messages) {
          const grouped = message.author === prevAuthor;
          const row = await messageRow(message, messages, pinnedIds.includes(message.id), grouped);
          if (myToken !== renderToken) return; // a newer reload() started mid-loop - abandon this stale one
          listEl.appendChild(row);
          prevAuthor = message.author;
        }
        listEl.scrollTop = listEl.scrollHeight;
      }
      services.threads.markRead(spaceId, threadId).catch(() => {});
    }

    // Reactions live in a SEPARATE per-message collection (see
    // ThreadService.setReaction()'s doc comment), not the messages
    // collection reload() is already watching below - without this, a
    // reaction from another member would silently never appear here until
    // something ELSE happened to trigger a reload (e.g. this identity's
    // own next message). Keeps one watch per currently-known message id,
    // added as new messages appear; never removed (messages aren't
    // deleted in this app, so there's nothing to prune).
    function watchReactions(messages) {
      for (const message of messages) {
        if (reactionUnwatches.has(message.id)) continue;
        const path = paths.collectionPath(spaceId, paths.threadReactionsCollectionId(threadId, message.id));
        reactionUnwatches.set(message.id, watch(qu, path, reload, { initial: false }));
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

    async function messageRow(message, allMessages, isPinned, grouped) {
      const mine = message.author === myActorPub;
      const row = document.createElement('li');
      row.className = 'qu-chat-msg-row';
      row.dataset.mine = String(mine);
      row.dataset.grouped = String(grouped);

      const avatarSlot = document.createElement('div');
      avatarSlot.className = 'qu-chat-msg-avatar-slot';
      if (isGroup && !mine && !grouped) {
        const profile = profileCache.get(message.author);
        avatarSlot.appendChild(renderAvatar(message.author, profile?.alias || message.author, profile?.avatar ?? null, { small: true }));
      }
      if (isGroup && !mine) row.appendChild(avatarSlot);

      const bubble = document.createElement('div');
      bubble.className = 'qu-chat-message';

      if (isGroup && !mine && !grouped) {
        const author = document.createElement('span');
        author.className = 'qu-chat-author';
        author.textContent = await nameFor(message.author);
        bubble.appendChild(author);
      }

      if (message.forwardedFrom) {
        const note = document.createElement('div');
        note.className = 'qu-chat-forward-note';
        note.textContent = t('forwardedFrom', { name: message.forwardedFrom.author?.slice(0, 10) ?? '?' });
        bubble.appendChild(note);
      }
      if (message.replyTo) {
        const quoted = allMessages.find((m) => m.id === message.replyTo);
        if (quoted) {
          const quote = document.createElement('div');
          quote.className = 'qu-chat-reply-quote';
          quote.textContent = quoted.body.slice(0, 80);
          bubble.appendChild(quote);
        }
      }

      if (message.body) {
        const body = document.createElement('div');
        body.className = 'qu-chat-body';
        body.textContent = message.body;
        bubble.appendChild(body);
      }

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
        } else if (message.attachment.mime?.startsWith('video/')) {
          const video = document.createElement('video');
          video.controls = true;
          services.assets.download(spaceId, message.attachment.assetId).then((asset) => {
            if (stopped || !asset) return;
            video.src = URL.createObjectURL(new Blob([asset.data], { type: asset.meta.mime }));
          });
          attEl.appendChild(video);
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
        bubble.appendChild(attEl);
      }

      const footer = document.createElement('div');
      footer.className = 'qu-chat-msg-footer';
      const time = document.createElement('span');
      time.textContent = fmtTime(message.ts);
      footer.appendChild(time);
      bubble.appendChild(footer);

      const actions = document.createElement('div');
      actions.className = 'qu-chat-message-actions';

      const reactions = await services.threads.getReactions(spaceId, threadId, message.id);
      for (const [emoji, reactorPubs] of Object.entries(reactions)) {
        if (reactorPubs.length === 0) continue;
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'qu-chat-reaction-chip';
        const mineReaction = reactorPubs.includes(myActorPub);
        chip.dataset.mine = String(mineReaction);
        chip.textContent = `${emoji} ${reactorPubs.length}`;
        chip.addEventListener('click', async () => {
          await services.threads.setReaction(spaceId, threadId, message.id, mineReaction ? null : emoji);
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
      bubble.appendChild(actions);
      row.appendChild(bubble);
      return row;
    }

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const body = input.value.trim();
      if (!body && !pendingFile) return;
      input.value = '';

      const extra = {};
      if (replyTo) extra.replyTo = replyTo.id; // also passed as the top-level param below - kept in sync, never diverging
      if (pendingFile) {
        // Encrypted for the SAME reader list as the message body sitting
        // next to it (readerPubsForEncryption === config.readers, or null
        // for a public/`*` thread) - see AssetService.upload()'s own doc
        // comment for how this closes the "attachment is the one
        // unencrypted part of an E2E thread" gap.
        const assetId = crypto.randomUUID();
        const meta = await services.assets.upload(spaceId, assetId, pendingFile, { readerPubs: readerPubsForEncryption });
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

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        form.requestSubmit();
      }
    });

    await reload();
    unwatch = watch(qu, paths.collectionPath(spaceId, paths.threadMessagesCollectionId(threadId)), reload, { initial: false });
    unwatchPins = watch(qu, paths.collectionPath(spaceId, paths.threadPinsCollectionId(threadId)), reload, { initial: false });

    if (!isGroup) {
      stopHeartbeat = services.threads.startHeartbeat(spaceId, threadId);
      async function refreshPresence() {
        if (stopped) return;
        const presence = await services.threads.getPresence(spaceId, threadId, memberPubs);
        const theirs = presence[target.peerActorPub];
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
  }

  return () => {
    stopped = true;
    unwatch?.();
    unwatchPins?.();
    for (const unwatchOne of reactionUnwatches.values()) unwatchOne();
    reactionUnwatches.clear();
    stopHeartbeat?.();
    if (presenceTimer) clearInterval(presenceTimer);
  };
}
