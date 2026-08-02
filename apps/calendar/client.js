/**
 * CALENDAR — a shared calendar with real, system-managed sharing instead of
 * "the link is the permission" (see git history for that earlier model,
 * still apps/todo's approach): every calendar has a `meta` document
 * (`{title, color, ownerPub, members: [{actorPub, role, addedAt}]}`)
 * alongside its `events` document. Sharing means picking a contact and a
 * role (Editor/Viewer) from the Share PAGE - that appends them to
 * `members`, grows the calendar's `activity` Thread's reader list (see
 * `@qu/services`' `ThreadService.addReader()`) so they start receiving
 * event-change notices, and posts one message into a private
 * `invite-<actorPub>` Thread (a mailbox-shaped Thread, readers: [that one
 * actorPub]) purely to give the relay's existing push-delivery pipeline
 * (`@qu/relay`'s `#deliverThreadPush()`) something to react to - see that
 * file for how `calendar-*` spaces are recognized and turned into an
 * "invite"/"eventChange"/"guestInvite" notification + push.
 *
 * A single EVENT can also be shared with someone who isn't (yet) on the
 * whole calendar: `inviteGuest()` grants them viewer access (via the same
 * `ensureCalendarMembership()` helper `inviteMember()` itself uses) and
 * appends them to that one event's own `guests` list, notifying them via a
 * `guest~<eventId>~<actorPub>` Thread instead of `invite-<actorPub>` - kept
 * as a genuinely separate push action (see manifest's `pushActions`) so
 * "invited to a calendar" and "invited to one event" stay independently
 * mutable/toggleable notification preferences.
 *
 * ROUTING - everything beyond `#/calendar` is a real, addressable, back/
 * forward-navigable PAGE, never a modal `<dialog>`/overlay (those are
 * reserved for things like image lightboxes, not pages or forms):
 *   - `#/calendar` - My Calendars + the combined view.
 *   - `#/calendar/<calId>` - open an invited calendar (stars it into "My
 *     Calendars" then redirects back to `#/calendar`, or explains why it
 *     can't - see `handleInviteLink()`).
 *   - `#/calendar/<calId>/share` - the Share page (rename, color, members,
 *     invite by contact) - owner-only.
 *   - `#/calendar/<calId>/new` or `#/calendar/<calId>/new/<startMs>` - the
 *     New Event page (`startMs` pre-fills the start time, e.g. from
 *     clicking an empty slot in the day/week grid).
 *   - `#/calendar/<calId>/<eventId>` - the Event Detail page (view, and -
 *     toggled in place, no separate URL - Edit).
 *
 * Visiting `#/calendar/<id>` no longer auto-joins on sight: it checks
 * `meta.members` and only stars the calendar into "My Calendars" if this
 * identity is actually listed (i.e. was actually invited) - otherwise it
 * shows a plain "you don't have access" notice. Write access itself is
 * still only as strong as this codebase's document layer generally is (see
 * this file's git history and apps/todo's own doc comment) - `members`/
 * `guests` are the system-of-record for the UI (who's shown, what they can
 * click) and for notifications, not a cryptographic enforcement boundary.
 *
 * Multiple calendars still combine into one view at once (checkboxes in
 * the sidebar), each in its own color - Day/Week/Month/List, with a real
 * hour-of-day timeline for Day/Week (overlapping events laid out
 * side-by-side, a "now" line for today). A Viewer sees everything but no
 * create/edit/delete/invite affordances.
 *
 * No recurring-event (RRULE) support and no true multi-day event spanning -
 * still out of scope; every event occurs on its `start` date only.
 */
import { watch } from '@qu/reactive';
import { paths, THREAD_PRESETS } from '@qu/services';
import { createI18n } from '@qu/i18n';

const NAMESPACE = 'calendars';
const PALETTE = ['#e0483e', '#3e7fe0', '#3ea05e', '#d0a02a', '#9a4fe0', '#e0648a', '#2ab3a6', '#c47a2a'];
const HOUR_PX = 48;
const GRID_PX = HOUR_PX * 24;
const MIN_EVENT_MINUTES = 20; // a very short event still gets a click-able sliver in the time grid
const DEFAULT_DURATION_MS = 30 * 60 * 1000; // a fresh event, or a start-time change with no prior custom duration, defaults to 30 minutes

const DICT = {
  en: {
    title: 'Calendar', myCalendars: 'My calendars', sharedWithMe: 'Shared with me', untitled: 'Untitled calendar',
    newCalendar: 'New calendar name…', create: 'Create',
    day: 'Day', week: 'Week', month: 'Month', list: 'List',
    today: 'Today', prev: '←', next: '→', backToCalendar: '← Calendar',
    filterPlaceholder: 'Filter by title or description…',
    newEvent: 'New event', eventTitle: 'Title', eventDescription: 'Description (optional)',
    start: 'Start', end: 'End', allDay: 'All day', calendarLabel: 'Calendar', add: 'Add event', save: 'Save', cancel: 'Cancel',
    delete: 'Delete', edit: 'Edit', noEvents: 'No events.', more: '+{count} more',
    noCalendars: 'No calendars yet — create one below, or wait for an invite.',
    allHidden: 'Every calendar is hidden — check one below to see its events.',
    share: 'Share', shareTitle: 'Share "{title}"', people: 'People', role_owner: 'Owner', role_editor: 'Editor', role_viewer: 'Viewer',
    invite: 'Invite',
    noContacts: 'No contacts yet — add some from the User List first.',
    remove: 'Remove', leave: 'Leave', leaveConfirm: 'Leave "{title}"? You will lose access unless invited again.',
    renameLabel: 'Name', colorLabel: 'Color', viewOnly: 'View only',
    noAccessTitle: 'No access', noAccessBody: 'You don’t have access to "{title}" — ask the owner to invite you.',
    invalidLink: 'This calendar link is invalid, or the calendar isn’t reachable right now.',
    inviteFailed: 'Could not invite {name}: {message}',
    unknownPerson: '~{pub}…', youSuffix: '{name} (you)',
    eventNotFound: 'This event no longer exists.', eventNoAccess: 'You don’t have access to this event.',
    guests: 'Guests', noGuestsYet: 'No guests yet.', inviteGuest: 'Invite a guest',
  },
  de: {
    title: 'Kalender', myCalendars: 'Meine Kalender', sharedWithMe: 'Für mich freigegeben', untitled: 'Unbenannter Kalender',
    newCalendar: 'Name des neuen Kalenders…', create: 'Erstellen',
    day: 'Tag', week: 'Woche', month: 'Monat', list: 'Liste',
    today: 'Heute', prev: '←', next: '→', backToCalendar: '← Kalender',
    filterPlaceholder: 'Nach Titel oder Beschreibung filtern…',
    newEvent: 'Neuer Termin', eventTitle: 'Titel', eventDescription: 'Beschreibung (optional)',
    start: 'Start', end: 'Ende', allDay: 'Ganztägig', calendarLabel: 'Kalender', add: 'Termin hinzufügen', save: 'Speichern', cancel: 'Abbrechen',
    delete: 'Löschen', edit: 'Bearbeiten', noEvents: 'Keine Termine.', more: '+{count} weitere',
    noCalendars: 'Noch keine Kalender — unten einen anlegen oder auf eine Einladung warten.',
    allHidden: 'Alle Kalender sind ausgeblendet — unten einen anhaken, um Termine zu sehen.',
    share: 'Teilen', shareTitle: '"{title}" teilen', people: 'Personen', role_owner: 'Besitzer', role_editor: 'Bearbeiter', role_viewer: 'Betrachter',
    invite: 'Einladen',
    noContacts: 'Noch keine Kontakte — zuerst in der Nutzerliste hinzufügen.',
    remove: 'Entfernen', leave: 'Verlassen', leaveConfirm: '"{title}" verlassen? Der Zugriff geht verloren, bis erneut eingeladen wird.',
    renameLabel: 'Name', colorLabel: 'Farbe', viewOnly: 'Nur Ansicht',
    noAccessTitle: 'Kein Zugriff', noAccessBody: 'Kein Zugriff auf "{title}" — bitte vom Besitzer einladen lassen.',
    invalidLink: 'Dieser Kalender-Link ist ungültig, oder der Kalender ist gerade nicht erreichbar.',
    inviteFailed: '{name} konnte nicht eingeladen werden: {message}',
    unknownPerson: '~{pub}…', youSuffix: '{name} (Du)',
    eventNotFound: 'Dieser Termin existiert nicht mehr.', eventNoAccess: 'Kein Zugriff auf diesen Termin.',
    guests: 'Gäste', noGuestsYet: 'Noch keine Gäste.', inviteGuest: 'Gast einladen',
  },
};
const { t } = createI18n(DICT);

