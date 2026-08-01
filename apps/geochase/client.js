/**
 * GEO CHASE — a live-GPS hunted/hunters game (see
 * @qu/services/geochase-service.js for the data model + the port of V1's
 * `predictNextRadius()`). Map-free by design in this build - see that
 * service's own doc comment for why - the hunted team's last known
 * position is shown as distance + bearing text instead, refreshed live as
 * new pings arrive.
 *
 * Route: `#/geochase` (my games) or `#/geochase/<gameId>` (one game).
 */
import { paths, predictNextRadius } from '@qu/services';
import { watch } from '@qu/reactive';
import { createI18n } from '@qu/i18n';

const NAMESPACE = 'geochase-games';

const DICT = {
  en: {
    title: 'Geo Chase',
    myGames: 'My games',
    empty: 'No games yet — create one below.',
    newGame: 'New game name…',
    create: 'Create',
    back: '← My games',
    hunted: 'Hunted team',
    hunters: 'Hunters',
    shareLocation: 'Share my location',
    stopSharing: 'Stop sharing',
    lastShared: 'Last shared {seconds}s ago',
    notSharing: 'Not currently sharing',
    lastKnownPosition: 'Last known position',
    noPings: 'No location reports yet.',
    distance: 'Distance: {meters} m',
    searchRadius: 'Could be anywhere within ~{meters} m of the last report',
    declareCatch: 'Declare catch',
    caught: 'Caught! 🎉',
    notCaught: 'Too far away ({meters} m) — keep looking.',
    geoError: 'Location error: {message}',
    spectator: 'You are watching this game, but are not on the hunted team or a hunter.',
  },
  de: {
    title: 'Geo Chase',
    myGames: 'Meine Spiele',
    empty: 'Noch keine Spiele — unten eins anlegen.',
    newGame: 'Name des neuen Spiels…',
    create: 'Erstellen',
    back: '← Meine Spiele',
    hunted: 'Gejagtes Team',
    hunters: 'Jäger',
    shareLocation: 'Standort teilen',
    stopSharing: 'Teilen stoppen',
    lastShared: 'Zuletzt geteilt vor {seconds}s',
    notSharing: 'Teilt momentan nicht',
    lastKnownPosition: 'Letzte bekannte Position',
    noPings: 'Noch keine Standortmeldungen.',
    distance: 'Entfernung: {meters} m',
    searchRadius: 'Könnte sich im Umkreis von ~{meters} m um die letzte Meldung befinden',
    declareCatch: 'Fang erklären',
    caught: 'Gefangen! 🎉',
    notCaught: 'Noch zu weit weg ({meters} m) — weitersuchen.',
    geoError: 'Standortfehler: {message}',
    spectator: 'Du beobachtest dieses Spiel, bist aber nicht im gejagten Team oder ein Jäger.',
  },
};
const { t } = createI18n(DICT);

