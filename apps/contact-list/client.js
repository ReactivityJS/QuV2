/**
 * CONTACT LIST — everyone this identity has starred as a contact (see
 * @qu/services/contacts-service.js), the User List app's counterpart -
 * that app ADDS contacts, this one just shows/removes them, each with
 * their CURRENT public profile resolved live from the network (not a
 * snapshot taken at contact-time).
 *
 * Each row's action links (Chat today, potentially Call/others later) are
 * NOT hardcoded here - this app exposes a "contact-row" SLOT, and renders
 * whatever OTHER apps declared for it in their own manifest's `actions`
 * field (see @qu/foundation/actions.js's `actionsForSlot()`). Contact
 * List has never heard of Chat; Chat's manifest just declares `{slot:
 * "contact-row", id: "chat", hrefTemplate: "#/chat/{pub}"}`, and this file
 * resolves `{pub}` per contact. A future Call app (or anything else) shows
 * up here automatically the moment its manifest declares the same slot -
 * no change needed on this side.
 *
 * Also has a search box filtering by alias or pub/FP substring. Unlike User
 * List, there's no "not listed" lookup needed here: a contact's profile is
 * already resolved live regardless of whether they ever opted into the
 * public directory (see the doc comment above) - once someone's been added
 * as a Contact (e.g. via User List's own FP lookup for someone unlisted),
 * they just show up here like anyone else.
 */
import { createI18n } from '@qu/i18n';
import { actionsForSlot, resolveActionHref } from '@qu/foundation';
import { renderAvatar, injectStyle } from '@qu/ui';
import { formatActorLabel, matchesActorQuery } from '@qu/services';

const DICT = {
  en: {
    title: 'Contacts',
    empty: 'No contacts yet — add some from the User List.',
    noMatch: 'No contact matches that alias or FP.',
    searchPlaceholder: 'Search by alias or FP…',
    remove: 'Remove',
  },
  de: {
    title: 'Kontakte',
    empty: 'Noch keine Kontakte — in der Nutzerliste hinzufügen.',
    noMatch: 'Kein Kontakt passt zu Alias oder FP.',
    searchPlaceholder: 'Suche nach Alias oder FP…',
    remove: 'Entfernen',
  },
};
const { t } = createI18n(DICT);

const STYLE_ID = 'qu-contact-list-style';
const STYLE = `
  .qu-contact-search { width: 100%; box-sizing: border-box; margin: 0 0 0.6rem; padding: 0.5rem 0.7rem; border: 1px solid #8884; border-radius: 0.4rem; font: inherit; }
  .qu-contact-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.4rem; }
  .qu-contact-list li { display: flex; align-items: center; gap: 0.6rem; padding: 0.5rem 0.7rem; border: 1px solid #8884; border-radius: 0.4rem; }
  .qu-contact-list .qu-contact-name { flex: 1; font-family: ui-monospace, monospace; text-decoration: none; color: inherit; }
  .qu-contact-list .qu-contact-name:hover { text-decoration: underline; }
  .qu-contact-list button { background: none; border: 1px solid #8884; border-radius: 0.3rem; cursor: pointer; padding: 0.2rem 0.5rem; }
  .qu-contact-list .qu-contact-action { text-decoration: none; font-size: 1.1em; }
`;


const CONTACT_ROW_SLOT = 'contact-row';

export function mount(container, { services, apps }) {
  injectStyle(STYLE_ID, STYLE);
  let stopped = false;
  let filterText = '';
  let contacts = [];
  const rowActions = actionsForSlot(apps, CONTACT_ROW_SLOT);

  const heading = document.createElement('h1');
  heading.textContent = t('title');

  const search = document.createElement('input');
  search.type = 'search';
  search.className = 'qu-contact-search';
  search.placeholder = t('searchPlaceholder');
  search.addEventListener('input', () => {
    filterText = search.value;
    renderResults();
  });

  const resultsEl = document.createElement('div');
  container.append(heading, search, resultsEl);

  function matches({ actorPub, profile }) {
    return matchesActorQuery(actorPub, profile, filterText);
  }

  function renderResults() {
    if (stopped) return;
    resultsEl.textContent = '';

    if (contacts.length === 0) {
      const empty = document.createElement('p');
      empty.textContent = t('empty');
      resultsEl.appendChild(empty);
      return;
    }

    const filtered = contacts.filter(matches);
    if (filtered.length === 0) {
      const empty = document.createElement('p');
      empty.textContent = t('noMatch');
      resultsEl.appendChild(empty);
      return;
    }

    const list = document.createElement('ul');
    list.className = 'qu-contact-list';
    for (const contact of filtered) list.appendChild(row(contact, services, refresh, rowActions));
    resultsEl.appendChild(list);
  }

  // A named, reusable refresh function (rather than mount() calling itself)
  // so a Remove click's refresh reuses this ONE closure's `stopped` flag -
  // an inner `mount(container, ...)` call would spin up an independent
  // `stopped` of its own that the shell's stop function (returned below)
  // could never reach, and a stale in-flight render could then write into
  // `container` after the shell had already unmounted this app.
  async function refresh() {
    const fetched = await services.contacts.listContacts();
    if (stopped) return;
    contacts = fetched;
    renderResults();
  }

  refresh();

  return () => { stopped = true; };
}

function row({ actorPub, profile }, services, refresh, rowActions) {
  const li = document.createElement('li');
  const alias = formatActorLabel(actorPub, profile);
  li.appendChild(renderAvatar(actorPub, alias, profile?.avatar, { size: '2.2rem' }));
  const name = document.createElement('a');
  name.className = 'qu-contact-name';
  name.href = `#/~${actorPub}`;
  name.textContent = alias;
  li.appendChild(name);

  // Every action any OTHER app declared for the "contact-row" slot (see
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
