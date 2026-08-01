/**
 * CHAT — one room per Contact (see @qu/services' ContactsService), each
 * backed by THREAD_PRESETS.chat([myPub, theirPub]) - a fixed 2-member
 * private, encrypted thread. The room id is DERIVED (sha256 of the two
 * members' pubkeys, sorted first so it doesn't matter who opens it first)
 * rather than created-and-shared, so either side lands in the same room
 * with no separate "invite" step - Contacts is already the mutual-interest
 * signal a 1:1 room needs.
 *
 * Route: `#/chat` (room list = Contacts) or `#/chat/<peerActorPub>` (one room).
 */
import { QuCrypto } from '@qu/core';
import { THREAD_PRESETS } from '@qu/services';
import { mountThreadView } from '@qu/thread-ui';
import { createI18n } from '@qu/i18n';

const SPACE = 'chat';

const DICT = {
  en: { title: 'Chat', empty: 'No contacts yet — add some from the User List to start chatting.', back: '← Chats' },
  de: { title: 'Chat', empty: 'Noch keine Kontakte — in der Nutzerliste hinzufügen, um zu chatten.', back: '← Chats' },
};
const { t } = createI18n(DICT);

const STYLE_ID = 'qu-chat-style';
const STYLE = `
  .qu-chat-rooms { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.4rem; }
  .qu-chat-rooms li { padding: 0.5rem 0.7rem; border: 1px solid #8884; border-radius: 0.4rem; }
  .qu-chat-rooms a { text-decoration: none; color: inherit; font-family: ui-monospace, monospace; }
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

export function mount(container, { qu, services, segments, subscribe }) {
  ensureStyle();
  let stopped = false;
  let stopThreadView = null;

  // See apps/forum/client.js's identical call for why this is needed - the
  // shell's own default subscriptions don't cover this app's space.
  subscribe(`/store/${SPACE}`);

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

    const threadEl = document.createElement('div');
    container.appendChild(threadEl);
    stopThreadView = mountThreadView(threadEl, {
      qu, services, spaceId: SPACE, threadId: id,
      threadConfig: THREAD_PRESETS.chat([myActorPub, theirActorPub]),
    });
  }

  return () => {
    stopped = true;
    stopThreadView?.();
  };
}
