/**
 * CONTACT LIST — everyone this identity has starred as a contact (see
 * @qu/services/contacts-service.js), the User List app's counterpart -
 * that app ADDS contacts, this one just shows/removes them, each with
 * their CURRENT public profile resolved live from the network (not a
 * snapshot taken at contact-time).
 *
 * Each row's action links (Chat today, potentially Call/others later) are
 * NOT hardcoded here - this app exposes a "contact-row" MOUNT, and renders
 * whatever OTHER apps declared for it in their own manifest's `actions`
 * field (see @qu/foundation/actions.js's `actionsForMount()`). Contact
 * List has never heard of Chat; Chat's manifest just declares `{mount:
 * "contact-row", id: "chat", hrefTemplate: "#/chat/{pub}"}`, and this file
 * resolves `{pub}` per contact. A future Call app (or anything else) shows
 * up here automatically the moment its manifest declares the same mount -
 * no change needed on this side.
 */
import { createI18n } from '@qu/i18n';
import { actionsForMount, resolveActionHref } from '@qu/foundation';

const DICT = {
  en: { title: 'Contacts', empty: 'No contacts yet — add some from the User List.', remove: 'Remove' },
  de: { title: 'Kontakte', empty: 'Noch keine Kontakte — in der Nutzerliste hinzufügen.', remove: 'Entfernen' },
};
const { t } = createI18n(DICT);

const STYLE_ID = 'qu-contact-list-style';
const STYLE = `
  .qu-contact-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.4rem; }
  .qu-contact-list li { display: flex; align-items: center; gap: 0.6rem; padding: 0.5rem 0.7rem; border: 1px solid #8884; border-radius: 0.4rem; }
  .qu-contact-list .qu-contact-name { flex: 1; font-family: ui-monospace, monospace; text-decoration: none; color: inherit; }
  .qu-contact-list .qu-contact-name:hover { text-decoration: underline; }
  .qu-contact-list button { background: none; border: 1px solid #8884; border-radius: 0.3rem; cursor: pointer; padding: 0.2rem 0.5rem; }
  .qu-contact-list .qu-contact-action { text-decoration: none; font-size: 1.1em; }
`;

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  document.head.appendChild(style);
}

const CONTACT_ROW_MOUNT = 'contact-row';

export function mount(container, { services, apps }) {
  ensureStyle();
  let stopped = false;
  const rowActions = actionsForMount(apps, CONTACT_ROW_MOUNT);

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
    for (const contact of contacts) list.appendChild(row(contact, services, render, rowActions));

    container.append(heading, list);
  }

  render();

  return () => { stopped = true; };
}

function row({ actorPub, profile }, services, refresh, rowActions) {
  const li = document.createElement('li');
  const name = document.createElement('a');
  name.className = 'qu-contact-name';
  name.href = `#/~${actorPub}`;
  name.textContent = profile?.alias ?? `~${actorPub.slice(0, 16)}…`;
  li.appendChild(name);

  // Every action any OTHER app declared for the "contact-row" mount (see
  // this file's own doc comment) - Chat today, whatever else registers
  // itself here tomorrow, with zero changes needed in THIS file.
  for (const action of rowActions) {
    const link = document.createElement('a');
    link.className = 'qu-contact-action';
    link.href = resolveActionHref(action, { pub: actorPub });
    link.title = action.label;
    link.textContent = action.icon ?? action.label;
    li.appendChild(link);
  }

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.textContent = t('remove');
  removeBtn.addEventListener('click', async () => {
    await services.contacts.removeContact(actorPub);
    await refresh();
  });
  li.appendChild(removeBtn);

  return li;
}
