/**
 * USER LIST — every identity that opted into DirectoryService's public
 * "listed" collection (see @qu/services/directory-service.js; toggled from
 * the shell's own home screen), each with a Contact toggle - favoriting a
 * user HERE is exactly what turns them into a Contact (ContactsService),
 * the same list the Contact List app (apps/contact-list) reads. Excludes
 * the viewer's own entry - you can't "contact" yourself.
 */
import { createI18n } from '@qu/i18n';

const DICT = {
  en: { title: 'User List', empty: 'Nobody has opted into the directory yet.' },
  de: { title: 'Nutzerliste', empty: 'Noch niemand hat sich in die Nutzerliste eingetragen.' },
};
const { t } = createI18n(DICT);

const STYLE_ID = 'qu-user-list-style';
const STYLE = `
  .qu-user-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.4rem; }
  .qu-user-list li { display: flex; align-items: center; gap: 0.6rem; padding: 0.5rem 0.7rem; border: 1px solid #8884; border-radius: 0.4rem; }
  .qu-user-list .qu-user-name { flex: 1; font-family: ui-monospace, monospace; }
  .qu-user-list button { background: none; border: none; cursor: pointer; font-size: 1.1em; }
`;

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  document.head.appendChild(style);
}

export function mount(container, { services }) {
  ensureStyle();
  let stopped = false;

  (async () => {
    const [visible, myActorPub, contacts] = await Promise.all([
      services.directory.listVisible(),
      services.actors.whoAmI(),
      services.contacts.listContacts(),
    ]);
    const others = visible.filter((entry) => entry.actorPub !== myActorPub);
    const contactPubs = new Set(contacts.map((c) => c.actorPub));
    if (stopped) return;

    const heading = document.createElement('h1');
    heading.textContent = t('title');

    if (others.length === 0) {
      const empty = document.createElement('p');
      empty.textContent = t('empty');
      container.append(heading, empty);
      return;
    }

    const list = document.createElement('ul');
    list.className = 'qu-user-list';
    for (const entry of others) {
      const profile = await services.actors.getProfile(entry.actorPub);
      if (stopped) return;
      list.appendChild(row(entry.actorPub, profile, contactPubs.has(entry.actorPub), services));
    }

    container.append(heading, list);
  })();

  return () => { stopped = true; };
}

function row(actorPub, profile, isContact, services) {
  const li = document.createElement('li');
  const name = document.createElement('span');
  name.className = 'qu-user-name';
  name.textContent = profile?.alias ?? `~${actorPub.slice(0, 16)}…`;

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

  li.append(name, toggle);
  return li;
}
