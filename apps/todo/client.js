/**
 * SHARED TODO — a todo list anyone with its link can view and edit, no
 * invite step beyond sharing the URL (the same "the link IS the
 * permission" model plenty of real shared-doc tools use for a quick list -
 * simpler than Thread's ACL model, and appropriate here since there's
 * nothing sensitive in a todo list worth encrypting). One JSON document
 * per list (`{items: [...]}`) in its own space (`todo-<listId>`), watched
 * live so everyone with the list open sees edits from everyone else -
 * concurrent edits are a read-modify-write race on that one document,
 * the same accepted trade-off StarredService documents for its own
 * single-document lists.
 *
 * "My Lists" is a personal, private index (via StarredService's generic
 * namespace mechanism - see @qu/services/favorites-service.js for the
 * identical pattern with apps instead of lists) - opening ANYONE's shared
 * link auto-adds it there too, so you don't lose track of a list once
 * you've visited it.
 *
 * Route: `#/todo` (my lists) or `#/todo/<listId>` (one shared list).
 */
import { paths } from '@qu/services';
import { watch } from '@qu/reactive';
import { createI18n } from '@qu/i18n';

const NAMESPACE = 'todo-lists';

const DICT = {
  en: {
    title: 'Shared ToDo',
    myLists: 'My lists',
    empty: 'No lists yet — create one below.',
    newList: 'New list title…',
    create: 'Create',
    newItem: 'Add an item…',
    add: 'Add',
    edit: 'Edit',
    remove: 'Remove',
    back: '← My lists',
    untitled: 'Untitled list',
  },
  de: {
    title: 'Geteilte ToDo-Liste',
    myLists: 'Meine Listen',
    empty: 'Noch keine Listen — unten eine anlegen.',
    newList: 'Titel der neuen Liste…',
    create: 'Erstellen',
    newItem: 'Eintrag hinzufügen…',
    add: 'Hinzufügen',
    edit: 'Bearbeiten',
    remove: 'Entfernen',
    back: '← Meine Listen',
    untitled: 'Unbenannte Liste',
  },
};
const { t } = createI18n(DICT);