const STYLE_ID = 'qu-calendar-style';
const STYLE = `
  .qu-cal-layout { display: flex; gap: 1.2rem; align-items: flex-start; flex-wrap: wrap; }
  .qu-cal-sidebar { width: 16rem; flex-shrink: 0; display: flex; flex-direction: column; gap: 1rem; }
  .qu-cal-main { flex: 1; min-width: 18rem; }
  .qu-cal-section-heading { font-size: 0.8em; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.6; margin: 0.6rem 0 0.3rem; }
  .qu-cal-calendars { display: flex; flex-direction: column; gap: 0.3rem; }
  .qu-cal-row { display: flex; align-items: center; gap: 0.4rem; }
  .qu-cal-row label { display: flex; align-items: center; gap: 0.4rem; flex: 1; min-width: 0; cursor: pointer; }
  .qu-cal-row label span.qu-cal-row-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .qu-cal-swatch { width: 0.7rem; height: 0.7rem; border-radius: 50%; display: inline-block; flex-shrink: 0; }
  .qu-cal-row button, .qu-cal-row a { flex-shrink: 0; opacity: 0.6; background: none; border: none; cursor: pointer; font-size: 1em; padding: 0.1rem 0.3rem; text-decoration: none; }
  .qu-cal-row button:hover, .qu-cal-row a:hover { opacity: 1; }
  .qu-cal-new { display: flex; gap: 0.4rem; }
  .qu-cal-new input { flex: 1; padding: 0.3rem; min-width: 0; }
  .qu-cal-toolbar { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.8rem; flex-wrap: wrap; }
  .qu-cal-viewswitch { display: inline-flex; border: 1px solid #8884; border-radius: 999px; overflow: hidden; }
  .qu-cal-viewswitch button { border: none; background: none; padding: 0.3rem 0.8rem; cursor: pointer; }
  .qu-cal-viewswitch button[data-active="true"] { background: currentColor; }
  .qu-cal-viewswitch button[data-active="true"] span { color: Canvas; mix-blend-mode: difference; }
  .qu-cal-nav { display: inline-flex; gap: 0.2rem; align-items: center; }
  .qu-cal-nav button { border: 1px solid #8884; background: none; border-radius: 0.3rem; padding: 0.25rem 0.6rem; cursor: pointer; }
  .qu-cal-heading { font-weight: 600; margin: 0 0.3rem; }
  .qu-cal-spacer { flex: 1; }
  .qu-cal-primary { border: none; border-radius: 0.4rem; padding: 0.4rem 0.9rem; background: #3e7fe0; color: #fff; cursor: pointer; font-weight: 600; text-decoration: none; display: inline-block; }
  .qu-cal-filter { padding: 0.3rem; min-width: 12rem; }
  .qu-cal-month-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 0.3rem; }
  .qu-cal-month-cell { border: 1px solid #8884; border-radius: 0.3rem; padding: 0.3rem; min-height: 5rem; font-size: 0.85em; cursor: pointer; transition: background-color 0.1s; }
  .qu-cal-month-cell:hover { background: #8881; }
  .qu-cal-month-cell[data-dim="true"] { opacity: 0.4; }
  .qu-cal-month-cell[data-today="true"] { border-color: #3e7fe0; border-width: 2px; }
  .qu-cal-day-num { font-weight: 600; }
  .qu-cal-chip { display: block; border-radius: 0.2rem; padding: 0.05rem 0.3rem; margin-top: 0.15rem; color: #fff; font-size: 0.85em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; text-decoration: none; }
  .qu-cal-day-list, .qu-cal-flat-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.4rem; }
  .qu-cal-event-row { border-left: 4px solid #888; border-radius: 0.2rem; padding: 0.3rem 0.5rem; background: #8881; cursor: pointer; text-decoration: none; color: inherit; }
  .qu-cal-event-row, .qu-cal-event-row * { display: block; }
  .qu-cal-event-time { font-size: 0.8em; opacity: 0.7; }
  .qu-cal-allday-row { display: flex; flex-direction: column; gap: 0.2rem; margin: 0.4rem 0 0.6rem; padding-left: 3.5rem; }
  .qu-cal-timegrid-wrap { display: flex; border-top: 1px solid #8884; overflow-x: auto; }
  .qu-cal-hours { width: 3.5rem; flex-shrink: 0; }
  .qu-cal-hour-label { height: ${HOUR_PX}px; box-sizing: border-box; font-size: 0.75em; opacity: 0.6; transform: translateY(-0.6em); text-align: right; padding-right: 0.4rem; }
  .qu-cal-daycols { flex: 1; display: flex; min-width: 30rem; }
  .qu-cal-daycol { flex: 1; position: relative; border-left: 1px solid #8884; background-image: repeating-linear-gradient(to bottom, transparent, transparent ${HOUR_PX - 1}px, #8882 ${HOUR_PX - 1}px, #8882 ${HOUR_PX}px); height: ${GRID_PX}px; cursor: pointer; }
  .qu-cal-daycol-head { text-align: center; font-size: 0.85em; padding-bottom: 0.3rem; font-weight: 600; }
  .qu-cal-daycol-head[data-today="true"] { color: #3e7fe0; }
  .qu-cal-time-event { position: absolute; border-radius: 0.3rem; padding: 0.15rem 0.35rem; color: #fff; font-size: 0.78em; overflow: hidden; cursor: pointer; box-sizing: border-box; text-decoration: none; }
  .qu-cal-now-line { position: absolute; left: 0; right: 0; height: 2px; background: #e0483e; z-index: 2; pointer-events: none; }
  .qu-cal-now-line::before { content: ''; position: absolute; left: -4px; top: -3px; width: 8px; height: 8px; border-radius: 50%; background: #e0483e; }
  .qu-cal-page { max-width: 34rem; }
  .qu-cal-back-link { display: inline-block; margin-bottom: 0.6rem; text-decoration: none; opacity: 0.8; }
  .qu-cal-back-link:hover { opacity: 1; }
  .qu-cal-form { display: flex; flex-direction: column; gap: 0.6rem; }
  .qu-cal-form label { display: flex; flex-direction: column; gap: 0.2rem; font-size: 0.9em; }
  .qu-cal-form input, .qu-cal-form select, .qu-cal-form textarea { padding: 0.3rem; font: inherit; }
  .qu-cal-form-row { display: flex; gap: 0.6rem; }
  .qu-cal-form-row > * { flex: 1; }
  .qu-cal-page-actions { display: flex; justify-content: flex-end; gap: 0.5rem; margin-top: 0.4rem; }
  .qu-cal-page-actions .qu-cal-danger { color: #c0392b; }
  .qu-cal-member-row { display: flex; align-items: center; gap: 0.5rem; padding: 0.25rem 0; }
  .qu-cal-member-row .qu-cal-member-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .qu-cal-invite-row { display: flex; gap: 0.4rem; align-items: center; margin-top: 0.4rem; }
  .qu-cal-invite-row select { flex-shrink: 0; }
  .qu-cal-status { font-size: 0.85em; opacity: 0.75; min-height: 1.2em; }
  .qu-cal-detail-desc { white-space: pre-wrap; margin: 0.4rem 0; }
  .qu-cal-badge { font-size: 0.75em; opacity: 0.65; border: 1px solid #8884; border-radius: 999px; padding: 0.05rem 0.5rem; }
  .qu-cal-noaccess { max-width: 28rem; }
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
function minutesIntoDay(ms, day) { return Math.max(0, Math.min(1440, (ms - startOfDay(day).getTime()) / 60000)); }
function toLocalInputValue(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function roundToHalfHour(d) {
  const x = new Date(d);
  x.setMinutes(x.getMinutes() < 30 ? 0 : 30, 0, 0);
  return x;
}
function shortPerson(actorPub, profile) {
  return profile?.alias || t('unknownPerson', { pub: actorPub.slice(0, 10) });
}
function eventHash(calId, eventId) { return `#/calendar/${calId}/${eventId}`; }
function shareHash(calId) { return `#/calendar/${calId}/share`; }
function newEventHash(calId, startMs) { return startMs ? `#/calendar/${calId}/new/${startMs}` : `#/calendar/${calId}/new`; }

