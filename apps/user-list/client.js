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
 *
 * Also includes a search box filtering by alias or pub/FP substring - AND,
 * when the box holds an exact actorPub that ISN'T in the visible collection
 * (someone who never opted into the directory), a live lookup via
 * ProfileService.getPublicProfile() (same backfill-on-miss as everywhere
 * else) that surfaces them as a single "not listed" result anyway. That's
 * the whole point: a directory entry is opt-in discoverability, not a
 * capability gate - anyone who hands you their FP directly should still be
 * addable as a Contact and reachable at `#/~<pub>`, whether or not they're
 * "listed".
 */
import { createI18n } from '@qu/i18n';
import { watch } from '@qu/reactive';
import { paths, formatActorLabel, matchesActorQuery } from '@qu/services';
import { renderAvatar, injectStyle } from '@qu/ui';

const DICT = {
  en: {
    title: 'User List',
    empty: 'Nobody has opted into the directory yet.',
    noMatch: 'No match. Paste a full FP to look someone up directly.',
    searchPlaceholder: 'Search by alias or FP…',
    unlisted: 'Not listed',
  },
  de: {
    title: 'Nutzerliste',
    empty: 'Noch niemand hat sich in die Nutzerliste eingetragen.',
    noMatch: 'Kein Treffer. Vollständige FP einfügen, um direkt nachzuschlagen.',
    searchPlaceholder: 'Suche nach Alias oder FP…',
    unlisted: 'Nicht gelistet',
  },
};
const { t } = createI18n(DICT);

// Base64url encoding of a raw 32-byte Ed25519 pub is always 43 chars (see
// QuCrypto.toBase64Url) - below this, a query can't possibly be a full FP,
// so there's no point spending a network round-trip probing for one.
const FP_LENGTH = 43;

const STYLE_ID = 'qu-user-list-style';
const STYLE = `
  .qu-user-search { width: 100%; box-sizing: border-box; margin: 0 0 0.6rem; padding: 0.5rem 0.7rem; border: 1px solid #8884; border-radius: 0.4rem; font: inherit; }
  .qu-user-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.4rem; }
  .qu-user-list li { display: flex; align-items: center; gap: 0.6rem; padding: 0.5rem 0.7rem; border: 1px solid #8884; border-radius: 0.4rem; }
  .qu-user-list li.qu-user-unlisted { border-style: dashed; }
  .qu-user-list .qu-user-info { flex: 1; min-width: 0; display: flex; flex-direction: column; text-decoration: none; color: inherit; }
  .qu-user-list .qu-user-info:hover .qu-user-alias { text-decoration: underline; }
  .qu-user-list .qu-user-alias-row { display: flex; align-items: center; gap: 0.4rem; }
  .qu-user-list .qu-user-alias { font-weight: 600; }
  .qu-user-list .qu-user-badge { font-size: 0.7em; font-weight: 600; text-transform: uppercase; opacity: 0.7; border: 1px solid #8884; border-radius: 0.3rem; padding: 0.05rem 0.35rem; }
  .qu-user-list .qu-user-pub { font-family: ui-monospace, monospace; font-size: 0.8em; opacity: 0.6; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .qu-user-list button { background: none; border: none; cursor: pointer; font-size: 1.1em; flex-shrink: 0; }
`;


