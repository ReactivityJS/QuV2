/**
 * CALENDAR — a shared calendar, the same "the link is the permission"
 * sharing model apps/todo already uses (one JSON document per calendar,
 * no ACL beyond knowing the id) - deliberately, there's nothing sensitive
 * enough in a scheduling calendar to warrant Thread's encryption
 * machinery.
 *
 * The one thing beyond ToDo's model: MULTIPLE calendars can be combined
 * into one view at once (checkboxes in "My Calendars"), each rendered in
 * its own color - the actual point of a SHARED calendar (seeing everyone's
 * events, and free slots, together), not just a single-owner list.
 *
 * Four views over the combined event set - Day/Week/Month/List - plus a
 * text filter (title/description substring) in List view. No recurring-
 * event (RRULE) support and no multi-day events - out of scope for this
 * port; every event is treated as occurring on its `start` date only.
 *
 * Route: `#/calendar` (My Calendars + the combined view) or
 * `#/calendar/<calendarId>` (open/join a shared calendar link - stars it
 * into "My Calendars" then redirects back to `#/calendar`).
 */
import { watch } from '@qu/reactive';
import { paths } from '@qu/services';
import { createI18n } from '@qu/i18n';

const NAMESPACE = 'calendars';
const PALETTE = ['#e0483e', '#3e7fe0', '#3ea05e', '#d0a02a', '#9a4fe0', '#e0648a', '#2ab3a6', '#c47a2a'];

const DICT = {
  en: {
    title: 'Calendar', myCalendars: 'My calendars', untitled: 'Untitled calendar',
    newCalendar: 'New calendar name…', create: 'Create',
    day: 'Day', week: 'Week', month: 'Month', list: 'List',
    today: 'Today', prev: '←', next: '→',
    filterPlaceholder: 'Filter by title or description…',
    newEvent: 'New event', eventTitle: 'Title', eventDescription: 'Description (optional)',
    start: 'Start', end: 'End', allDay: 'All day', calendarLabel: 'Calendar', add: 'Add event',
    delete: 'Delete', noEvents: 'No events.', more: '+{count} more',
    noCalendars: 'No calendars yet — create one below, or open a shared calendar link.',
    share: 'Share', shareCopied: 'Link copied',
  },
  de: {
    title: 'Kalender', myCalendars: 'Meine Kalender', untitled: 'Unbenannter Kalender',
    newCalendar: 'Name des neuen Kalenders…', create: 'Erstellen',
    day: 'Tag', week: 'Woche', month: 'Monat', list: 'Liste',
    today: 'Heute', prev: '←', next: '→',
    filterPlaceholder: 'Nach Titel oder Beschreibung filtern…',
    newEvent: 'Neuer Termin', eventTitle: 'Titel', eventDescription: 'Beschreibung (optional)',
    start: 'Start', end: 'Ende', allDay: 'Ganztägig', calendarLabel: 'Kalender', add: 'Termin hinzufügen',
    delete: 'Löschen', noEvents: 'Keine Termine.', more: '+{count} weitere',
    noCalendars: 'Noch keine Kalender — unten einen anlegen oder einen geteilten Link öffnen.',
    share: 'Teilen', shareCopied: 'Link kopiert',
  },
};
const { t } = createI18n(DICT);

