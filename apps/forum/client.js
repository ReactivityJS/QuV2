/**
 * FORUM — an esoTalk-styled public board: channels (a Collection of small
 * Documents, `{_id, title, description, color, createdBy, createdAt}`) each
 * holding a list of topics (Documents, `{_id, title, channelId, author,
 * createdAt}`), each topic backed by its own public Thread
 * (THREAD_PRESETS.forum() - anyone reads, anyone writes, markdown +
 * mentions). Channels and topics are both plain Documents/Collections -
 * Threads only model the MESSAGES inside one topic, same as before this
 * redesign.
 *
 * Channel creation is gated by the relay's own admin allowlist (`/config.json`'s
 * `adminPubs` - same one apps/relay-admin uses, see its own doc comment for
 * why that check is UI-only, not a security boundary). An unconfigured
 * relay (no admins set up yet) stays permissive - anyone may create a
 * channel - so a fresh relay never locks itself out of its own forum.
 *
 * A channel may be marked RESTRICTED at creation: its Document is protected
 * via `services.access.protect()` (@qu/services' AccessService, backed by
 * @qu/engines' AccessEngine - a generic, entity-agnostic ACL, not something
 * Forum-specific or Thread-specific) so only its members can rename/edit
 * it, and every topic created under it uses `THREAD_PRESETS.chat(memberPubs)`
 * (the channel's own `writers`) instead of the public `THREAD_PRESETS.forum()`
 * - real end-to-end encryption for exactly those members, the relay
 * included, sees ciphertext only. This only locks CONTENT: the channel's
 * and its topics' TITLES stay visible metadata in the shared indexes (same
 * "path is addressing, not proof of readability" limitation ThreadService
 * already documents elsewhere) - fully hiding a restricted channel's
 * existence is real future work, not implemented here.
 *
 * Reply count and "last activity" are deliberately NOT stored on the topic
 * document (that would mean either bypassing the shared @qu/thread-ui
 * composer or keeping a redundant, race-prone counter in sync with it -
 * see git history/PR description for the fuller reasoning). Instead
 * they're computed live per topic from the thread's own message
 * collection: `listRawPaths()` for a cheap count + the last path's
 * timestamp/author, watched so the board re-sorts itself as replies land
 * from ANY peer, not just this tab's own posts.
 *
 * ROUTING - everything beyond `#/forum` is a real, addressable, back/
 * forward-navigable route (see apps/shell's router):
 *   - `#/forum` - all channels: sidebar + every topic, newest activity first.
 *   - `#/forum/c/<channelId>` - one channel's topic list.
 *   - `#/forum/t/<topicId>` - one topic's thread.
 *   - `#/forum/<topicId>` (no `c`/`t` segment) - legacy shape from before
 *     this redesign, kept working so an already-shared/bookmarked link
 *     doesn't break: treated exactly like `t/<topicId>`.
 *
 * Known v1 gaps, left for later rather than blocking this redesign:
 * pinned/sticky topics, per-channel unread badges, inviting members to a
 * restricted channel after it's created (today: creator-only at creation;
 * `services.access.addWriter()`/`addReader()` already support growing it,
 * just no UI wired up yet), and pagination (a board with a very large
 * number of topics pays one `watch()` + two reads per topic on every
 * render - fine at community-forum scale, not designed to scale past it).
 */
import { paths, THREAD_PRESETS } from '@qu/services';
import { mountThreadView } from '@qu/thread-ui';
import { createI18n } from '@qu/i18n';
import { watch } from '@qu/reactive';
import { renderSubpage, renderAvatar, injectStyle, renderFlagToggle } from '@qu/ui';

const SPACE = 'forum';
const TOPICS_COLLECTION = 'topics';
const CHANNELS_COLLECTION = 'channels';