export function mount(container, { qu, services, subscribe }) {
  injectStyle(STYLE_ID, STYLE);
  let stopped = false;
  let filterText = '';
  let debounceTimer = null;

  let myActorPub = null;
  let baseEntries = []; // [{actorPub, profile}] - the visible directory, minus self
  let contactPubs = new Set();
  let unlistedMatch = null; // {actorPub, profile} | null - resolved on an exact FP query
  let unlistedToken = 0;

  // Defense in depth - the shell already subscribes to '/store/directory'
  // by default (see apps/shell/src/main.js's mount()), but this app
  // shouldn't silently depend on that staying true.
  subscribe('/store/directory');

  const heading = document.createElement('h1');
  heading.textContent = t('title');

  const search = document.createElement('input');
  search.type = 'search';
  search.className = 'qu-user-search';
  search.placeholder = t('searchPlaceholder');
  search.addEventListener('input', () => {
    filterText = search.value;
    renderResults();
    // The substring filter above is instant (pure client-side); the exact-FP
    // lookup below can hit the network (syncFetch backfill), so it's
    // debounced separately - no point firing one per keystroke while
    // someone's still pasting.
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      await resolveUnlisted();
      if (!stopped) renderResults();
    }, 300);
  });

  const resultsEl = document.createElement('div');
  container.append(heading, search, resultsEl);

  function matches(actorPub, profile) {
    return matchesActorQuery(actorPub, profile, filterText);
  }

  async function resolveUnlisted() {
    const query = filterText.trim();
    const token = ++unlistedToken;
    if (query.length !== FP_LENGTH || query === myActorPub || baseEntries.some((e) => e.actorPub === query)) {
      unlistedMatch = null;
      return;
    }
    const profile = await services.profile.getPublicProfile(query);
    if (stopped || token !== unlistedToken) return; // superseded by a newer keystroke
    unlistedMatch = profile ? { actorPub: query, profile } : null;
  }

  function renderResults() {
    if (stopped) return;
    resultsEl.textContent = '';

    const filtered = baseEntries.filter((e) => matches(e.actorPub, e.profile));
    const showUnlisted = unlistedMatch && filterText.trim() === unlistedMatch.actorPub && !filtered.some((e) => e.actorPub === unlistedMatch.actorPub);
    const results = showUnlisted ? [...filtered, unlistedMatch] : filtered;

    if (results.length === 0) {
      const empty = document.createElement('p');
      empty.textContent = filterText.trim() ? t('noMatch') : t('empty');
      resultsEl.appendChild(empty);
      return;
    }

    const list = document.createElement('ul');
    list.className = 'qu-user-list';
    for (const entry of results) {
      const isUnlisted = showUnlisted && entry.actorPub === unlistedMatch.actorPub;
      list.appendChild(row(entry.actorPub, entry.profile, contactPubs.has(entry.actorPub), services, isUnlisted));
    }
    resultsEl.appendChild(list);
  }

  async function loadBase() {
    if (stopped) return;
    const [visible, me, contacts] = await Promise.all([
      services.directory.listVisible(),
      services.actors.whoAmI(),
      services.contacts.listContacts(),
    ]);
    if (stopped) return;

    myActorPub = me;
    contactPubs = new Set(contacts.map((c) => c.actorPub));
    const others = visible.filter((entry) => entry.actorPub !== me);

    const entries = [];
    for (const entry of others) {
      const profile = await services.profile.getPublicProfile(entry.actorPub);
      if (stopped) return;
      entries.push({ actorPub: entry.actorPub, profile });
    }
    if (stopped) return;

    baseEntries = entries;
    await resolveUnlisted();
    renderResults();
  }

  loadBase();
  const unwatch = watch(qu, paths.collectionPath('directory', 'visible'), loadBase, { initial: false });

  return () => {
    stopped = true;
    clearTimeout(debounceTimer);
    unwatch();
  };
}

function row(actorPub, profile, isContact, services, isUnlisted) {
  const li = document.createElement('li');
  if (isUnlisted) li.classList.add('qu-user-unlisted');

  const alias = formatActorLabel(actorPub, profile);
  const avatar = renderAvatar(actorPub, alias, profile?.avatar, { size: '2.2rem' });

  const info = document.createElement('a');
  info.className = 'qu-user-info';
  info.href = `#/~${actorPub}`;
  const aliasRow = document.createElement('span');
  aliasRow.className = 'qu-user-alias-row';
  const aliasEl = document.createElement('span');
  aliasEl.className = 'qu-user-alias';
  aliasEl.textContent = alias;
  aliasRow.appendChild(aliasEl);
  if (isUnlisted) {
    const badge = document.createElement('span');
    badge.className = 'qu-user-badge';
    badge.textContent = t('unlisted');
    aliasRow.appendChild(badge);
  }
  const pub = document.createElement('span');
  pub.className = 'qu-user-pub';
  pub.textContent = actorPub;
  info.append(aliasRow, pub);

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