const STYLE_ID = 'qu-calendar-style';
const STYLE = `
  .qu-cal-calendars { display: flex; flex-wrap: wrap; gap: 0.6rem; margin: 0.5rem 0; }
  .qu-cal-calendars label { display: flex; align-items: center; gap: 0.3rem; }
  .qu-cal-swatch { width: 0.7rem; height: 0.7rem; border-radius: 50%; display: inline-block; flex-shrink: 0; }
  .qu-cal-new { display: flex; gap: 0.4rem; margin: 0.5rem 0; }
  .qu-cal-new input { flex: 1; padding: 0.3rem; }
  .qu-cal-toolbar { display: flex; align-items: center; gap: 0.5rem; margin: 0.8rem 0; flex-wrap: wrap; }
  .qu-cal-toolbar button[data-active="true"] { font-weight: 700; text-decoration: underline; }
  .qu-cal-toolbar .qu-cal-spacer { flex: 1; }
  .qu-cal-filter { padding: 0.3rem; min-width: 14rem; }
  .qu-cal-month-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 0.3rem; }
  .qu-cal-month-cell { border: 1px solid #8884; border-radius: 0.3rem; padding: 0.3rem; min-height: 4.5rem; font-size: 0.85em; cursor: pointer; }
  .qu-cal-month-cell[data-dim="true"] { opacity: 0.4; }
  .qu-cal-month-cell[data-today="true"] { border-color: currentColor; border-width: 2px; }
  .qu-cal-day-num { font-weight: 600; }
  .qu-cal-chip { display: block; border-radius: 0.2rem; padding: 0.05rem 0.3rem; margin-top: 0.15rem; color: #fff; font-size: 0.85em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .qu-cal-week-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 0.4rem; }
  .qu-cal-week-col { border: 1px solid #8884; border-radius: 0.3rem; padding: 0.3rem; min-height: 8rem; }
  .qu-cal-day-list, .qu-cal-flat-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.4rem; }
  .qu-cal-event-row { border-left: 4px solid #888; border-radius: 0.2rem; padding: 0.3rem 0.5rem; background: #8881; cursor: pointer; }
  .qu-cal-event-time { font-size: 0.8em; opacity: 0.7; }
  .qu-cal-event-detail { margin-top: 0.3rem; font-size: 0.85em; }
  .qu-cal-event-detail button { margin-top: 0.3rem; }
  .qu-cal-new-event { display: flex; flex-direction: column; gap: 0.4rem; max-width: 28rem; margin-top: 1rem; padding-top: 0.8rem; border-top: 1px solid #8884; }
  .qu-cal-new-event label { display: flex; flex-direction: column; gap: 0.2rem; font-size: 0.9em; }
  .qu-cal-new-event input, .qu-cal-new-event select, .qu-cal-new-event textarea { padding: 0.3rem; font: inherit; }
`;

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  document.head.appendChild(style);
}

function colorFor(calendarId) {
  let hash = 0;
  for (let i = 0; i < calendarId.length; i++) hash = (hash * 31 + calendarId.charCodeAt(i)) >>> 0;
  return PALETTE[hash % PALETTE.length];
}

