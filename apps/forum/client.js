/**
 * FORUM — a public board: a list of topics (each a Document in the shared
 * "forum" space), each topic backed by its own public Thread
 * (THREAD_PRESETS.forum() - anyone reads, anyone writes, markdown +
 * mentions). Topics themselves are plain Documents/a Collection - Threads
 * only model the MESSAGES inside one topic, not the topic list itself.
 *
 * Route: `#/forum` (topic list) or `#/forum/<topicId>` (one topic's thread) -
 * see apps/shell's URL scheme doc comment in main.js.
 */
import { paths, THREAD_PRESETS } from '@qu/services';
import { mountThreadView } from '@qu/thread-ui';
import { createI18n } from '@qu/i18n';

const SPACE = 'forum';
const TOPICS_COLLECTION = 'topics';

const DICT = {
  en: { title: 'Forum', newTopic: 'New topic title…', create: 'Create', empty: 'No topics yet — start one below.', back: '← All topics' },
  de: { title: 'Forum', newTopic: 'Titel des neuen Themas…', create: 'Erstellen', empty: 'Noch keine Themen — leg unten eins an.', back: '← Alle Themen' },
};
const { t } = createI18n(DICT);

const STYLE_ID = 'qu-forum-style';
const STYLE = `
  .qu-forum-topics { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.4rem; }
  .qu-forum-topics li { padding: 0.5rem 0.7rem; border: 1px solid #8884; border-radius: 0.4rem; }
  .qu-forum-topics a { text-decoration: none; color: inherit; }
  .qu-forum-new { display: flex; gap: 0.4rem; margin-top: 0.8rem; }
  .qu-forum-new input { flex: 1; padding: 0.4rem; }
`;

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  document.head.appendChild(style);
}

export function mount(container, { qu, services, segments, subscribe, fetch: syncFetch }) {
  ensureStyle();
  let stopped = false;
  let stopThreadView = null;

  // Live updates from OTHER browsers (new topics, messages in a topic
  // someone else posted to) need this - the shell's own default
  // subscriptions (see apps/shell/src/main.js) only cover its own chrome
  // needs, not any individual app's space. See @qu/thread-ui's own doc
  // comment for how a subscribed-in write actually reaches a mounted
  // <template>-rendered message list from here.
  subscribe(`/store/${SPACE}`);

  const topicId = segments[1] ?? null; // segments[0] is "forum" itself

  (async () => {
    // A local miss here does NOT mean "no topics exist" - it can just as
    // easily mean this session hasn't synced the topics collection YET
    // (subscribe() only covers writes from here on, see its own doc
    // comment). Backfilling via syncFetch before ever falling back to
    // "create it empty" is what stops a late-joining peer from silently
    // wiping out every topic someone else already created - a real bug
    // found by an adversarial multi-peer test: without this, the SECOND
    // person to ever open Forum overwrote the first person's topic list
    // with an empty one.
    if ((await services.collections.list(SPACE, TOPICS_COLLECTION)) === null && syncFetch) {
      await syncFetch(paths.collectionPath(SPACE, TOPICS_COLLECTION)).catch(() => {});
    }
    if ((await services.collections.list(SPACE, TOPICS_COLLECTION)) === null) {
      await services.collections.create(SPACE, TOPICS_COLLECTION, []);
    }
    if (stopped) return;

    if (topicId) await renderTopic(topicId);
    else await renderTopicList();
  })();

  async function renderTopicList() {
    const topicRefs = await services.collections.list(SPACE, TOPICS_COLLECTION);
    if (stopped) return;
    container.textContent = '';

    const heading = document.createElement('h1');
    heading.textContent = t('title');
    container.appendChild(heading);

    if (topicRefs.length === 0) {
      const empty = document.createElement('p');
      empty.textContent = t('empty');
      container.appendChild(empty);
    } else {
      const list = document.createElement('ul');
      list.className = 'qu-forum-topics';
      for (const topic of topicRefs) {
        const li = document.createElement('li');
        const a = document.createElement('a');
        a.href = `#/forum/${topic._id}`;
        a.textContent = topic.title;
        li.appendChild(a);
        list.appendChild(li);
      }
      container.appendChild(list);
    }

    const form = document.createElement('form');
    form.className = 'qu-forum-new';
    const input = document.createElement('input');
    input.placeholder = t('newTopic');
    input.required = true;
    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.textContent = t('create');
    form.append(input, submit);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const title = input.value.trim();
      if (!title) return;
      const newTopicId = crypto.randomUUID();
      await services.documents.create(SPACE, newTopicId, { _id: newTopicId, title });
      await services.collections.addItem(SPACE, TOPICS_COLLECTION, paths.documentPath(SPACE, newTopicId));
      location.hash = `#/forum/${newTopicId}`;
    });
    container.appendChild(form);
  }

  async function renderTopic(id) {
    const topic = await services.documents.get(SPACE, id);
    if (stopped) return;
    container.textContent = '';

    const back = document.createElement('a');
    back.href = '#/forum';
    back.textContent = t('back');
    const heading = document.createElement('h1');
    heading.textContent = topic?.title ?? id;
    container.append(back, heading);

    const threadEl = document.createElement('div');
    container.appendChild(threadEl);
    stopThreadView = mountThreadView(threadEl, {
      qu, services, spaceId: SPACE, threadId: id,
      threadConfig: THREAD_PRESETS.forum(),
    });
  }

  return () => {
    stopped = true;
    stopThreadView?.();
  };
}