const STYLE_ID = 'qu-todo-style';
const STYLE = `
  .qu-todo-lists { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.4rem; }
  .qu-todo-lists li { display: flex; align-items: center; gap: 0.6rem; padding: 0.5rem 0.7rem; border: 1px solid #8884; border-radius: 0.4rem; }
  .qu-todo-lists a { flex: 1; text-decoration: none; color: inherit; }
  .qu-todo-new { display: flex; gap: 0.4rem; margin-top: 0.8rem; }
  .qu-todo-new input { flex: 1; padding: 0.4rem; }
  .qu-todo-items { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.3rem; }
  .qu-todo-items li { display: flex; align-items: center; gap: 0.5rem; padding: 0.3rem 0.5rem; }
  .qu-todo-items li[data-done="true"] span.qu-todo-text { text-decoration: line-through; opacity: 0.6; }
  .qu-todo-items li span.qu-todo-text { flex: 1; }
  .qu-todo-items li span.qu-todo-text[contenteditable="true"] { text-decoration: none; opacity: 1; outline: 1px dashed #8888; border-radius: 0.3rem; padding: 0.1rem 0.3rem; }
  .qu-todo-items li button { background: none; border: none; cursor: pointer; opacity: 0.6; }
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
  let unwatch = null;

  const listId = segments[1] ?? null;

  (async () => {
    if (listId) await renderList(listId);
    else await renderMyLists();
  })();

  async function renderMyLists() {
    const mine = await services.starred.list(NAMESPACE);
    if (stopped) return;
    container.textContent = '';

    const heading = document.createElement('h1');
    heading.textContent = t('title');
    container.appendChild(heading);

    const subheading = document.createElement('h2');
    subheading.textContent = t('myLists');
    container.appendChild(subheading);

    if (mine.length === 0) {
      const empty = document.createElement('p');
      empty.textContent = t('empty');
      container.appendChild(empty);
    } else {
      const list = document.createElement('ul');
      list.className = 'qu-todo-lists';
      for (const entry of mine) {
        const li = document.createElement('li');
        const a = document.createElement('a');
        a.href = `#/todo/${entry.id}`;
        a.textContent = entry.title || t('untitled');
        li.appendChild(a);
        list.appendChild(li);
      }
      container.appendChild(list);
    }

    const form = document.createElement('form');
    form.className = 'qu-todo-new';
    const input = document.createElement('input');
    input.placeholder = t('newList');
    input.required = true;
    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.textContent = t('create');
    form.append(input, submit);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const title = input.value.trim();
      if (!title) return;
      const newListId = crypto.randomUUID();
      await services.documents.create(`todo-${newListId}`, 'list', { items: [] });
      await services.starred.star(NAMESPACE, newListId, { title });
      location.hash = `#/todo/${newListId}`;
    });
    container.appendChild(form);
  }

  async function renderList(id) {
    const spaceId = `todo-${id}`;
    subscribe(`/store/${spaceId}`);
    let autoStarChecked = false;

    container.textContent = '';
    const back = document.createElement('a');
    back.href = '#/todo';
    back.textContent = t('back');
    const heading = document.createElement('h1');
    heading.textContent = t('title');
    container.append(back, heading);

    const list = document.createElement('ul');
    list.className = 'qu-todo-items';
    container.appendChild(list);

    const form = document.createElement('form');
    form.className = 'qu-todo-new';
    const input = document.createElement('input');
    input.placeholder = t('newItem');
    input.required = true;
    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.textContent = t('add');
    form.append(input, submit);
    container.appendChild(form);

    async function render(doc) {
      if (stopped) return;
      const items = doc?.items ?? [];
      list.textContent = '';
      for (const item of items) list.appendChild(itemRow(spaceId, item));

      // Visiting someone else's shared link auto-remembers it, so it shows
      // up in "My Lists" too - done here (on the first successfully
      // RESOLVED doc, whether that's an immediate local read or one that
      // only arrived a moment later via sync) rather than once up front at
      // mount time, since a doc opened from a link JUST received from
      // someone else may not have synced to this browser YET at that exact
      // moment - checking too early would silently skip remembering it.
      if (!autoStarChecked && doc) {
        autoStarChecked = true;
        if (!(await services.starred.isStarred(NAMESPACE, id))) {
          await services.starred.star(NAMESPACE, id, { title: t('untitled') });
        }
      }
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      const current = (await services.documents.get(spaceId, 'list'))?.items ?? [];
      await services.documents.update(spaceId, 'list', { items: [...current, { id: crypto.randomUUID(), text, done: false }] });
    });

    unwatch = watch(qu, paths.documentPath(spaceId, 'list'), render);
  }

  function itemRow(spaceId, item) {
    const li = document.createElement('li');
    li.dataset.done = String(item.done);

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = item.done;
    checkbox.addEventListener('change', async () => {
      const current = (await services.documents.get(spaceId, 'list'))?.items ?? [];
      const updated = current.map((i) => (i.id === item.id ? { ...i, done: checkbox.checked } : i));
      await services.documents.update(spaceId, 'list', { items: updated });
    });

    const span = document.createElement('span');
    span.className = 'qu-todo-text';
    span.textContent = item.text;

    // Contenteditable in place, not a separate edit MODE - the list model
    // has no per-item owner (see this file's own doc comment: the link
    // itself is the permission, same as add/remove/toggle already are),
    // so there's nothing to gate this behind beyond having the list open.
    const saveEdit = async () => {
      const text = span.textContent.trim();
      if (!text || text === item.text) {
        span.textContent = item.text; // revert an empty/unchanged edit
        return;
      }
      const current = (await services.documents.get(spaceId, 'list'))?.items ?? [];
      await services.documents.update(spaceId, 'list', { items: current.map((i) => (i.id === item.id ? { ...i, text } : i)) });
    };
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.textContent = '✎';
    editBtn.title = t('edit');
    editBtn.addEventListener('click', () => {
      span.contentEditable = 'true';
      span.focus();
      document.getSelection()?.selectAllChildren(span);
    });
    span.addEventListener('blur', () => {
      span.contentEditable = 'false';
      saveEdit();
    });
    span.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); span.blur(); }
      if (e.key === 'Escape') { span.textContent = item.text; span.blur(); }
    });

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.textContent = '✕';
    removeBtn.title = t('remove');
    removeBtn.addEventListener('click', async () => {
      const current = (await services.documents.get(spaceId, 'list'))?.items ?? [];
      await services.documents.update(spaceId, 'list', { items: current.filter((i) => i.id !== item.id) });
    });

    li.append(checkbox, span, editBtn, removeBtn);
    return li;
  }

  return () => {
    stopped = true;
    unwatch?.();
  };
}
