/**
 * INBOX — a personal mailbox: THREAD_PRESETS.mail(ownerPub) (anyone can
 * write, only the owner can read - see @qu/services/thread-service.js).
 * Two views, same underlying primitive:
 *   - `#/inbox` - THIS identity's own inbox (space `inbox-<myActorPub>`),
 *     readable because I AM its owner.
 *   - `#/inbox/<recipientActorPub>` - composing INTO someone else's inbox
 *     (space `inbox-<recipientActorPub>`) - writable by anyone, but NOT
 *     readable by me, so after sending, my own message won't reappear in
 *     that view (it's encrypted for the recipient only, not for me too -
 *     exactly how a real mailbox works: sent mail isn't automatically kept
 *     unless you explicitly cc/bcc yourself, which this simple version
 *     doesn't do). The UI says so up front rather than looking broken.
 */
import { THREAD_PRESETS } from '@qu/services';
import { mountThreadView } from '@qu/thread-ui';
import { createI18n } from '@qu/i18n';

const DICT = {
  en: {
    title: 'Inbox',
    compose: 'Write to a contact',
    empty: 'No contacts yet — add some from the User List.',
    composingTo: 'Writing to {name} — they will see this; it will not appear here after sending.',
    back: '← My inbox',
  },
  de: {
    title: 'Posteingang',
    compose: 'An einen Kontakt schreiben',
    empty: 'Noch keine Kontakte — in der Nutzerliste hinzufügen.',
    composingTo: 'Nachricht an {name} — wird bei ihnen angezeigt, nicht hier nach dem Senden.',
    back: '← Mein Posteingang',
  },
};
const { t } = createI18n(DICT);

const STYLE_ID = 'qu-inbox-style';
const STYLE = `
  .qu-inbox-contacts { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.4rem; }
  .qu-inbox-contacts li { padding: 0.4rem 0.6rem; border: 1px solid #8884; border-radius: 0.4rem; }
  .qu-inbox-contacts a { text-decoration: none; color: inherit; }
  .qu-inbox-note { opacity: 0.7; font-size: 0.85em; }
`;

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  document.head.appendChild(style);
}

export function mount(container, { qu, services, segments, subscribe }) {
  ensureStyle();
  let stopped = false;
  let stopThreadView = null;

  const recipientActorPub = segments[1] ?? null;

  (async () => {
    if (recipientActorPub) await renderCompose(recipientActorPub);
    else await renderOwnInbox();
  })();

  async function renderOwnInbox() {
    const myActorPub = await services.actors.whoAmI();
    if (stopped) return;
    container.textContent = '';

    // Live updates for new mail arriving from ANOTHER browser - see
    // apps/forum/client.js's identical call for why this is needed.
    subscribe(`/store/inbox-${myActorPub}`);

    const heading = document.createElement('h1');
    heading.textContent = t('title');
    container.appendChild(heading);

    const threadEl = document.createElement('div');
    container.appendChild(threadEl);
    stopThreadView = mountThreadView(threadEl, {
      qu, services, spaceId: `inbox-${myActorPub}`, threadId: 'inbox',
      threadConfig: THREAD_PRESETS.mail(myActorPub),
    });

    const composeHeading = document.createElement('h2');
    composeHeading.textContent = t('compose');
    container.appendChild(composeHeading);
    await renderContactPicker();
  }

  async function renderContactPicker() {
    const contacts = await services.contacts.listContacts();
    if (stopped) return;
    if (contacts.length === 0) {
      const empty = document.createElement('p');
      empty.textContent = t('empty');
      container.appendChild(empty);
      return;
    }
    const list = document.createElement('ul');
    list.className = 'qu-inbox-contacts';
    for (const { actorPub, profile } of contacts) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = `#/inbox/${actorPub}`;
      a.textContent = profile?.alias ?? `~${actorPub.slice(0, 16)}…`;
      li.appendChild(a);
      list.appendChild(li);
    }
    container.appendChild(list);
  }

  async function renderCompose(recipientPub) {
    const profile = await services.profile.getPublicProfile(recipientPub);
    if (stopped) return;
    container.textContent = '';

    const back = document.createElement('a');
    back.href = '#/inbox';
    back.textContent = t('back');
    container.appendChild(back);

    const note = document.createElement('p');
    note.className = 'qu-inbox-note';
    note.textContent = t('composingTo', { name: profile?.alias ?? `~${recipientPub.slice(0, 16)}…` });
    container.appendChild(note);

    const threadEl = document.createElement('div');
    container.appendChild(threadEl);
    stopThreadView = mountThreadView(threadEl, {
      qu, services, spaceId: `inbox-${recipientPub}`, threadId: 'inbox',
      threadConfig: THREAD_PRESETS.mail(recipientPub),
    });
  }

  return () => {
    stopped = true;
    stopThreadView?.();
  };
}
