/**
 * CONTACT LIST — everyone this identity has starred as a contact (see
 * @qu/services/contacts-service.js), the User List app's counterpart -
 * that app ADDS contacts, this one just shows/removes them, each with
 * their CURRENT public profile resolved live from the network (not a
 * snapshot taken at contact-time).
 */
import { createI18n } from '@qu/i18n';

const DICT = {
  en: { title: 'Contacts', empty: 'No contacts yet — add some from the User List.', remove: 'Remove' },
  de: { title: 'Kontakte', empty: 'Noch keine Kontakte — in der Nutzerliste hinzufügen.', remove: 'Entfernen' },
};
const { t } = createI18n(DICT);

const STYLE_ID = 'qu-contact-list-style';
const STYLE = `
  .qu-contact-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.4rem; }
  .qu-contact-list li { display: flex; align-items: center; gap: 0.6rem; padding: 0.5rem 0.7rem; border: 1px solid #8884; border-radius: 0.4rem; }
  .qu-contact-list .qu-contact-name { flex: 1; font-family: ui-monospace, monospace; }
  .qu-contact-list button { background: none; border: 1px solid #8884; border-radius: 0.3rem; cursor: pointer; padding: 0.2rem 0.5rem; }
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

  // A named, reusable render function (rather than mount() calling itself)
  // so a Remove click's refresh reuses this ONE closure's `stopped` flag -
  // an inner `mount(container, ...)` call would spin up an independent
  // `stopped` of its own that the shell's stop function (returned below)
  // could never reach, and a stale in-flight render could then write into
  // `container` after the shell had already unmounted this app.
  async function render() {
    const contacts = await services.contacts.listContacts();
    if (stopped) return;
    container.textContent = '';

    const heading = document.createElement('h1');
    heading.textContent = t('title');

    if (contacts.length === 0) {
      const empty = document.createElement('p');
      empty.textContent = t('empty');
      container.append(heading, empty);
      return;
    }

    const list = document.createElement('ul');
    list.className = 'qu-contact-list';
    for (const contact of contacts) list.appendChild(row(contact, services, render));

    container.append(heading, list);
  }

  render();

  return () => { stopped = true; };
}

function row({ actorPub, profile }, services, refresh) {
  const li = document.createElement('li');
  const name = document.createElement('span');
  name.className = 'qu-contact-name';
  name.textContent = profile?.alias ?? `~${actorPub.slice(0, 16)}…`;

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.textContent = t('remove');
  removeBtn.addEventListener('click', async () => {
    await services.contacts.removeContact(actorPub);
    await refresh();
  });

  li.append(name, removeBtn);
  return li;
}