const DICT = {
  en: {
    title: 'Forum',
    allChannels: 'All Channels',
    channels: 'Channels',
    newChannelPlaceholder: 'New channel name…',
    create: 'Create',
    newTopic: 'New topic title…',
    empty: 'No topics yet — start one below.',
    noChannelsYet: 'No channels yet — create one below.',
    noTopicsInChannel: 'No topics in this channel yet.',
    replies: '{count} replies',
    lastPostBy: 'by {name} · {time}',
    uncategorized: 'Uncategorized',
    unknownAuthor: 'Unknown',
    selectChannel: 'Channel',
    back: '← All topics',
    backToChannel: '← {channel}',
    bookmark: 'Bookmark this topic',
    bookmarked: 'Bookmarked — click to remove',
    restrictedChannel: 'Restricted (invite-only)',
    restrictedTitle: 'Restricted - only members can read/post',
  },
  de: {
    title: 'Forum',
    allChannels: 'Alle Kanäle',
    channels: 'Kanäle',
    newChannelPlaceholder: 'Name des neuen Kanals…',
    create: 'Erstellen',
    newTopic: 'Titel des neuen Themas…',
    empty: 'Noch keine Themen — leg unten eins an.',
    noChannelsYet: 'Noch keine Kanäle — leg unten einen an.',
    noTopicsInChannel: 'Noch keine Themen in diesem Kanal.',
    replies: '{count} Antworten',
    lastPostBy: 'von {name} · {time}',
    uncategorized: 'Unkategorisiert',
    unknownAuthor: 'Unbekannt',
    selectChannel: 'Kanal',
    back: '← Alle Themen',
    backToChannel: '← {channel}',
    bookmark: 'Thema merken',
    bookmarked: 'Gemerkt — Klick zum Entfernen',
    restrictedChannel: 'Eingeschränkt (nur auf Einladung)',
    restrictedTitle: 'Eingeschränkt - nur Mitglieder können lesen/schreiben',
  },
};
const { t } = createI18n(DICT);

const STYLE_ID = 'qu-forum-style';
const STYLE = `
  .qu-forum-app { --qu-forum-accent: #3e7fe0; }
  .qu-forum-layout { display: flex; gap: 1.2rem; align-items: flex-start; flex-wrap: wrap; }
  .qu-forum-sidebar { width: 15rem; flex-shrink: 0; display: flex; flex-direction: column; gap: 1rem; }
  .qu-forum-main { flex: 1; min-width: 18rem; }
  .qu-forum-main-header h1 { margin: 0 0 0.6rem; }
  .qu-forum-topic-heading-row { display: flex; align-items: center; gap: 0.5rem; }
  .qu-forum-topic-heading-row h1 { margin: 0; }
  .qu-forum-section-heading { font-size: 0.8em; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.6; margin: 0 0 0.3rem; }
  .qu-forum-channel-list { display: flex; flex-direction: column; gap: 0.1rem; }
  .qu-forum-channel-link { display: flex; align-items: center; gap: 0.5rem; padding: 0.35rem 0.5rem; border-radius: 0.4rem; text-decoration: none; color: inherit; }
  .qu-forum-channel-link:hover { background: #8881; }
  .qu-forum-channel-link[data-active="true"] { background: #8882; font-weight: 600; }
  .qu-forum-channel-swatch { width: 0.7rem; height: 0.7rem; border-radius: 50%; display: inline-block; flex-shrink: 0; }
  .qu-forum-empty-note { opacity: 0.6; font-size: 0.85em; margin: 0.3rem 0.5rem; }
  .qu-forum-new-channel { display: flex; flex-direction: column; gap: 0.4rem; margin-top: 0.4rem; }
  .qu-forum-new-channel input[type="text"], .qu-forum-new-channel input:not([type]) { padding: 0.4rem; }
  .qu-forum-new-channel-row { display: flex; gap: 0.4rem; align-items: center; }
  .qu-forum-new-channel-restricted { display: flex; gap: 0.4rem; align-items: center; font-size: 0.85em; }
  .qu-forum-lock { font-size: 0.85em; opacity: 0.7; }
  .qu-forum-topics { list-style: none; margin: 0 0 0.8rem; padding: 0; display: flex; flex-direction: column; gap: 0.4rem; }
  .qu-forum-topic-row { display: flex; align-items: center; gap: 0.6rem; padding: 0.55rem 0.7rem; border: 1px solid #8884; border-radius: 0.5rem; text-decoration: none; color: inherit; }
  .qu-forum-topic-row:hover { border-color: #8888; background: #8881; }
  .qu-forum-topic-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 0.2rem; }
  .qu-forum-topic-top { display: flex; align-items: center; gap: 0.5rem; }
  .qu-forum-topic-title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .qu-forum-channel-tag { font-size: 0.75em; border: 1px solid #8884; border-radius: 999px; padding: 0.05rem 0.5rem; opacity: 0.8; flex-shrink: 0; }
  .qu-forum-topic-bottom { font-size: 0.8em; opacity: 0.65; }
  .qu-forum-reply-badge { flex-shrink: 0; min-width: 1.8rem; text-align: center; background: var(--qu-forum-accent); color: #fff; border-radius: 999px; padding: 0.15rem 0.55rem; font-size: 0.8em; font-weight: 600; }
  .qu-forum-new-topic { display: flex; gap: 0.4rem; flex-wrap: wrap; }
  .qu-forum-new-topic input { flex: 1; min-width: 10rem; padding: 0.4rem; }
  .qu-forum-new-topic select { padding: 0.4rem; }
  .qu-forum-app .qu-subpage-back { display: inline-block; text-decoration: none; color: inherit; opacity: 0.7; margin-bottom: 0.6rem; }
  .qu-forum-app .qu-subpage-back:hover { opacity: 1; }
`;