function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function startOfWeekMon(d) { const x = startOfDay(d); const day = (x.getDay() + 6) % 7; return addDays(x, -day); }
function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
function sameDay(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
function fmtTime(ms) { return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
function fmtDate(d) { return d.toLocaleDateString(); }
function toLocalInputValue(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function mount(container, { qu, services, segments, subscribe, fetch: syncFetch }) {
  ensureStyle();
  let stopped = false;
  let unwatches = [];
  let checked = null; // Set<calendarId> - null until first populated (defaults to "all")
  let view = 'month';
  let cursor = startOfDay(new Date());
  let filterText = '';

  const calendarId = segments[1] ?? null;

  (async () => {
    if (calendarId) {
      if (!(await services.starred.isStarred(NAMESPACE, calendarId))) {
        await services.starred.star(NAMESPACE, calendarId, { title: t('untitled') });
      }
      location.hash = '#/calendar';
      return;
    }
    await renderMain();
  })();

  function clearWatches() {
    for (const u of unwatches) u();
    unwatches = [];
  }

  async function renderMain() {
    if (stopped) return;
    const mine = await services.starred.list(NAMESPACE);
    if (stopped) return;

    if (checked === null) checked = new Set(mine.map((c) => c.id));

    clearWatches();
    for (const cal of mine) {
      if (!checked.has(cal.id)) continue;
      // subscribe() only ever covers writes made AFTER this call (see
      // SyncEngine's own doc comment) - needed for live updates from
      // whoever else has this calendar open, e.g. someone who just joined
      // via the shared link (see the `calendarId` branch above) adding
      // their own event a moment later.
      subscribe(`/store/calendar-${cal.id}`);
      const path = paths.documentPath(`calendar-${cal.id}`, 'events');
      unwatches.push(watch(qu, path, () => renderMain(), { initial: false }));
    }

    // Combined, colored event set from every CHECKED calendar. Backfilled
    // via syncFetch on a local miss - a calendar's events document written
    // before THIS session subscribed (e.g. immediately after joining a
    // shared link someone else has had open for a while) would otherwise
    // never arrive no matter how long subscribe() alone waits.
    const events = [];
    for (const cal of mine) {
      if (!checked.has(cal.id)) continue;
      let doc = await services.documents.get(`calendar-${cal.id}`, 'events');
      if (!doc) {
        try {
          await syncFetch(paths.documentPath(`calendar-${cal.id}`, 'events'));
        } catch {
          // peer unreachable, or this calendar genuinely has no events yet - either way, nothing more to try
        }
        doc = await services.documents.get(`calendar-${cal.id}`, 'events');
      }
      for (const ev of doc?.events ?? []) events.push({ ...ev, calendarId: cal.id, calendarTitle: cal.title || t('untitled'), color: colorFor(cal.id) });
    }
    if (stopped) return;

    container.textContent = '';
    const heading = document.createElement('h1');
    heading.textContent = t('title');
    container.appendChild(heading);

    container.appendChild(calendarsSection(mine));

    if (mine.length === 0) {
      const empty = document.createElement('p');
      empty.textContent = t('noCalendars');
      container.appendChild(empty);
    } else {
      container.appendChild(toolbar());
      container.appendChild(viewEl(events));
      container.appendChild(newEventForm(mine));
    }
  }

  function calendarsSection(mine) {
    const wrap = document.createElement('div');

    const subheading = document.createElement('h2');
    subheading.textContent = t('myCalendars');
    wrap.appendChild(subheading);

    const list = document.createElement('div');
    list.className = 'qu-cal-calendars';
    for (const cal of mine) {
      const label = document.createElement('label');
      const swatch = document.createElement('span');
      swatch.className = 'qu-cal-swatch';
      swatch.style.background = colorFor(cal.id);
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = checked.has(cal.id);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) checked.add(cal.id);
        else checked.delete(cal.id);
        renderMain();
      });
      label.append(checkbox, swatch, document.createTextNode(cal.title || t('untitled')));

      const shareBtn = document.createElement('button');
      shareBtn.type = 'button';
      shareBtn.textContent = t('share');
      shareBtn.addEventListener('click', async () => {
        const url = `${location.origin}${location.pathname}#/calendar/${cal.id}`;
        await navigator.clipboard.writeText(url);
        shareBtn.textContent = t('shareCopied');
        setTimeout(() => { shareBtn.textContent = t('share'); }, 1500);
      });
      label.appendChild(shareBtn);

      list.appendChild(label);
    }
    wrap.appendChild(list);

    const form = document.createElement('form');
    form.className = 'qu-cal-new';
    const input = document.createElement('input');
    input.placeholder = t('newCalendar');
    input.required = true;
    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.textContent = t('create');
    form.append(input, submit);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const title = input.value.trim();
      if (!title) return;
      const newId = crypto.randomUUID();
      await services.documents.create(`calendar-${newId}`, 'events', { events: [] });
      await services.starred.star(NAMESPACE, newId, { title });
      checked?.add(newId);
      await renderMain();
    });
    wrap.appendChild(form);

    return wrap;
  }

  function toolbar() {
    const bar = document.createElement('div');
    bar.className = 'qu-cal-toolbar';

    for (const [key, label] of [['day', t('day')], ['week', t('week')], ['month', t('month')], ['list', t('list')]]) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = label;
      btn.dataset.active = String(view === key);
      btn.addEventListener('click', () => { view = key; renderMain(); });
      bar.appendChild(btn);
    }

    const spacer = document.createElement('span');
    spacer.className = 'qu-cal-spacer';
    bar.appendChild(spacer);

    if (view !== 'list') {
      const prevBtn = document.createElement('button');
      prevBtn.type = 'button';
      prevBtn.textContent = t('prev');
      prevBtn.addEventListener('click', () => { shiftCursor(-1); renderMain(); });
      const todayBtn = document.createElement('button');
      todayBtn.type = 'button';
      todayBtn.textContent = t('today');
      todayBtn.addEventListener('click', () => { cursor = startOfDay(new Date()); renderMain(); });
      const nextBtn = document.createElement('button');
      nextBtn.type = 'button';
      nextBtn.textContent = t('next');
      nextBtn.addEventListener('click', () => { shiftCursor(1); renderMain(); });
      bar.append(prevBtn, todayBtn, nextBtn);
    }

    if (view === 'list') {
      const filterInput = document.createElement('input');
      filterInput.className = 'qu-cal-filter';
      filterInput.placeholder = t('filterPlaceholder');
      filterInput.value = filterText;
      filterInput.addEventListener('input', () => { filterText = filterInput.value; renderMain(); });
      bar.appendChild(filterInput);
    }

    return bar;
  }

  function shiftCursor(dir) {
    if (view === 'day') cursor = addDays(cursor, dir);
    else if (view === 'week') cursor = addDays(cursor, dir * 7);
    else cursor = new Date(cursor.getFullYear(), cursor.getMonth() + dir, 1);
  }

  function viewEl(events) {
    if (view === 'day') return dayView(events);
    if (view === 'week') return weekView(events);
    if (view === 'list') return listView(events);
    return monthView(events);
  }

  function eventsOn(events, day) {
    return events.filter((ev) => sameDay(new Date(ev.start), day)).sort((a, b) => a.start - b.start);
  }

  function eventChip(ev, { compact = false } = {}) {
    const el = document.createElement(compact ? 'div' : 'li');
    el.className = compact ? 'qu-cal-chip' : 'qu-cal-event-row';
    if (compact) {
      el.style.background = ev.color;
      el.textContent = ev.title;
    } else {
      el.style.borderLeftColor = ev.color;
      const time = document.createElement('div');
      time.className = 'qu-cal-event-time';
      time.textContent = ev.allDay ? `${t('allDay')} · ${ev.calendarTitle}` : `${fmtTime(ev.start)} · ${ev.calendarTitle}`;
      const title = document.createElement('div');
      title.textContent = ev.title;
      el.append(time, title);
    }
    el.addEventListener('click', () => toggleDetail(el, ev));
    return el;
  }

  function toggleDetail(el, ev) {
    const existing = el.querySelector('.qu-cal-event-detail');
    if (existing) { existing.remove(); return; }
    const detail = document.createElement('div');
    detail.className = 'qu-cal-event-detail';
    if (ev.description) {
      const desc = document.createElement('div');
      desc.textContent = ev.description;
      detail.appendChild(desc);
    }
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.textContent = t('delete');
    delBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const doc = await services.documents.get(`calendar-${ev.calendarId}`, 'events');
      const remaining = (doc?.events ?? []).filter((e2) => e2.id !== ev.id);
      await services.documents.update(`calendar-${ev.calendarId}`, 'events', { events: remaining });
      await renderMain();
    });
    detail.appendChild(delBtn);
    el.appendChild(detail);
  }

  function dayView(events) {
    const wrap = document.createElement('div');
    const heading = document.createElement('h3');
    heading.textContent = fmtDate(cursor);
    wrap.appendChild(heading);
    const dayEvents = eventsOn(events, cursor);
    const list = document.createElement('ul');
    list.className = 'qu-cal-day-list';
    if (dayEvents.length === 0) {
      const empty = document.createElement('p');
      empty.textContent = t('noEvents');
      wrap.appendChild(empty);
    } else {
      for (const ev of dayEvents) list.appendChild(eventChip(ev));
      wrap.appendChild(list);
    }
    return wrap;
  }

  function weekView(events) {
    const grid = document.createElement('div');
    grid.className = 'qu-cal-week-grid';
    const weekStart = startOfWeekMon(cursor);
    for (let i = 0; i < 7; i++) {
      const day = addDays(weekStart, i);
      const col = document.createElement('div');
      col.className = 'qu-cal-week-col';
      const heading = document.createElement('strong');
      heading.textContent = day.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'numeric' });
      col.appendChild(heading);
      const list = document.createElement('ul');
      list.className = 'qu-cal-day-list';
      for (const ev of eventsOn(events, day)) list.appendChild(eventChip(ev));
      col.appendChild(list);
      grid.appendChild(col);
    }
    return grid;
  }

  function monthView(events) {
    const grid = document.createElement('div');
    grid.className = 'qu-cal-month-grid';
    const monthStart = startOfMonth(cursor);
    const gridStart = startOfWeekMon(monthStart);
    const today = startOfDay(new Date());
    for (let i = 0; i < 42; i++) {
      const day = addDays(gridStart, i);
      const cell = document.createElement('div');
      cell.className = 'qu-cal-month-cell';
      cell.dataset.dim = String(day.getMonth() !== cursor.getMonth());
      cell.dataset.today = String(sameDay(day, today));
      const num = document.createElement('div');
      num.className = 'qu-cal-day-num';
      num.textContent = String(day.getDate());
      cell.appendChild(num);

      const dayEvents = eventsOn(events, day);
      const shown = dayEvents.slice(0, 3);
      for (const ev of shown) cell.appendChild(eventChip(ev, { compact: true }));
      if (dayEvents.length > shown.length) {
        const more = document.createElement('div');
        more.textContent = t('more', { count: dayEvents.length - shown.length });
        cell.appendChild(more);
      }
      cell.addEventListener('click', (e) => {
        if (e.target.closest('.qu-cal-chip')) return; // let a chip's own click handle its detail toggle
        cursor = day;
        view = 'day';
        renderMain();
      });
      grid.appendChild(cell);
    }
    return grid;
  }

  function listView(events) {
    const needle = filterText.trim().toLowerCase();
    const filtered = events
      .filter((ev) => !needle || ev.title.toLowerCase().includes(needle) || (ev.description ?? '').toLowerCase().includes(needle))
      .sort((a, b) => a.start - b.start);
    const list = document.createElement('ul');
    list.className = 'qu-cal-flat-list';
    if (filtered.length === 0) {
      const empty = document.createElement('p');
      empty.textContent = t('noEvents');
      return empty;
    }
    for (const ev of filtered) {
      const row = eventChip(ev);
      const time = row.querySelector('.qu-cal-event-time');
      if (time) time.textContent = `${fmtDate(new Date(ev.start))} ${ev.allDay ? '' : fmtTime(ev.start)} · ${ev.calendarTitle}`;
      list.appendChild(row);
    }
    return list;
  }

  function newEventForm(mine) {
    const form = document.createElement('form');
    form.className = 'qu-cal-new-event';
    const heading = document.createElement('h3');
    heading.textContent = t('newEvent');
    form.appendChild(heading);

    const titleInput = document.createElement('input');
    titleInput.placeholder = t('eventTitle');
    titleInput.required = true;
    const titleLabel = document.createElement('label');
    titleLabel.append(t('eventTitle'), titleInput);

    const descInput = document.createElement('textarea');
    descInput.placeholder = t('eventDescription');
    const descLabel = document.createElement('label');
    descLabel.append(t('eventDescription'), descInput);

    const allDayInput = document.createElement('input');
    allDayInput.type = 'checkbox';
    const allDayLabel = document.createElement('label');
    allDayLabel.style.flexDirection = 'row';
    allDayLabel.append(allDayInput, t('allDay'));

    const startInput = document.createElement('input');
    startInput.type = 'datetime-local';
    startInput.required = true;
    startInput.value = toLocalInputValue(Date.now());
    const startLabel = document.createElement('label');
    startLabel.append(t('start'), startInput);

    const endInput = document.createElement('input');
    endInput.type = 'datetime-local';
    endInput.value = toLocalInputValue(Date.now() + 60 * 60 * 1000);
    const endLabel = document.createElement('label');
    endLabel.append(t('end'), endInput);

    const calSelect = document.createElement('select');
    for (const cal of mine) {
      const option = document.createElement('option');
      option.value = cal.id;
      option.textContent = cal.title || t('untitled');
      if (checked.has(cal.id)) option.selected = true;
      calSelect.appendChild(option);
    }
    const calLabel = document.createElement('label');
    calLabel.append(t('calendarLabel'), calSelect);

    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.textContent = t('add');

    form.append(titleLabel, descLabel, allDayLabel, startLabel, endLabel, calLabel, submit);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const title = titleInput.value.trim();
      if (!title) return;
      const start = new Date(startInput.value).getTime();
      const end = new Date(endInput.value || startInput.value).getTime();
      const calId = calSelect.value;
      const doc = await services.documents.get(`calendar-${calId}`, 'events');
      const events = doc?.events ?? [];
      events.push({ id: crypto.randomUUID(), title, description: descInput.value.trim(), start, end, allDay: allDayInput.checked });
      await services.documents.update(`calendar-${calId}`, 'events', { events });
      await renderMain();
    });

    return form;
  }

  return () => {
    stopped = true;
    clearWatches();
  };
}