/** Greedy side-by-side layout for overlapping timed events on one day. */
function layoutTimedEvents(events) {
  const sorted = [...events].sort((a, b) => a.start - b.start || a.end - b.end);
  const result = [];
  let cluster = [];
  let clusterEnd = -Infinity;
  const colEnds = [];
  const flush = () => {
    if (!cluster.length) return;
    const maxCols = Math.max(...cluster.map((c) => c.col)) + 1;
    for (const c of cluster) result.push({ ev: c.ev, col: c.col, cols: maxCols });
    cluster = [];
  };
  for (const ev of sorted) {
    if (ev.start >= clusterEnd) { flush(); colEnds.length = 0; clusterEnd = ev.end; }
    else clusterEnd = Math.max(clusterEnd, ev.end);
    let col = 0;
    while (colEnds[col] !== undefined && colEnds[col] > ev.start) col++;
    colEnds[col] = ev.end;
    cluster.push({ ev, col });
  }
  flush();
  return result;
}

export function mount(container, { qu, services, segments, subscribe, fetch: syncFetch }) {
  ensureStyle();
  let stopped = false;
  let unwatches = [];
  let nowTimer = null;
  let checked = null; // Set<calendarId> - null until first populated (defaults to "all")
  let view = 'month';
  let cursor = startOfDay(new Date());
  let filterText = '';
  let myActorPub = null;

  const calId = segments[1] ?? null;
  const sub = segments[2] ?? null; // null | 'share' | 'new' | <eventId>
  const extra = segments[3] ?? null; // 'new'-only: an optional pre-filled start time (ms)

  (async () => {
    myActorPub = await services.actors.whoAmI();
    if (stopped) return;
    if (!calId) { await renderMain(); return; }
    if (!sub) { await handleInviteLink(calId); return; }
    if (sub === 'share') { await renderSharePage(calId); return; }
    if (sub === 'new') { await renderNewEventPage(calId, extra ? Number(extra) : null); return; }
    await renderEventDetailPage(calId, sub);
  })();

  function clearWatches() {
    for (const u of unwatches) u();
    unwatches = [];
    if (nowTimer) { clearInterval(nowTimer); nowTimer = null; }
  }

  function spaceOf(id) { return `calendar-${id}`; }

  async function fetchDoc(id, docId, fallback) {
    const spaceId = spaceOf(id);
    let doc = await services.documents.get(spaceId, docId);
    if (!doc) {
      try { await syncFetch(paths.documentPath(spaceId, docId)); } catch { /* unreachable, or genuinely absent */ }
      doc = await services.documents.get(spaceId, docId);
    }
    return doc ?? fallback;
  }

  function roleOf(meta, actorPub) {
    return meta?.members?.find((m) => m.actorPub === actorPub)?.role ?? null;
  }
  function canEdit(role) { return role === 'owner' || role === 'editor'; }
  function canManage(role) { return role === 'owner'; }

  function backLink() {
    const a = document.createElement('a');
    a.className = 'qu-cal-back-link';
    a.href = '#/calendar';
    a.textContent = t('backToCalendar');
    return a;
  }

  // ---------------------------------------------------------------------
  // Invite-link handling: `#/calendar/<id>` now checks real membership
  // instead of unconditionally starring - see this file's own doc comment.
  // ---------------------------------------------------------------------
  async function handleInviteLink(id) {
    const meta = await fetchDoc(id, 'meta', null);
    if (stopped) return;
    container.textContent = '';
    if (!meta) {
      const p = document.createElement('p');
      p.textContent = t('invalidLink');
      container.appendChild(p);
      return;
    }
    if (roleOf(meta, myActorPub)) {
      if (!(await services.starred.isStarred(NAMESPACE, id))) await services.starred.star(NAMESPACE, id, {});
      location.hash = '#/calendar';
      return;
    }
    const wrap = document.createElement('div');
    wrap.className = 'qu-cal-noaccess';
    const h = document.createElement('h1');
    h.textContent = t('noAccessTitle');
    const p = document.createElement('p');
    p.textContent = t('noAccessBody', { title: meta.title || t('untitled') });
    wrap.append(h, p);
    container.appendChild(wrap);
  }

  // ---------------------------------------------------------------------
  // Main view
  // ---------------------------------------------------------------------
  async function renderMain() {
    if (stopped) return;
    const mine = await services.starred.list(NAMESPACE);
    if (stopped) return;

    if (checked === null) checked = new Set(mine.map((c) => c.id));

    clearWatches();
    const infos = [];
    for (const cal of mine) {
      subscribe(`/store/${spaceOf(cal.id)}`); // live updates - see original doc comment on why `subscribe()` alone isn't enough for backfill
      const path = paths.documentPath(spaceOf(cal.id), 'events');
      unwatches.push(watch(qu, path, () => renderMain(), { initial: false }));
      unwatches.push(watch(qu, paths.documentPath(spaceOf(cal.id), 'meta'), () => renderMain(), { initial: false }));

      const meta = await fetchDoc(cal.id, 'meta', { title: t('untitled'), members: [], ownerPub: null, color: null });
      const eventsDoc = await fetchDoc(cal.id, 'events', { events: [] });
      infos.push({ id: cal.id, meta, events: eventsDoc.events ?? [], role: roleOf(meta, myActorPub), color: meta.color || colorFor(cal.id) });
    }
    if (stopped) return;

    const events = [];
    for (const info of infos) {
      if (!checked.has(info.id)) continue;
      for (const ev of info.events) {
        events.push({ ...ev, calendarId: info.id, calendarTitle: info.meta.title || t('untitled'), color: info.color });
      }
    }

    container.textContent = '';
    const heading = document.createElement('h1');
    heading.textContent = t('title');
    container.appendChild(heading);

    const layout = document.createElement('div');
    layout.className = 'qu-cal-layout';

    const sidebar = document.createElement('div');
    sidebar.className = 'qu-cal-sidebar';
    sidebar.appendChild(calendarsSection(infos.filter((i) => i.role === 'owner'), t('myCalendars')));
    const shared = infos.filter((i) => i.role && i.role !== 'owner');
    if (shared.length) sidebar.appendChild(calendarsSection(shared, t('sharedWithMe')));
    sidebar.appendChild(newCalendarForm());
    layout.appendChild(sidebar);

    const main = document.createElement('div');
    main.className = 'qu-cal-main';
    if (infos.length === 0) {
      const empty = document.createElement('p');
      empty.textContent = t('noCalendars');
      main.appendChild(empty);
    } else if (checked.size === 0) {
      main.appendChild(toolbar(infos));
      const empty = document.createElement('p');
      empty.textContent = t('allHidden');
      main.appendChild(empty);
    } else {
      main.appendChild(toolbar(infos));
      main.appendChild(viewEl(events, infos));
    }
    layout.appendChild(main);

    container.appendChild(layout);
  }

  function calendarsSection(infos, heading) {
    const wrap = document.createElement('div');
    const h = document.createElement('div');
    h.className = 'qu-cal-section-heading';
    h.textContent = heading;
    wrap.appendChild(h);

    const list = document.createElement('div');
    list.className = 'qu-cal-calendars';
    for (const info of infos) {
      const row = document.createElement('div');
      row.className = 'qu-cal-row';

      const label = document.createElement('label');
      const swatch = document.createElement('span');
      swatch.className = 'qu-cal-swatch';
      swatch.style.background = info.color;
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = checked.has(info.id);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) checked.add(info.id);
        else checked.delete(info.id);
        renderMain();
      });
      const titleSpan = document.createElement('span');
      titleSpan.className = 'qu-cal-row-title';
      titleSpan.textContent = info.meta.title || t('untitled');
      label.append(checkbox, swatch, titleSpan);
      row.appendChild(label);

      if (canManage(info.role)) {
        const shareLink = document.createElement('a');
        shareLink.href = shareHash(info.id);
        shareLink.title = t('share');
        shareLink.textContent = '👥';
        row.appendChild(shareLink);
      } else {
        const leaveBtn = document.createElement('button');
        leaveBtn.type = 'button';
        leaveBtn.title = t('leave');
        leaveBtn.textContent = '✕';
        leaveBtn.addEventListener('click', async () => {
          if (!confirm(t('leaveConfirm', { title: info.meta.title || t('untitled') }))) return;
          await services.starred.unstar(NAMESPACE, info.id);
          await renderMain();
        });
        row.appendChild(leaveBtn);
      }
      list.appendChild(row);
    }
    wrap.appendChild(list);
    return wrap;
  }

  function newCalendarForm() {
    const wrap = document.createElement('div');
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
      const meta = { title, ownerPub: myActorPub, color: null, members: [{ actorPub: myActorPub, role: 'owner', addedAt: Date.now() }], createdAt: Date.now() };
      await services.documents.create(spaceOf(newId), 'meta', meta);
      await services.documents.create(spaceOf(newId), 'events', { events: [] });
      await services.threads.createThread(spaceOf(newId), 'activity', THREAD_PRESETS.activity([myActorPub]));
      await services.starred.star(NAMESPACE, newId, {});
      checked?.add(newId);
      await renderMain();
    });
    wrap.appendChild(form);
    return wrap;
  }

  // ---------------------------------------------------------------------
  // Toolbar
  // ---------------------------------------------------------------------
  function toolbar(infos) {
    const bar = document.createElement('div');
    bar.className = 'qu-cal-toolbar';

    const nav = document.createElement('div');
    nav.className = 'qu-cal-nav';
    const todayBtn = document.createElement('button');
    todayBtn.type = 'button';
    todayBtn.textContent = t('today');
    todayBtn.addEventListener('click', () => { cursor = startOfDay(new Date()); renderMain(); });
    nav.appendChild(todayBtn);
    if (view !== 'list') {
      const prevBtn = document.createElement('button');
      prevBtn.type = 'button';
      prevBtn.textContent = t('prev');
      prevBtn.addEventListener('click', () => { shiftCursor(-1); renderMain(); });
      const nextBtn = document.createElement('button');
      nextBtn.type = 'button';
      nextBtn.textContent = t('next');
      nextBtn.addEventListener('click', () => { shiftCursor(1); renderMain(); });
      nav.append(prevBtn, nextBtn);
    }
    bar.appendChild(nav);

    const heading = document.createElement('span');
    heading.className = 'qu-cal-heading';
    heading.textContent = headingLabel();
    bar.appendChild(heading);

    const spacer = document.createElement('span');
    spacer.className = 'qu-cal-spacer';
    bar.appendChild(spacer);

    if (view === 'list') {
      const filterInput = document.createElement('input');
      filterInput.className = 'qu-cal-filter';
      filterInput.placeholder = t('filterPlaceholder');
      filterInput.value = filterText;
      filterInput.addEventListener('input', () => { filterText = filterInput.value; renderMain(); });
      bar.appendChild(filterInput);
    }

    const switcher = document.createElement('div');
    switcher.className = 'qu-cal-viewswitch';
    for (const [key, label] of [['day', t('day')], ['week', t('week')], ['month', t('month')], ['list', t('list')]]) {
      const btn = document.createElement('button');
      btn.type = 'button';
      const span = document.createElement('span');
      span.textContent = label;
      btn.appendChild(span);
      btn.dataset.active = String(view === key);
      btn.addEventListener('click', () => { view = key; renderMain(); });
      switcher.appendChild(btn);
    }
    bar.appendChild(switcher);

    const editableCals = infos.filter((i) => canEdit(i.role));
    if (editableCals.length) {
      const newLink = document.createElement('a');
      newLink.className = 'qu-cal-primary';
      newLink.href = newEventHash(editableCals[0].id);
      newLink.textContent = `+ ${t('newEvent')}`;
      bar.appendChild(newLink);
    }

    return bar;
  }

  function headingLabel() {
    if (view === 'day') return cursor.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    if (view === 'week') {
      const start = startOfWeekMon(cursor);
      const end = addDays(start, 6);
      return `${start.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} – ${end.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`;
    }
    if (view === 'month') return cursor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    return '';
  }

  function shiftCursor(dir) {
    if (view === 'day') cursor = addDays(cursor, dir);
    else if (view === 'week') cursor = addDays(cursor, dir * 7);
    else cursor = new Date(cursor.getFullYear(), cursor.getMonth() + dir, 1);
  }

  function viewEl(events, infos) {
    const editableCals = infos.filter((i) => canEdit(i.role));
    if (view === 'day') return timeGridView([cursor], events, editableCals);
    if (view === 'week') return timeGridView(Array.from({ length: 7 }, (_, i) => addDays(startOfWeekMon(cursor), i)), events, editableCals);
    if (view === 'list') return listView(events);
    return monthView(events);
  }

  function eventsOn(events, day) {
    return events.filter((ev) => sameDay(new Date(ev.start), day)).sort((a, b) => a.start - b.start);
  }

  function eventChip(ev, { compact = false } = {}) {
    const el = document.createElement('a');
    el.href = eventHash(ev.calendarId, ev.id);
    el.className = compact ? 'qu-cal-chip' : 'qu-cal-event-row';
    if (compact) {
      el.style.background = ev.color;
      el.textContent = ev.title;
    } else {
      el.style.borderLeftColor = ev.color;
      const time = document.createElement('span');
      time.className = 'qu-cal-event-time';
      time.textContent = ev.allDay ? `${t('allDay')} · ${ev.calendarTitle}` : `${fmtTime(ev.start)} · ${ev.calendarTitle}`;
      const title = document.createElement('span');
      title.textContent = ev.title;
      el.append(time, title);
    }
    return el;
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
        if (e.target.closest('a')) return; // let a chip's own link navigate instead of also jumping to day view
        cursor = day;
        view = 'day';
        renderMain();
      });
      grid.appendChild(cell);
    }
    return grid;
  }

  function timeGridView(days, events, editableCals) {
    const wrap = document.createElement('div');

    const allDayRow = document.createElement('div');
    allDayRow.className = 'qu-cal-allday-row';
    let anyAllDay = false;
    for (const day of days) {
      for (const ev of eventsOn(events, day).filter((e) => e.allDay)) {
        anyAllDay = true;
        allDayRow.appendChild(eventChip(ev));
      }
    }
    if (anyAllDay) wrap.appendChild(allDayRow);

    const gridWrap = document.createElement('div');
    gridWrap.className = 'qu-cal-timegrid-wrap';

    const hours = document.createElement('div');
    hours.className = 'qu-cal-hours';
    // A blank spacer the height of the day-column headers keeps hour labels aligned with the grid below.
    const headSpacer = document.createElement('div');
    headSpacer.style.height = '1.3rem';
    hours.appendChild(headSpacer);
    for (let h = 0; h < 24; h++) {
      const lbl = document.createElement('div');
      lbl.className = 'qu-cal-hour-label';
      lbl.textContent = h === 0 ? '' : new Date(2000, 0, 1, h).toLocaleTimeString([], { hour: 'numeric' });
      hours.appendChild(lbl);
    }
    gridWrap.appendChild(hours);

    const daycols = document.createElement('div');
    daycols.className = 'qu-cal-daycols';
    const today = startOfDay(new Date());
    const nowLines = [];
    for (const day of days) {
      const colWrap = document.createElement('div');
      const head = document.createElement('div');
      head.className = 'qu-cal-daycol-head';
      head.dataset.today = String(sameDay(day, today));
      head.textContent = days.length > 1
        ? day.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' })
        : '';
      colWrap.appendChild(head);

      const col = document.createElement('div');
      col.className = 'qu-cal-daycol';
      const timed = eventsOn(events, day).filter((e) => !e.allDay);
      for (const { ev, col: c, cols } of layoutTimedEvents(timed)) {
        const startMin = minutesIntoDay(ev.start, day);
        const endMin = Math.max(startMin + MIN_EVENT_MINUTES, minutesIntoDay(ev.end || ev.start, day));
        const el = document.createElement('a');
        el.href = eventHash(ev.calendarId, ev.id);
        el.className = 'qu-cal-time-event';
        el.style.top = `${(startMin / 1440) * GRID_PX}px`;
        el.style.height = `${((endMin - startMin) / 1440) * GRID_PX}px`;
        el.style.left = `${(c / cols) * 100}%`;
        el.style.width = `${100 / cols}%`;
        el.style.background = ev.color;
        el.textContent = `${fmtTime(ev.start)} ${ev.title}`;
        el.addEventListener('click', (e) => e.stopPropagation()); // let the link navigate, but not also trigger the column's own click-to-create below
        col.appendChild(el);
      }

      if (sameDay(day, today)) {
        const nowLine = document.createElement('div');
        nowLine.className = 'qu-cal-now-line';
        positionNowLine(nowLine, day);
        col.appendChild(nowLine);
        nowLines.push({ el: nowLine, day });
      }

      if (editableCals.length) {
        col.addEventListener('click', (e) => {
          const rect = col.getBoundingClientRect();
          const minutes = ((e.clientY - rect.top) / GRID_PX) * 1440;
          const start = new Date(day);
          start.setHours(0, 0, 0, 0);
          start.setMinutes(Math.round(minutes / 30) * 30);
          location.hash = newEventHash(editableCals[0].id, start.getTime());
        });
      }

      colWrap.appendChild(col);
      daycols.appendChild(colWrap);
    }
    gridWrap.appendChild(daycols);
    wrap.appendChild(gridWrap);

    if (nowLines.length) {
      nowTimer = setInterval(() => { for (const { el, day } of nowLines) positionNowLine(el, day); }, 60000);
    }
    return wrap;
  }

  function positionNowLine(el, day) {
    el.style.top = `${(minutesIntoDay(Date.now(), day) / 1440) * GRID_PX}px`;
  }

  function listView(events) {
    const needle = filterText.trim().toLowerCase();
    const filtered = events
      .filter((ev) => !needle || ev.title.toLowerCase().includes(needle) || (ev.description ?? '').toLowerCase().includes(needle))
      .sort((a, b) => a.start - b.start);
    if (filtered.length === 0) {
      const empty = document.createElement('p');
      empty.textContent = t('noEvents');
      return empty;
    }
    const list = document.createElement('ul');
    list.className = 'qu-cal-flat-list';
    for (const ev of filtered) {
      const row = eventChip(ev);
      const time = row.querySelector('.qu-cal-event-time');
      if (time) time.textContent = `${fmtDate(new Date(ev.start))} ${ev.allDay ? '' : fmtTime(ev.start)} · ${ev.calendarTitle}`;
      list.appendChild(row);
    }
    return list;
  }

  // ---------------------------------------------------------------------
  // Shared event-form field builder - used by the New Event page AND by
  // the Event Detail page's in-place Edit mode. Returns a ready-to-append
  // <form>; the caller owns what happens on success/cancel.
  // ---------------------------------------------------------------------
  function buildEventForm({ mode, editableCals, startMs, existing, onSubmit, onCancel }) {
    const form = document.createElement('form');
    form.className = 'qu-cal-form';

    const titleInput = document.createElement('input');
    titleInput.placeholder = t('eventTitle');
    titleInput.required = true;
    titleInput.value = existing?.title ?? '';
    const titleLabel = document.createElement('label');
    titleLabel.append(t('eventTitle'), titleInput);

    const descInput = document.createElement('textarea');
    descInput.placeholder = t('eventDescription');
    descInput.value = existing?.description ?? '';
    const descLabel = document.createElement('label');
    descLabel.append(t('eventDescription'), descInput);

    const allDayInput = document.createElement('input');
    allDayInput.type = 'checkbox';
    allDayInput.checked = existing?.allDay ?? false;
    const allDayLabel = document.createElement('label');
    allDayLabel.style.flexDirection = 'row';
    allDayLabel.append(allDayInput, t('allDay'));

    const startBase = existing?.start ?? startMs ?? Date.now();
    // The event's current duration carries forward: changing the start
    // time keeps whatever gap to the end time already existed (or the
    // 30-minute default for a brand new event), instead of resetting it -
    // see this file's own doc comment.
    let durationMs = existing ? Math.max(existing.end - existing.start, 0) || DEFAULT_DURATION_MS : DEFAULT_DURATION_MS;

    const startInput = document.createElement('input');
    startInput.type = 'datetime-local';
    startInput.required = true;
    startInput.value = toLocalInputValue(existing ? startBase : roundToHalfHour(new Date(startBase)).getTime());
    const startLabel = document.createElement('label');
    startLabel.append(t('start'), startInput);

    const endInput = document.createElement('input');
    endInput.type = 'datetime-local';
    endInput.value = toLocalInputValue(new Date(startInput.value).getTime() + durationMs);
    const endLabel = document.createElement('label');
    endLabel.append(t('end'), endInput);

    startInput.addEventListener('change', () => {
      const s = new Date(startInput.value).getTime();
      if (Number.isNaN(s)) return;
      endInput.value = toLocalInputValue(s + durationMs);
    });
    endInput.addEventListener('change', () => {
      const s = new Date(startInput.value).getTime();
      const eVal = new Date(endInput.value).getTime();
      if (!Number.isNaN(s) && !Number.isNaN(eVal) && eVal > s) durationMs = eVal - s; // a manually-widened/narrowed gap becomes the new "remembered" duration
    });

    const row = document.createElement('div');
    row.className = 'qu-cal-form-row';
    row.append(startLabel, endLabel);

    const calSelect = document.createElement('select');
    for (const cal of editableCals) {
      const option = document.createElement('option');
      option.value = cal.id;
      option.textContent = cal.meta.title || t('untitled');
      if (cal.id === existing?.calendarId) option.selected = true;
      calSelect.appendChild(option);
    }
    const calLabel = document.createElement('label');
    calLabel.append(t('calendarLabel'), calSelect);

    form.append(titleLabel, descLabel, allDayLabel, row, calLabel);

    const actions = document.createElement('div');
    actions.className = 'qu-cal-page-actions';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.textContent = t('cancel');
    cancelBtn.addEventListener('click', () => onCancel());
    const submitBtn = document.createElement('button');
    submitBtn.type = 'submit';
    submitBtn.className = 'qu-cal-primary';
    submitBtn.textContent = mode === 'edit' ? t('save') : t('add');
    actions.append(cancelBtn, submitBtn);
    form.appendChild(actions);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const title = titleInput.value.trim();
      if (!title) return;
      const payload = {
        id: existing?.id ?? crypto.randomUUID(),
        title,
        description: descInput.value.trim(),
        start: new Date(startInput.value).getTime(),
        end: new Date(endInput.value || startInput.value).getTime(),
        allDay: allDayInput.checked,
        guests: existing?.guests ?? [],
      };
      submitBtn.disabled = true;
      try {
        await onSubmit(payload, calSelect.value);
      } finally {
        submitBtn.disabled = false;
      }
    });

    return form;
  }

  // ---------------------------------------------------------------------
  // New Event page - `#/calendar/<calId>/new` (or `.../new/<startMs>`).
  // ---------------------------------------------------------------------
  async function renderNewEventPage(landingCalId, startMs) {
    if (stopped) return;
    const mine = await services.starred.list(NAMESPACE);
    const editableCals = [];
    for (const cal of mine) {
      const meta = await fetchDoc(cal.id, 'meta', null);
      if (canEdit(roleOf(meta, myActorPub))) editableCals.push({ id: cal.id, meta });
    }
    if (stopped) return;

    container.textContent = '';
    container.appendChild(backLink());

    if (editableCals.length === 0) {
      const p = document.createElement('p');
      p.textContent = t('noAccessTitle');
      container.appendChild(p);
      return;
    }

    const page = document.createElement('div');
    page.className = 'qu-cal-page';
    const h = document.createElement('h1');
    h.textContent = t('newEvent');
    page.appendChild(h);

    const targetCalId = editableCals.some((c) => c.id === landingCalId) ? landingCalId : editableCals[0].id;
    const form = buildEventForm({
      mode: 'create',
      editableCals,
      startMs,
      existing: null,
      onCancel: () => { location.hash = '#/calendar'; },
      onSubmit: async (payload, calSelectedId) => {
        await upsertEvent(calSelectedId, payload, { isNew: true });
        location.hash = '#/calendar';
      },
    });
    // Default the calendar <select> to the calendar this page was opened from.
    form.querySelector('select').value = targetCalId;
    page.appendChild(form);
    container.appendChild(page);
  }

  // ---------------------------------------------------------------------
  // Event Detail page - `#/calendar/<calId>/<eventId>` - view, with Edit
  // toggled in place (no separate URL - see this file's own doc comment).
  // ---------------------------------------------------------------------
  async function renderEventDetailPage(id, eventId) {
    if (stopped) return;
    clearWatches();
    subscribe(`/store/${spaceOf(id)}`);
    unwatches.push(watch(qu, paths.documentPath(spaceOf(id), 'events'), () => renderEventDetailPage(id, eventId), { initial: false }));
    unwatches.push(watch(qu, paths.documentPath(spaceOf(id), 'meta'), () => renderEventDetailPage(id, eventId), { initial: false }));

    const meta = await fetchDoc(id, 'meta', null);
    const eventsDoc = await fetchDoc(id, 'events', { events: [] });
    const ev = (eventsDoc.events ?? []).find((e) => e.id === eventId);
    if (stopped) return;

    container.textContent = '';
    container.appendChild(backLink());

    if (!meta || !ev) {
      const p = document.createElement('p');
      p.textContent = t('eventNotFound');
      container.appendChild(p);
      return;
    }
    const role = roleOf(meta, myActorPub);
    if (!role) {
      const p = document.createElement('p');
      p.textContent = t('eventNoAccess');
      container.appendChild(p);
      return;
    }

    const calendarTitle = meta.title || t('untitled');
    const withContext = { ...ev, calendarId: id, calendarTitle, color: meta.color || colorFor(id) };

    const page = document.createElement('div');
    page.className = 'qu-cal-page';
    renderEventView(page, withContext, meta, role, id);
    container.appendChild(page);
  }

  function renderEventView(page, ev, meta, role, id) {
    page.textContent = '';
    const h = document.createElement('h1');
    h.textContent = ev.title;
    page.appendChild(h);

    const metaLine = document.createElement('div');
    metaLine.className = 'qu-cal-event-time';
    metaLine.textContent = ev.allDay
      ? `${t('allDay')} · ${fmtDate(new Date(ev.start))} · ${ev.calendarTitle}`
      : `${fmtDate(new Date(ev.start))} ${fmtTime(ev.start)} – ${fmtTime(ev.end || ev.start)} · ${ev.calendarTitle}`;
    page.appendChild(metaLine);

    if (ev.description) {
      const desc = document.createElement('p');
      desc.className = 'qu-cal-detail-desc';
      desc.textContent = ev.description;
      page.appendChild(desc);
    }

    const guestsHeading = document.createElement('h3');
    guestsHeading.textContent = t('guests');
    page.appendChild(guestsHeading);
    const guestsList = document.createElement('div');
    page.appendChild(guestsList);
    renderGuests(guestsList, ev, id, canEdit(role));

    const actions = document.createElement('div');
    actions.className = 'qu-cal-page-actions';
    if (canEdit(role)) {
      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.textContent = t('edit');
      editBtn.addEventListener('click', async () => {
        const mine = await services.starred.list(NAMESPACE);
        const editableCals = [];
        for (const cal of mine) {
          const m = await fetchDoc(cal.id, 'meta', null);
          if (canEdit(roleOf(m, myActorPub))) editableCals.push({ id: cal.id, meta: m });
        }
        renderEventEditForm(page, ev, editableCals, id);
      });
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'qu-cal-danger';
      delBtn.textContent = t('delete');
      delBtn.addEventListener('click', async () => {
        await removeEvent(id, ev.id);
        location.hash = '#/calendar';
      });
      actions.append(editBtn, delBtn);
    } else {
      const badge = document.createElement('span');
      badge.className = 'qu-cal-badge';
      badge.textContent = t('viewOnly');
      actions.prepend(badge);
    }
    page.appendChild(actions);
  }

  function renderEventEditForm(page, ev, editableCals, id) {
    page.textContent = '';
    const h = document.createElement('h1');
    h.textContent = t('edit');
    page.appendChild(h);

    const form = buildEventForm({
      mode: 'edit',
      editableCals,
      existing: ev,
      onCancel: () => renderEventDetailPage(id, ev.id),
      onSubmit: async (payload, calSelectedId) => {
        if (calSelectedId !== id) {
          await removeEvent(id, ev.id);
          await upsertEvent(calSelectedId, payload, { isNew: true });
        } else {
          await upsertEvent(calSelectedId, payload, { isNew: false });
        }
        location.hash = eventHash(calSelectedId, payload.id);
        // Same-URL edits (calendar unchanged) don't fire `hashchange` -
        // refresh explicitly rather than relying on the navigation above.
        if (calSelectedId === id) await renderEventDetailPage(id, payload.id);
      },
    });
    page.appendChild(form);
  }

  function renderGuests(listEl, ev, id, editable) {
    listEl.textContent = '';
    const guests = ev.guests ?? [];
    if (guests.length === 0) {
      const p = document.createElement('p');
      p.className = 'qu-cal-status';
      p.textContent = t('noGuestsYet');
      listEl.appendChild(p);
    } else {
      for (const guest of guests) {
        const row = document.createElement('div');
        row.className = 'qu-cal-member-row';
        const name = document.createElement('span');
        name.className = 'qu-cal-member-name';
        name.textContent = shortPerson(guest.actorPub, null);
        services.profile.getPublicProfile(guest.actorPub).then((profile) => {
          if (profile?.alias) name.textContent = profile.alias;
        });
        row.appendChild(name);
        if (editable) {
          const removeBtn = document.createElement('button');
          removeBtn.type = 'button';
          removeBtn.textContent = t('remove');
          removeBtn.addEventListener('click', async () => {
            await removeGuest(id, ev.id, guest.actorPub);
            const updatedEvents = (await fetchDoc(id, 'events', { events: [] })).events ?? [];
            const updatedEv = updatedEvents.find((e) => e.id === ev.id) ?? ev;
            renderGuests(listEl, updatedEv, id, editable);
          });
          row.appendChild(removeBtn);
        }
        listEl.appendChild(row);
      }
    }

    if (!editable) return;
    const inviteRow = document.createElement('div');
    inviteRow.className = 'qu-cal-invite-row';
    const contactSelect = document.createElement('select');
    const inviteBtn = document.createElement('button');
    inviteBtn.type = 'button';
    inviteBtn.textContent = t('inviteGuest');
    inviteRow.append(contactSelect, inviteBtn);
    listEl.appendChild(inviteRow);

    const status = document.createElement('p');
    status.className = 'qu-cal-status';
    listEl.appendChild(status);

    services.contacts.listContacts().then((contacts) => {
      const guestPubs = new Set(guests.map((g) => g.actorPub));
      const invitable = contacts.filter((c) => !guestPubs.has(c.actorPub));
      if (invitable.length === 0) {
        contactSelect.disabled = true;
        inviteBtn.disabled = true;
        const opt = document.createElement('option');
        opt.textContent = t('noContacts');
        contactSelect.appendChild(opt);
        return;
      }
      for (const c of invitable) {
        const opt = document.createElement('option');
        opt.value = c.actorPub;
        opt.textContent = shortPerson(c.actorPub, c.profile);
        contactSelect.appendChild(opt);
      }
    });

    inviteBtn.addEventListener('click', async () => {
      const actorPub = contactSelect.value;
      if (!actorPub) return;
      const name = contactSelect.selectedOptions[0]?.textContent ?? actorPub;
      inviteBtn.disabled = true;
      try {
        await inviteGuest(id, ev.id, actorPub);
        const updatedEvents = (await fetchDoc(id, 'events', { events: [] })).events ?? [];
        const updatedEv = updatedEvents.find((e) => e.id === ev.id) ?? { ...ev, guests: [...guests, { actorPub, invitedAt: Date.now() }] };
        renderGuests(listEl, updatedEv, id, editable);
      } catch (err) {
        status.textContent = t('inviteFailed', { name, message: err.message });
      } finally {
        inviteBtn.disabled = false;
      }
    });
  }

  async function upsertEvent(id, payload, { isNew }) {
    const doc = await services.documents.get(spaceOf(id), 'events');
    const events = doc?.events ?? [];
    const next = isNew ? [...events, payload] : events.map((e) => (e.id === payload.id ? payload : e));
    await services.documents.update(spaceOf(id), 'events', { events: next });
    await notifyActivity(id, isNew ? 'created' : 'updated');
  }

  async function removeEvent(id, eventId) {
    const doc = await services.documents.get(spaceOf(id), 'events');
    const remaining = (doc?.events ?? []).filter((e) => e.id !== eventId);
    await services.documents.update(spaceOf(id), 'events', { events: remaining });
    await notifyActivity(id, 'deleted');
  }

  /**
   * Posts into the calendar's `activity` Thread purely to give the relay's
   * existing push-delivery pipeline something to react to (see this file's
   * own doc comment, and @qu/relay's `#deliverThreadPush()`) - every OTHER
   * current member gets an in-app notice + push, gated by their own
   * notification prefs. A no-op for a solo (owner-only) calendar.
   */
  async function notifyActivity(id, kind) {
    const meta = await fetchDoc(id, 'meta', null);
    if (!meta || (meta.members?.length ?? 0) < 2) return;
    try {
      await services.threads.postMessage(spaceOf(id), 'activity', { body: kind });
    } catch {
      // activity thread missing (a calendar created before this feature existed) - not worth failing the actual event write over
    }
  }

  // ---------------------------------------------------------------------
  // Share page - `#/calendar/<calId>/share` - owner-only.
  // ---------------------------------------------------------------------
  async function renderSharePage(id) {
    if (stopped) return;
    clearWatches();
    subscribe(`/store/${spaceOf(id)}`);
    unwatches.push(watch(qu, paths.documentPath(spaceOf(id), 'meta'), () => renderSharePage(id), { initial: false }));

    const meta = await fetchDoc(id, 'meta', null);
    if (stopped) return;

    container.textContent = '';
    container.appendChild(backLink());

    if (!meta || !canManage(roleOf(meta, myActorPub))) {
      // Not owner (or calendar unreachable) - never reachable from the UI,
      // but someone could still type the URL directly.
      location.hash = '#/calendar';
      return;
    }
    const color = meta.color || colorFor(id);

    const page = document.createElement('div');
    page.className = 'qu-cal-page';
    const h = document.createElement('h1');
    h.textContent = t('shareTitle', { title: meta.title || t('untitled') });
    page.appendChild(h);

    const renameForm = document.createElement('form');
    renameForm.className = 'qu-cal-form';
    const nameInput = document.createElement('input');
    nameInput.value = meta.title || '';
    const nameLabel = document.createElement('label');
    nameLabel.append(t('renameLabel'), nameInput);

    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.value = color;
    const colorLabel = document.createElement('label');
    colorLabel.append(t('colorLabel'), colorInput);

    const renameRow = document.createElement('div');
    renameRow.className = 'qu-cal-form-row';
    renameRow.append(nameLabel, colorLabel);
    const saveBtn = document.createElement('button');
    saveBtn.type = 'submit';
    saveBtn.textContent = t('save');
    renameForm.append(renameRow, saveBtn);
    renameForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      await services.documents.update(spaceOf(id), 'meta', { title: nameInput.value.trim() || t('untitled'), color: colorInput.value });
    });
    page.appendChild(renameForm);

    const peopleHeading = document.createElement('h3');
    peopleHeading.textContent = t('people');
    page.appendChild(peopleHeading);

    const memberList = document.createElement('div');
    page.appendChild(memberList);
    const info = { id, meta, color };
    renderMembers(memberList, info);

    const inviteRow = document.createElement('div');
    inviteRow.className = 'qu-cal-invite-row';
    const contactSelect = document.createElement('select');
    const roleSelect = document.createElement('select');
    for (const [val, label] of [['editor', t('role_editor')], ['viewer', t('role_viewer')]]) {
      const opt = document.createElement('option');
      opt.value = val;
      opt.textContent = label;
      roleSelect.appendChild(opt);
    }
    const inviteBtn = document.createElement('button');
    inviteBtn.type = 'button';
    inviteBtn.textContent = t('invite');
    inviteRow.append(contactSelect, roleSelect, inviteBtn);
    page.appendChild(inviteRow);

    const status = document.createElement('p');
    status.className = 'qu-cal-status';
    page.appendChild(status);

    services.contacts.listContacts().then((contacts) => {
      const memberPubs = new Set(meta.members.map((m) => m.actorPub));
      const invitable = contacts.filter((c) => !memberPubs.has(c.actorPub));
      if (invitable.length === 0) {
        contactSelect.disabled = true;
        inviteBtn.disabled = true;
        const opt = document.createElement('option');
        opt.textContent = t('noContacts');
        contactSelect.appendChild(opt);
        return;
      }
      for (const c of invitable) {
        const opt = document.createElement('option');
        opt.value = c.actorPub;
        opt.textContent = shortPerson(c.actorPub, c.profile);
        contactSelect.appendChild(opt);
      }
    });

    inviteBtn.addEventListener('click', async () => {
      const actorPub = contactSelect.value;
      if (!actorPub) return;
      const name = contactSelect.selectedOptions[0]?.textContent ?? actorPub;
      inviteBtn.disabled = true;
      try {
        await inviteMember(id, actorPub, roleSelect.value);
        status.textContent = '';
        const refreshedMeta = await fetchDoc(id, 'meta', meta);
        renderMembers(memberList, { ...info, meta: refreshedMeta });
        contactSelect.querySelector(`option[value="${CSS.escape(actorPub)}"]`)?.remove();
      } catch (err) {
        status.textContent = t('inviteFailed', { name, message: err.message });
      } finally {
        inviteBtn.disabled = false;
      }
    });

    container.appendChild(page);
  }

  function renderMembers(listEl, info) {
    listEl.textContent = '';
    for (const member of info.meta.members) {
      const row = document.createElement('div');
      row.className = 'qu-cal-member-row';
      const name = document.createElement('span');
      name.className = 'qu-cal-member-name';
      name.textContent = member.actorPub === myActorPub ? t('youSuffix', { name: shortPerson(member.actorPub, null) }) : shortPerson(member.actorPub, null);
      services.profile.getPublicProfile(member.actorPub).then((profile) => {
        if (profile?.alias) name.textContent = member.actorPub === myActorPub ? t('youSuffix', { name: profile.alias }) : profile.alias;
      });
      row.appendChild(name);

      if (member.role === 'owner') {
        const badge = document.createElement('span');
        badge.className = 'qu-cal-badge';
        badge.textContent = t('role_owner');
        row.appendChild(badge);
      } else {
        const roleSelect = document.createElement('select');
        for (const [val, label] of [['editor', t('role_editor')], ['viewer', t('role_viewer')]]) {
          const opt = document.createElement('option');
          opt.value = val;
          opt.textContent = label;
          if (val === member.role) opt.selected = true;
          roleSelect.appendChild(opt);
        }
        roleSelect.addEventListener('change', async () => {
          await changeMemberRole(info.id, member.actorPub, roleSelect.value);
        });
        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.textContent = t('remove');
        removeBtn.addEventListener('click', async () => {
          await removeMember(info.id, member.actorPub);
          const refreshedMeta = await fetchDoc(info.id, 'meta', info.meta);
          renderMembers(listEl, { ...info, meta: refreshedMeta });
        });
        row.append(roleSelect, removeBtn);
      }
      listEl.appendChild(row);
    }
  }

  /**
   * Adds `actorPub` to the calendar's member list at `role` - a no-op if
   * they're already a member (their existing role is left untouched, never
   * silently downgraded by a later invite of any kind). Shared by
   * `inviteMember()` (an explicit calendar-level share) and `inviteGuest()`
   * (inviting someone to one EVENT who isn't a calendar member yet needs
   * at least viewer access to see it at all) - factored out so each of
   * those can post its OWN, distinct notification without this part
   * duplicating or double-notifying.
   */
  async function ensureCalendarMembership(id, actorPub, role) {
    const spaceId = spaceOf(id);
    const meta = await services.documents.get(spaceId, 'meta');
    if (meta.members.some((m) => m.actorPub === actorPub)) return meta;
    const members = [...meta.members, { actorPub, role, addedAt: Date.now() }];
    await services.documents.update(spaceId, 'meta', { members });
    await services.threads.createThread(spaceId, 'activity', THREAD_PRESETS.activity(members.map((m) => m.actorPub)));
    await services.threads.addReader(spaceId, 'activity', actorPub);
    return { ...meta, members };
  }

  async function inviteMember(id, actorPub, role) {
    const spaceId = spaceOf(id);

    // Attempted FIRST, before any membership state is written: posting
    // into a one-shot, single-reader Thread (purely to trigger the relay's
    // push pipeline for THIS invitee alone - see @qu/relay's
    // `#deliverThreadPush()`) fails closed if the invitee has no resolvable
    // encryption key yet (see ThreadService.postMessage's own doc comment).
    // Ordering it first means that failure aborts the whole invite instead
    // of silently granting access nobody was actually notified about.
    try {
      await services.threads.createThread(spaceId, `invite-${actorPub}`, THREAD_PRESETS.mail(actorPub));
      await services.threads.postMessage(spaceId, `invite-${actorPub}`, { body: 'invited' });
    } catch {
      throw new Error('their profile hasn’t synced yet - try again shortly');
    }

    await ensureCalendarMembership(id, actorPub, role);
  }

  /**
   * Invites `actorPub` to ONE event rather than the whole calendar -
   * grants them viewer access if they aren't already a member (see
   * `ensureCalendarMembership()`) and records them on the event's own
   * `guests` list. Notified via a SEPARATE push action from
   * `inviteMember()` (`guest~<eventId>~<actorPub>`, see @qu/relay's
   * `#deliverThreadPush()`), so "invited to a calendar" and "invited to
   * one event" stay independently toggleable notification preferences.
   */
  async function inviteGuest(id, eventId, actorPub) {
    const spaceId = spaceOf(id);
    try {
      await services.threads.createThread(spaceId, `guest~${eventId}~${actorPub}`, THREAD_PRESETS.mail(actorPub));
      await services.threads.postMessage(spaceId, `guest~${eventId}~${actorPub}`, { body: 'invited' });
    } catch {
      throw new Error('their profile hasn’t synced yet - try again shortly');
    }

    await ensureCalendarMembership(id, actorPub, 'viewer');

    const doc = await services.documents.get(spaceId, 'events');
    const events = (doc?.events ?? []).map((e) => (e.id === eventId ? { ...e, guests: [...(e.guests ?? []), { actorPub, invitedAt: Date.now() }] } : e));
    await services.documents.update(spaceId, 'events', { events });
  }

  async function removeGuest(id, eventId, actorPub) {
    const spaceId = spaceOf(id);
    const doc = await services.documents.get(spaceId, 'events');
    const events = (doc?.events ?? []).map((e) => (e.id === eventId ? { ...e, guests: (e.guests ?? []).filter((g) => g.actorPub !== actorPub) } : e));
    await services.documents.update(spaceId, 'events', { events });
  }

  async function changeMemberRole(id, actorPub, role) {
    const spaceId = spaceOf(id);
    const meta = await services.documents.get(spaceId, 'meta');
    const members = meta.members.map((m) => (m.actorPub === actorPub ? { ...m, role } : m));
    await services.documents.update(spaceId, 'meta', { members });
  }

  async function removeMember(id, actorPub) {
    const spaceId = spaceOf(id);
    const meta = await services.documents.get(spaceId, 'meta');
    const members = meta.members.filter((m) => m.actorPub !== actorPub);
    await services.documents.update(spaceId, 'meta', { members });
    try { await services.threads.removeReader(spaceId, 'activity', actorPub); } catch { /* no activity thread yet - nothing to revoke */ }
  }

  return () => {
    stopped = true;
    clearWatches();
  };
}