// Default channel swatch color when none is picked - same hash-to-palette
// approach as @qu/ui's own avatar coloring, kept local (not exported by
// @qu/ui) since a channel id isn't a profile avatar.
const CHANNEL_PALETTE = ['#e17076', '#faa774', '#a695e7', '#7bc862', '#6ec9cb', '#65aadd', '#ee7aae', '#f2c94c'];
function colorFor(seed) {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return CHANNEL_PALETTE[hash % CHANNEL_PALETTE.length];
}

function fmtTime(ts) {
  if (!ts) return '';
  const date = new Date(ts);
  const sameDay = date.toDateString() === new Date().toDateString();
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return time;
  const day = date.toLocaleDateString([], { day: '2-digit', month: '2-digit' });
  return `${day} ${time}`;
}

export function mount(container, { qu, services, segments, subscribe, fetch: syncFetch, hooks }) {
  injectStyle(STYLE_ID, STYLE);
  container.classList.add('qu-forum-app');
  let stopped = false;
  let stopThreadView = null;
  let myActorPub = null;
  let canCreateChannel = true;
  const boardWatchStops = [];

  // Live updates from OTHER browsers (new channels, new topics, messages in
  // a topic someone else posted to) need this - the shell's own default
  // subscriptions (see apps/shell/src/main.js) only cover its own chrome
  // needs, not any individual app's space.
  subscribe(paths.spacePath(SPACE));

  const route = parseRoute(segments);

  (async () => {
    myActorPub = await services.actors.whoAmI();
    // Same relay-wide adminPubs allowlist apps/relay-admin gates its own UI
    // with (see /config.json, published by @qu/relay - UI-only, not a
    // security boundary; the actual write is still just DocumentEngine's
    // open-by-default behavior). An empty/unreachable adminPubs list means
    // "this relay never configured any admins" - stay permissive rather
    // than locking out an unconfigured relay's forum entirely.
    try {
      const config = await fetch('/config.json').then((r) => r.json());
      const adminPubs = config.adminPubs ?? [];
      canCreateChannel = adminPubs.length === 0 || adminPubs.includes(myActorPub);
    } catch {
      canCreateChannel = true; // no relay config endpoint reachable (e.g. a non-@qu/relay host) - default open
    }
    if (stopped) return;
    if (route.view === 'topic') await renderTopicPage(route.topicId);
    else await renderBoard(route.channelId);
  })();

  function parseRoute(segs) {
    // segs[0] is "forum" itself.
    if (segs[1] === 'c' && segs[2]) return { view: 'list', channelId: segs[2] };
    if (segs[1] === 't' && segs[2]) return { view: 'topic', topicId: segs[2] };
    if (segs[1]) return { view: 'topic', topicId: segs[1] }; // legacy bare-id link
    return { view: 'list', channelId: null };
  }

  // A local miss here does NOT mean "nothing exists" - it can just as
  // easily mean this session hasn't synced the collection YET (subscribe()
  // only covers writes from here on). Backfilling via syncFetch before
  // ever falling back to "create it empty" is what stops a late-joining
  // peer from silently wiping out every channel/topic someone else already
  // created - a real bug found by an adversarial multi-peer test on the
  // topics collection before this redesign: without this, the SECOND
  // person to ever open Forum overwrote the first person's topic list with
  // an empty one. Replicated here for `channels` too, same failure mode.
  //
  // A SECOND gap, found by the same kind of multi-peer test while building
  // the esoTalk redesign: CollectionEngine's own $list resolution (see
  // @qu/engines) only reads referenced items from THIS device's local
  // storage - it never backfills them. A collection doc can itself be
  // freshly backfilled above while the channel/topic DOCUMENTS it points
  // at haven't synced to this device yet, which without the second pass
  // below would show as "no channels/topics" FOREVER on a first-ever visit
  // (not just a brief flash), since nothing re-renders once those specific
  // document paths eventually arrive - same shape as
  // DirectoryService.listVisible()'s own per-item backfill, applied here
  // to channels/topics instead of directory entries.
  async function listResolved(collectionId) {
    let items = await services.collections.list(SPACE, collectionId);
    if (items === null && syncFetch) {
      await syncFetch(paths.collectionPath(SPACE, collectionId)).catch(() => {});
      items = await services.collections.list(SPACE, collectionId);
    }
    if (items === null) {
      await services.collections.create(SPACE, collectionId, []);
      return [];
    }
    if (syncFetch && items.some((item) => item === null)) {
      const rawPaths = await services.collections.listRawPaths(SPACE, collectionId);
      await Promise.all(items.map((item, i) => (item === null ? syncFetch(rawPaths[i]).catch(() => {}) : null)));
      items = (await services.collections.list(SPACE, collectionId)) ?? [];
    }
    return items.filter(Boolean);
  }

  function stopBoardWatches() {
    while (boardWatchStops.length) boardWatchStops.pop()?.();
  }

  // Cheap: only ever called with the (small) channel list, same cost class
  // as enrichTopics() below. `getAcl()` returning non-null is exactly what
  // "this channel is restricted" means - no separate `restricted` field on
  // the channel Document itself to keep in sync/drift out of sync with.
  async function enrichChannelsRestricted(channels) {
    await Promise.all(channels.map(async (channel) => {
      const acl = await services.access.getAcl(SPACE, 'docs', channel._id);
      channel.restricted = !!acl;
    }));
  }

  async function enrichTopics(topics) {
    await Promise.all(topics.map(async (topic) => {
      const rawPaths = await services.collections.listRawPaths(SPACE, paths.threadMessagesCollectionId(topic._id));
      topic.replyCount = rawPaths.length;
      if (rawPaths.length) {
        const last = await qu.get(rawPaths[rawPaths.length - 1]);
        topic.lastTs = last?.ts ?? topic.createdAt ?? 0;
        topic.lastAuthorPub = last?.val?.author ?? topic.author ?? null;
      } else {
        topic.lastTs = topic.createdAt ?? 0;
        topic.lastAuthorPub = topic.author ?? null;
      }
    }));
  }

  async function renderBoard(activeChannelId) {
    stopBoardWatches();
    const [channels, topics] = await Promise.all([
      listResolved(CHANNELS_COLLECTION),
      listResolved(TOPICS_COLLECTION),
    ]);
    if (stopped) return;
    if (channels.length) await enrichChannelsRestricted(channels);
    if (stopped) return;

    const visibleTopics = activeChannelId
      ? topics.filter((topic) => (topic.channelId ?? null) === activeChannelId)
      : topics;
    if (visibleTopics.length) await enrichTopics(visibleTopics);
    visibleTopics.sort((a, b) => (b.lastTs ?? 0) - (a.lastTs ?? 0));
    if (stopped) return;

    container.textContent = '';
    const layout = document.createElement('div');
    layout.className = 'qu-forum-layout';

    const sidebar = document.createElement('div');
    sidebar.className = 'qu-forum-sidebar';
    sidebar.appendChild(channelSidebar(channels, activeChannelId));
    layout.appendChild(sidebar);

    const main = document.createElement('div');
    main.className = 'qu-forum-main';
    main.appendChild(await topicListSection(channels, visibleTopics, activeChannelId));
    layout.appendChild(main);

    container.appendChild(layout);
    if (stopped) return;

    boardWatchStops.push(watch(qu, paths.collectionPath(SPACE, TOPICS_COLLECTION), () => { if (!stopped) renderBoard(activeChannelId); }, { initial: false }));
    boardWatchStops.push(watch(qu, paths.collectionPath(SPACE, CHANNELS_COLLECTION), () => { if (!stopped) renderBoard(activeChannelId); }, { initial: false }));
    for (const topic of visibleTopics) {
      boardWatchStops.push(watch(
        qu,
        paths.collectionPath(SPACE, paths.threadMessagesCollectionId(topic._id)),
        () => { if (!stopped) renderBoard(activeChannelId); },
        { initial: false }
      ));
    }
  }

  function channelSidebar(channels, activeChannelId) {
    const wrap = document.createElement('div');

    const heading = document.createElement('div');
    heading.className = 'qu-forum-section-heading';
    heading.textContent = t('channels');
    wrap.appendChild(heading);

    const list = document.createElement('div');
    list.className = 'qu-forum-channel-list';

    const allLink = document.createElement('a');
    allLink.className = 'qu-forum-channel-link';
    allLink.href = '#/forum';
    allLink.textContent = t('allChannels');
    if (!activeChannelId) allLink.dataset.active = 'true';
    list.appendChild(allLink);

    if (channels.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'qu-forum-empty-note';
      empty.textContent = t('noChannelsYet');
      list.appendChild(empty);
    } else {
      for (const channel of channels) {
        const link = document.createElement('a');
        link.className = 'qu-forum-channel-link';
        link.href = `#/forum/c/${channel._id}`;
        if (channel._id === activeChannelId) link.dataset.active = 'true';
        const swatch = document.createElement('span');
        swatch.className = 'qu-forum-channel-swatch';
        swatch.style.background = channel.color || colorFor(channel._id);
        link.append(swatch, document.createTextNode(channel.title));
        if (channel.restricted) {
          const lock = document.createElement('span');
          lock.className = 'qu-forum-lock';
          lock.textContent = '🔒';
          lock.title = t('restrictedTitle');
          link.appendChild(lock);
        }
        list.appendChild(link);
      }
    }
    wrap.appendChild(list);
    if (canCreateChannel) wrap.appendChild(newChannelForm());
    return wrap;
  }

  function newChannelForm() {
    const form = document.createElement('form');
    form.className = 'qu-forum-new-channel';

    const input = document.createElement('input');
    input.placeholder = t('newChannelPlaceholder');
    input.required = true;

    const row = document.createElement('div');
    row.className = 'qu-forum-new-channel-row';
    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.value = colorFor(crypto.randomUUID());
    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.textContent = t('create');
    row.append(colorInput, submit);

    const restrictedRow = document.createElement('label');
    restrictedRow.className = 'qu-forum-new-channel-restricted';
    const restrictedInput = document.createElement('input');
    restrictedInput.type = 'checkbox';
    restrictedRow.append(restrictedInput, document.createTextNode(t('restrictedChannel')));

    form.append(input, restrictedRow, row);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const title = input.value.trim();
      if (!title) return;
      const newId = crypto.randomUUID();
      // Restricted: protect the channel Document itself (only the
      // creator, for now - see this file's own doc comment on why growing
      // membership after creation has no UI yet) BEFORE writing it, then
      // ask AccessService for the write options instead of hand-rolling
      // that orchestration here - see @qu/services' AccessService, the
      // same generic mechanism ANY app (Thread-based or not) uses to
      // protect a resource. `readers` is deliberately left at its default
      // ('*') - restricting it would ENCRYPT this Document's value, and
      // DocumentService (unlike ThreadService/AssetService) has no
      // decrypt-aware get() to ever read it back - see AccessService's own
      // writeOptionsFor() doc comment for this exact gotcha. Only
      // `writers` is protected: nobody but a member can rename/edit the
      // channel, but its title stays visible plaintext.
      let writeOptions = {};
      if (restrictedInput.checked) {
        await services.access.protect(SPACE, 'docs', newId, { writers: [myActorPub] });
        writeOptions = await services.access.writeOptionsFor(SPACE, 'docs', newId);
      }
      await services.documents.create(SPACE, newId, {
        _id: newId, title, description: '', color: colorInput.value, createdBy: myActorPub, createdAt: Date.now(),
      }, writeOptions);
      await services.collections.addItem(SPACE, CHANNELS_COLLECTION, paths.documentPath(SPACE, newId));
      location.hash = `#/forum/c/${newId}`;
    });
    return form;
  }

  async function topicListSection(channels, visibleTopics, activeChannelId) {
    const wrap = document.createElement('div');

    const header = document.createElement('div');
    header.className = 'qu-forum-main-header';
    const heading = document.createElement('h1');
    const activeChannel = activeChannelId ? channels.find((c) => c._id === activeChannelId) : null;
    heading.textContent = activeChannel ? activeChannel.title : t('allChannels');
    header.appendChild(heading);
    wrap.appendChild(header);

    if (visibleTopics.length === 0) {
      const empty = document.createElement('p');
      empty.textContent = activeChannelId ? t('noTopicsInChannel') : t('empty');
      wrap.appendChild(empty);
    } else {
      const list = document.createElement('ul');
      list.className = 'qu-forum-topics';
      const rows = await Promise.all(visibleTopics.map((topic) => topicRow(topic, channels, activeChannelId)));
      for (const row of rows) list.appendChild(row);
      wrap.appendChild(list);
    }

    wrap.appendChild(newTopicForm(channels, activeChannelId));
    return wrap;
  }

  async function topicRow(topic, channels, activeChannelId) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.className = 'qu-forum-topic-row';
    a.href = `#/forum/t/${topic._id}`;

    const authorProfile = topic.author ? await services.profile.getPublicProfile(topic.author).catch(() => null) : null;
    const authorName = authorProfile?.alias || (topic.author ? `~${topic.author.slice(0, 10)}…` : t('unknownAuthor'));
    a.appendChild(renderAvatar(topic.author || topic._id, authorName, authorProfile?.avatar ?? null, { size: '2.2rem' }));

    const main = document.createElement('div');
    main.className = 'qu-forum-topic-main';

    const top = document.createElement('div');
    top.className = 'qu-forum-topic-top';
    const title = document.createElement('span');
    title.className = 'qu-forum-topic-title';
    title.textContent = topic.title;
    top.appendChild(title);

    if (!activeChannelId) {
      const channel = channels.find((c) => c._id === topic.channelId);
      const tag = document.createElement('span');
      tag.className = 'qu-forum-channel-tag';
      tag.textContent = (channel ? channel.title : t('uncategorized')) + (channel?.restricted ? ' 🔒' : '');
      tag.style.borderColor = channel?.color || '#8884';
      top.appendChild(tag);
    }
    main.appendChild(top);

    const bottom = document.createElement('div');
    bottom.className = 'qu-forum-topic-bottom';
    if (topic.lastTs) {
      const lastProfile = topic.lastAuthorPub ? await services.profile.getPublicProfile(topic.lastAuthorPub).catch(() => null) : null;
      const lastName = lastProfile?.alias || (topic.lastAuthorPub ? `~${topic.lastAuthorPub.slice(0, 10)}…` : t('unknownAuthor'));
      const lastActivity = document.createElement('span');
      lastActivity.textContent = t('lastPostBy', { name: lastName, time: fmtTime(topic.lastTs) });
      bottom.appendChild(lastActivity);
    }
    main.appendChild(bottom);
    a.appendChild(main);

    const badge = document.createElement('span');
    badge.className = 'qu-forum-reply-badge';
    badge.textContent = String(topic.replyCount ?? 0);
    badge.title = t('replies', { count: topic.replyCount ?? 0 });
    a.appendChild(badge);

    li.appendChild(a);
    return li;
  }

  function newTopicForm(channels, activeChannelId) {
    const form = document.createElement('form');
    form.className = 'qu-forum-new-topic';

    const input = document.createElement('input');
    input.placeholder = t('newTopic');
    input.required = true;
    form.appendChild(input);

    let select = null;
    if (channels.length > 0) {
      select = document.createElement('select');
      if (!activeChannelId) {
        const noneOpt = document.createElement('option');
        noneOpt.value = '';
        noneOpt.textContent = t('uncategorized');
        select.appendChild(noneOpt);
      }
      for (const channel of channels) {
        const opt = document.createElement('option');
        opt.value = channel._id;
        opt.textContent = channel.title;
        if (channel._id === activeChannelId) opt.selected = true;
        select.appendChild(opt);
      }
      form.appendChild(select);
    }

    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.textContent = t('create');
    form.appendChild(submit);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const title = input.value.trim();
      if (!title) return;
      const newTopicId = crypto.randomUUID();
      const channelId = select ? (select.value || null) : (activeChannelId ?? null);
      await services.documents.create(SPACE, newTopicId, {
        _id: newTopicId, title, channelId, author: myActorPub, createdAt: Date.now(),
      });
      await services.collections.addItem(SPACE, TOPICS_COLLECTION, paths.documentPath(SPACE, newTopicId));
      location.hash = `#/forum/t/${newTopicId}`;
    });
    return form;
  }

  async function renderTopicPage(topicId) {
    stopBoardWatches();
    const [topic, channels] = await Promise.all([
      services.documents.get(SPACE, topicId),
      listResolved(CHANNELS_COLLECTION),
    ]);
    if (stopped) return;

    const channel = topic?.channelId ? channels.find((c) => c._id === topic.channelId) : null;
    const backHref = channel ? `#/forum/c/${channel._id}` : '#/forum';
    const backLabel = channel ? t('backToChannel', { channel: channel.title }) : t('back');

    // A restricted channel's topics inherit ITS member list (the channel
    // Document's own `writers`, via the same generic AccessService every
    // resource kind shares) as a real encrypted-for-members Thread instead
    // of the public forum preset - membership is defined exactly once, at
    // the channel, not duplicated into per-topic Forum config. Only
    // matters on the very FIRST render of a topic (createThread() is
    // idempotent - see ThreadService), so this doesn't re-decide anything
    // for an already-created topic's thread.
    const channelAcl = channel ? await services.access.getAcl(SPACE, 'docs', channel._id) : null;
    const threadConfig = Array.isArray(channelAcl?.writers) ? THREAD_PRESETS.chat(channelAcl.writers) : THREAD_PRESETS.forum();
    if (stopped) return;

    renderSubpage(container, {
      backHref,
      backLabel,
      render(content) {
        const headingRow = document.createElement('div');
        headingRow.className = 'qu-forum-topic-heading-row';
        const heading = document.createElement('h1');
        heading.textContent = topic?.title ?? topicId;
        headingRow.appendChild(heading);
        headingRow.appendChild(renderFlagToggle({
          flags: services.flags, flagType: 'bookmark', entityKind: 'forum-thread', entityRef: topicId,
          icon: '🔖', title: t('bookmark'), activeTitle: t('bookmarked'),
        }));
        content.appendChild(headingRow);

        const threadEl = document.createElement('div');
        content.appendChild(threadEl);
        stopThreadView = mountThreadView(threadEl, {
          qu, services, spaceId: SPACE, threadId: topicId,
          threadConfig, hooks,
        });
      },
    });
  }

  return () => {
    stopped = true;
    stopThreadView?.();
    stopBoardWatches();
  };
}
