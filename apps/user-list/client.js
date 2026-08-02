/**
 * USER LIST — every identity that opted into DirectoryService's public
 * "listed" collection (see @qu/services/directory-service.js; toggled from
 * Profile's own settings section - apps/profile/client.js), each showing
 * avatar/alias/pub (the pub links to `#/~<pub>`, the identity's public
 * profile) with a Contact toggle - favoriting a user HERE is exactly what
 * turns them into a Contact (ContactsService), the same list the Contact
 * List app (apps/contact-list) reads. Excludes the viewer's own entry -
 * you can't "contact" yourself.
 *
 * Reactive, not a one-time snapshot: watches the visible-collection path,
 * re-rendering on any change (a new opt-in, someone going invisible again).
 * Backfilling data published before this session subscribed (so it never
 * shows up via subscribe() alone - see SyncEngine's own doc comment) is
 * DirectoryService's/ProfileService's job now, not this app's - see their
 * own `syncFetch` constructor doc comments. This app used to do that
 * backfill inline AND had a real bug alongside it: a still-unsynced
 * directory entry resolves to `null` (see CollectionEngine), and reading
 * `.actorPub` off it in a plain `.filter()` threw, silently leaving the
 * screen blank - "the list is empty" even when it demonstrably wasn't.
 */
import { createI18n } from '@qu/i18n';
import { watch } from '@qu/reactive';
import { paths } from '@qu/services';
import { renderAvatar } from '@qu/ui';

const DICT = {
  en: { title: 'User List', empty: 'Nobody has opted into the directory yet.' },
  de: { title: 'Nutzerliste', empty: 'Noch niemand hat sich in die Nutzerliste eingetragen.' },
};
const { t } = createI18n(DICT);

const STYLE_ID = 'qu-user-list-style';
const STYLE = `
  .qu-user-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.4rem; }
  .qu-user-list li { display: flex; align-items: center; gap: 0.6rem; padding: 0.5rem 0.7rem; border: 1px solid #8884; border-radius: 0.4rem; }
  .qu-user-list .qu-user-info { flex: 1; min-width: 0; display: flex; flex-direction: column; text-decoration: none; color: inherit; }
  .qu-user-list .qu-user-info:hover .qu-user-alias { text-decoration: underline; }
  .qu-user-list .qu-user-alias { font-weight: 600; }
  .qu-user-list .qu-user-pub { font-family: ui-monospace, monospace; font-size: 0.8em; opacity: 0.6; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .qu-user-list button { background: none; border: none; cursor: pointer; font-size: 1.1em; flex-shrink: 0; }
`;

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  document.head.appendChild(style);
}

export function mount(container, { qu, services, subscribe }) {
  ensureStyle();
  let stopped = false;

  // Defense in depth - the shell already subscribes to '/store/directory'
  // by default (see apps/shell/src/main.js's mount()), but this app
  // shouldn't silently depend on that staying true.
  subscribe('/store/directory');

  async function render() {
    if (stopped) return;
    const [visible, myActorPub, contacts] = await Promise.all([
      services.directory.listVisible(),
      services.actors.whoAmI(),
      services.contacts.listContacts(),
    ]);
    if (stopped) return;

    const others = visible.filter((entry) => entry.actorPub !== myActorPub);
    container.textContent = '';

    const heading = document.createElement('h1');
    heading.textContent = t('title');

    if (others.length === 0) {
      const empty = document.createElement('p');
      empty.textContent = t('empty');
      container.append(heading, empty);
      return;
    }

    const contactPubs = new Set(contacts.map((c) => c.actorPub));
    const list = document.createElement('ul');
    list.className = 'qu-user-list';
    for (const entry of others) {
      const profile = await services.profile.getPublicProfile(entry.actorPub);
      if (stopped) return;
      list.appendChild(row(entry.actorPub, profile, contactPubs.has(entry.actorPub), services));
    }

    container.append(heading, list);
  }

  render();
  const unwatch = watch(qu, paths.collectionPath('directory', 'visible'), render, { initial: false });

  return () => {
    stopped = true;
    unwatch();
  };
}

function row(actorPub, profile, isContact, services) {
  const li = document.createElement('li');

  const alias = profile?.alias || `~${actorPub.slice(0, 16)}…`;
  const avatar = renderAvatar(actorPub, alias, profile?.avatar, { size: '2.2rem' });

  const info = document.createElement('a');
  info.className = 'qu-user-info';
  info.href = `#/~${actorPub}`;
  const aliasEl = document.createElement('span');
  aliasEl.className = 'qu-user-alias';
  aliasEl.textContent = alias;
  const pub = document.createElement('span');
  pub.className = 'qu-user-pub';
  pub.textContent = actorPub;
  info.append(aliasEl, pub);

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.textContent = isContact ? '★' : '☆';
  toggle.title = isContact ? 'Remove contact' : 'Add contact';
  toggle.addEventListener('click', async () => {
    const nowContact = toggle.textContent === '★';
    if (nowContact) await services.contacts.removeContact(actorPub);
    else await services.contacts.addContact(actorPub);
    toggle.textContent = nowContact ? '☆' : '★';
  });

  li.append(avatar, info, toggle);
  return li;
}
