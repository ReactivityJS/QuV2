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
import { maintainWakeLock } from '@qu/wakelock';

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
    joinAsHunter: 'Join as a hunter',
    map: 'Map',
    mapEmpty: 'No location reports to show on the map yet.',
    mapHuntedTrail: 'Hunted team',
    mapHunterTrail: 'Hunters',
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
    joinAsHunter: 'Als Jäger beitreten',
    map: 'Karte',
    mapEmpty: 'Noch keine Standortmeldungen für die Karte.',
    mapHuntedTrail: 'Gejagtes Team',
    mapHunterTrail: 'Jäger',
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
  .qu-geochase-map { border: 1px solid #8884; border-radius: 0.5rem; width: 100%; max-width: 24rem; aspect-ratio: 1; }
  .qu-geochase-map-legend { display: flex; gap: 1rem; font-size: 0.85em; opacity: 0.8; margin-top: 0.3rem; }
  .qu-geochase-map-legend span { display: inline-flex; align-items: center; gap: 0.3rem; }
  .qu-geochase-map-legend .qu-geochase-swatch { width: 0.7rem; height: 0.7rem; border-radius: 50%; display: inline-block; }
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
  let stopWakeLock = null;

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
    // Re-entrant (the "join as hunter" button below re-calls this once
    // it's added itself to the config) - tear down whatever the PREVIOUS
    // call set up first, so re-rendering never leaks a watch subscription
    // or a wake lock.
    unwatch?.();
    stopWakeLock?.();
    subscribe(`/store/geochase-${id}`);

    let [config, myActorPub] = await Promise.all([services.geochase.getConfig(id), services.actors.whoAmI()]);
    // A game's config is written at creation, and self-service ONLY by
    // GeoChaseService.joinAsHunter() after that (see the "join as hunter"
    // button below) - neither case means a browser that subscribed AFTER
    // either write happened will ever see it via subscribe() alone (future
    // writes only, see that function's own doc comment). Opening a just-
    // shared link needs an explicit PULL, not a wait - see
    // apps/shell/src/main.js's `fetch` param doc comment for why this is a
    // separate capability from `subscribe`.
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

      // Self-service join: the whole point of sharing the game's URL with
      // hunters is that they don't need to have already been a contact the
      // creator picked from a checklist at creation time - see
      // GeoChaseService.joinAsHunter()'s own doc comment.
      const joinBtn = document.createElement('button');
      joinBtn.type = 'button';
      joinBtn.textContent = t('joinAsHunter');
      joinBtn.addEventListener('click', async () => {
        await services.geochase.joinAsHunter(id);
        await renderGame(id); // re-render as a hunter now that config includes this identity
      });
      container.appendChild(joinBtn);
    }

    const mapHeading = document.createElement('h2');
    mapHeading.textContent = t('map');
    container.appendChild(mapHeading);
    const mapEl = document.createElement('div');
    container.appendChild(mapEl);

    // "Playing" means having this screen open as a hunted or hunter
    // participant, not just spectating - see @qu/wakelock's own doc
    // comment for why this needs to re-acquire on every visibility change,
    // not just once here.
    if (isHunted || isHunter) stopWakeLock = maintainWakeLock(() => !stopped);

    async function renderPings() {
      if (stopped) return;
      const [pings, hunterPings] = await Promise.all([services.geochase.listPings(id), services.geochase.listHunterPings(id)]);
      if (stopped) return;

      renderMap(mapEl, pings, hunterPings);

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

  /**
   * A dependency-free "map": no tile server this environment (or a real
   * deployment without one configured) can reach, so instead of a real
   * basemap this projects the raw lat/lng location HISTORY onto a locally-
   * centered flat plane (equirectangular, fine at the scale a foot chase
   * happens on) and draws it as an SVG trail - the hunted team's whole
   * path plus the hunters' own (if they chose to share it, see
   * GeoChaseService.listHunterPings()), not just the single last-known-
   * position text status above it.
   * @param {HTMLElement} container
   * @param {Array<{lat: number, lng: number, timestamp: number}>} huntedPings
   * @param {Array<{lat: number, lng: number, timestamp: number}>} hunterPings
   */
  function renderMap(container, huntedPings, hunterPings) {
    container.textContent = '';
    const allPoints = [...huntedPings, ...hunterPings];
    if (allPoints.length === 0) {
      const empty = document.createElement('p');
      empty.textContent = t('mapEmpty');
      container.appendChild(empty);
      return;
    }

    const meanLat = allPoints.reduce((sum, p) => sum + p.lat, 0) / allPoints.length;
    const cosLat = Math.cos((meanLat * Math.PI) / 180);
    const project = (p) => ({ x: p.lng * cosLat, y: -p.lat });

    const projected = allPoints.map(project);
    const xs = projected.map((p) => p.x);
    const ys = projected.map((p) => p.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    // A single point (or a tight cluster) would collapse the view box to
    // zero-size otherwise - a fixed minimum span keeps one lone marker
    // centered and visible instead of an empty/invalid SVG.
    const span = Math.max(maxX - minX, maxY - minY, 0.0005);
    const pad = span * 0.15;
    const viewMin = { x: minX - pad, y: minY - pad };
    const viewSize = span + pad * 2;

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `${viewMin.x} ${viewMin.y} ${viewSize} ${viewSize}`);
    svg.classList.add('qu-geochase-map');

    const strokeW = viewSize * 0.01;
    const dotR = viewSize * 0.02;
    const lastDotR = viewSize * 0.035;

    const drawTrail = (pings, color) => {
      if (pings.length === 0) return;
      const points = pings.map((p) => project(p));
      if (points.length > 1) {
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
        path.setAttribute('points', points.map((p) => `${p.x},${p.y}`).join(' '));
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke', color);
        path.setAttribute('stroke-width', String(strokeW));
        path.setAttribute('opacity', '0.6');
        svg.appendChild(path);
      }
      points.forEach((p, i) => {
        const isLast = i === points.length - 1;
        const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        circle.setAttribute('cx', String(p.x));
        circle.setAttribute('cy', String(p.y));
        circle.setAttribute('r', String(isLast ? lastDotR : dotR));
        circle.setAttribute('fill', color);
        circle.setAttribute('opacity', isLast ? '1' : '0.5');
        svg.appendChild(circle);
      });
    };

    drawTrail(huntedPings, '#e0483e');
    drawTrail(hunterPings, '#3e7fe0');
    container.appendChild(svg);

    const legend = document.createElement('div');
    legend.className = 'qu-geochase-map-legend';
    const huntedLegend = document.createElement('span');
    huntedLegend.innerHTML = '<span class="qu-geochase-swatch" style="background:#e0483e"></span>';
    huntedLegend.append(t('mapHuntedTrail'));
    const hunterLegend = document.createElement('span');
    hunterLegend.innerHTML = '<span class="qu-geochase-swatch" style="background:#3e7fe0"></span>';
    hunterLegend.append(t('mapHunterTrail'));
    legend.append(huntedLegend, hunterLegend);
    container.appendChild(legend);
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
    stopWakeLock?.();
    if (watchPositionId !== null) navigator.geolocation.clearWatch(watchPositionId);
  };
}