const STYLE_ID = 'qu-geochase-style';
const STYLE = `
  .qu-geochase-games { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.4rem; }
  .qu-geochase-games li { padding: 0.5rem 0.7rem; border: 1px solid #8884; border-radius: 0.4rem; }
  .qu-geochase-games a { text-decoration: none; color: inherit; }
  .qu-geochase-new { display: flex; flex-direction: column; gap: 0.4rem; margin-top: 0.8rem; max-width: 24rem; }
  .qu-geochase-checklist { display: flex; flex-direction: column; gap: 0.2rem; }
  .qu-geochase-status { padding: 0.6rem; border: 1px solid #8884; border-radius: 0.5rem; margin: 0.6rem 0; }
  .qu-geochase-error { color: #c00; font-size: 0.9em; }
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
  let unwatch = null;
  let watchPositionId = null;

  const gameId = segments[1] ?? null;

  (async () => {
    if (gameId) await renderGame(gameId);
    else await renderMyGames();
  })();

  async function renderMyGames() {
    const mine = await services.starred.list(NAMESPACE);
    if (stopped) return;
    container.textContent = '';

    const heading = document.createElement('h1');
    heading.textContent = t('title');
    container.appendChild(heading);

    const subheading = document.createElement('h2');
    subheading.textContent = t('myGames');
    container.appendChild(subheading);

    if (mine.length === 0) {
      const empty = document.createElement('p');
      empty.textContent = t('empty');
      container.appendChild(empty);
    } else {
      const list = document.createElement('ul');
      list.className = 'qu-geochase-games';
      for (const entry of mine) {
        const li = document.createElement('li');
        const a = document.createElement('a');
        a.href = `#/geochase/${entry.id}`;
        a.textContent = entry.name || entry.id;
        li.appendChild(a);
        list.appendChild(li);
      }
      container.appendChild(list);
    }

    const contacts = await services.contacts.listContacts();
    if (stopped) return;

    const form = document.createElement('form');
    form.className = 'qu-geochase-new';
    const nameInput = document.createElement('input');
    nameInput.placeholder = t('newGame');
    nameInput.required = true;

    const huntedHeading = document.createElement('span');
    huntedHeading.textContent = t('hunted');
    const huntedList = checklist(contacts);
    const huntersHeading = document.createElement('span');
    huntersHeading.textContent = t('hunters');
    const huntersList = checklist(contacts);

    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.textContent = t('create');
    form.append(nameInput, huntedHeading, huntedList.el, huntersHeading, huntersList.el, submit);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = nameInput.value.trim();
      if (!name) return;
      const myActorPub = await services.actors.whoAmI();
      const newGameId = crypto.randomUUID();
      await services.geochase.createGame(newGameId, {
        huntedPubs: [myActorPub, ...huntedList.selected()],
        hunterPubs: huntersList.selected(),
      });
      await services.starred.star(NAMESPACE, newGameId, { name });
      location.hash = `#/geochase/${newGameId}`;
    });
    container.appendChild(form);
  }

  function checklist(contacts) {
    const el = document.createElement('div');
    el.className = 'qu-geochase-checklist';
    const boxes = [];
    for (const { actorPub, profile } of contacts) {
      const label = document.createElement('label');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = actorPub;
      boxes.push(checkbox);
      label.append(checkbox, document.createTextNode(' ' + (profile?.alias ?? `~${actorPub.slice(0, 10)}…`)));
      el.appendChild(label);
    }
    return { el, selected: () => boxes.filter((b) => b.checked).map((b) => b.value) };
  }

  async function renderGame(id) {
    subscribe(`/store/geochase-${id}`);

    let [config, myActorPub] = await Promise.all([services.geochase.getConfig(id), services.actors.whoAmI()]);
    // A game's config is written ONCE at creation and never updated again -
    // unlike pings, no future write will ever arrive to "catch up" a
    // browser that subscribed after the fact (see subscribe()'s own doc
    // comment: future writes only). Opening a just-shared link needs an
    // explicit PULL, not a wait - see apps/shell/src/main.js's `fetch`
    // param doc comment for why this is a separate capability from `subscribe`.
    if (!config) {
      await syncFetch(paths.documentPath(`geochase-${id}`, 'config'));
      if (stopped) return;
      config = await services.geochase.getConfig(id);
    }
    if (stopped) return;
    container.textContent = '';

    const back = document.createElement('a');
    back.href = '#/geochase';
    back.textContent = t('back');
    const heading = document.createElement('h1');
    heading.textContent = t('title');
    container.append(back, heading);

    if (!config) {
      const msg = document.createElement('p');
      msg.textContent = t('empty');
      container.appendChild(msg);
      return;
    }

    const isHunted = (config.huntedPubs ?? []).includes(myActorPub);
    const isHunter = (config.hunterPubs ?? []).includes(myActorPub);

    const statusEl = document.createElement('div');
    statusEl.className = 'qu-geochase-status';
    container.appendChild(statusEl);

    if (isHunted) container.appendChild(renderHuntedControls(id));
    if (isHunter) container.appendChild(renderHunterControls(id, config));
    if (!isHunted && !isHunter) {
      const spectator = document.createElement('p');
      spectator.textContent = t('spectator');
      container.appendChild(spectator);
    }

    async function renderPings() {
      if (stopped) return;
      const pings = await services.geochase.listPings(id);
      if (stopped) return;
      if (pings.length === 0) {
        statusEl.textContent = t('noPings');
        return;
      }
      const last = pings[pings.length - 1];
      const secondsAgo = Math.max(0, Math.round((Date.now() - last.timestamp) / 1000));
      const radius = predictNextRadius(pings, secondsAgo);
      statusEl.textContent = '';
      const title = document.createElement('strong');
      title.textContent = t('lastKnownPosition');
      const time = document.createElement('p');
      time.textContent = `(${secondsAgo}s ago, ${last.lat.toFixed(5)}, ${last.lng.toFixed(5)})`;
      statusEl.append(title, time);
      if (radius !== null) {
        const radiusEl = document.createElement('p');
        radiusEl.textContent = t('searchRadius', { meters: Math.round(radius) });
        statusEl.appendChild(radiusEl);
      }
    }

    await renderPings();
    unwatch = watch(qu, paths.collectionPath(`geochase-${id}`, 'pings'), renderPings, { initial: false });
  }

  function renderHuntedControls(gameId) {
    const wrap = document.createElement('div');
    const btn = document.createElement('button');
    btn.type = 'button';
    const statusLine = document.createElement('p');
    const errorLine = document.createElement('p');
    errorLine.className = 'qu-geochase-error';

    let sharing = false;
    let lastPostAt = 0;
    const MIN_INTERVAL_MS = 15_000; // a floor so a fast-firing watchPosition can't spam writes; the game's own configured pingIntervalMinutes is the intended cadence for a real deployment

    function setButtonLabel() {
      btn.textContent = sharing ? t('stopSharing') : t('shareLocation');
    }
    setButtonLabel();

    btn.addEventListener('click', () => {
      if (sharing) {
        if (watchPositionId !== null) navigator.geolocation.clearWatch(watchPositionId);
        watchPositionId = null;
        sharing = false;
        statusLine.textContent = t('notSharing');
        setButtonLabel();
        return;
      }
      if (!('geolocation' in navigator)) {
        errorLine.textContent = t('geoError', { message: 'not supported' });
        return;
      }
      sharing = true;
      setButtonLabel();
      watchPositionId = navigator.geolocation.watchPosition(
        async (pos) => {
          const now = Date.now();
          if (now - lastPostAt < MIN_INTERVAL_MS) return;
          lastPostAt = now;
          await services.geochase.postPing(gameId, {
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            accuracy: pos.coords.accuracy,
          });
          statusLine.textContent = t('lastShared', { seconds: 0 });
        },
        (err) => { errorLine.textContent = t('geoError', { message: err.message }); },
        { enableHighAccuracy: true }
      );
    });

    wrap.append(btn, statusLine, errorLine);
    return wrap;
  }

  function renderHunterControls(gameId) {
    const wrap = document.createElement('div');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = t('declareCatch');
    const resultLine = document.createElement('p');

    btn.addEventListener('click', () => {
      if (!('geolocation' in navigator)) {
        resultLine.textContent = t('geoError', { message: 'not supported' });
        return;
      }
      navigator.geolocation.getCurrentPosition(
        async (pos) => {
          const result = await services.geochase.checkCatch(gameId, { lat: pos.coords.latitude, lng: pos.coords.longitude });
          resultLine.textContent = result.caught
            ? t('caught')
            : t('notCaught', { meters: Math.round(result.distanceMeters ?? 0) });
        },
        (err) => { resultLine.textContent = t('geoError', { message: err.message }); },
        { enableHighAccuracy: true }
      );
    });

    wrap.append(btn, resultLine);
    return wrap;
  }

  return () => {
    stopped = true;
    unwatch?.();
    if (watchPositionId !== null) navigator.geolocation.clearWatch(watchPositionId);
  };
}
