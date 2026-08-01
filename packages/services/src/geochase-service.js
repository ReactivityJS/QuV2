import { QuCrypto } from '@qu/core';
import { documentPath, collectionPath } from './paths.js';

/** @param {string|number} gameId @returns {string} */
function spaceFor(gameId) {
  return `geochase-${gameId}`;
}

const PINGS_COLLECTION = 'pings';
const HUNTER_PINGS_COLLECTION = 'hunter-pings';

/**
 * @param {{lat: number, lng: number}} a
 * @param {{lat: number, lng: number}} b
 * @returns {number} Great-circle distance in meters (haversine formula).
 */
export function distanceMeters(a, b) {
  const R = 6371000;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Ported from QUniverse V1's `examples/hunt-lib.mjs` - "you could be
 * anywhere within this radius" estimate, combining the hunted team's
 * AVERAGE pace over the whole trail (steady movement) with their PEAK
 * inter-ping speed (so a single fast sprint between two pings isn't
 * averaged away and undersold) - whichever is higher wins, multiplied by
 * how long it's been since their last known position.
 *
 * @param {Array<{lat: number, lng: number, timestamp: number}>} pings - Chronologically ANY order; sorted internally.
 * @param {number} elapsedSeconds - Time since the most recent ping.
 * @returns {number|null} Meters, or null if there isn't enough trail data yet (fewer than 2 pings).
 */
export function predictNextRadius(pings, elapsedSeconds) {
  if (pings.length < 2) return null;
  const sorted = [...pings].sort((a, b) => a.timestamp - b.timestamp);

  let totalDistance = 0;
  let peakSpeed = 0;
  for (let i = 1; i < sorted.length; i++) {
    const dt = (sorted[i].timestamp - sorted[i - 1].timestamp) / 1000;
    const d = distanceMeters(sorted[i - 1], sorted[i]);
    totalDistance += d;
    if (dt > 0) peakSpeed = Math.max(peakSpeed, d / dt);
  }
  const totalTime = (sorted[sorted.length - 1].timestamp - sorted[0].timestamp) / 1000;
  const avgSpeed = totalTime > 0 ? totalDistance / totalTime : 0;

  return Math.max(avgSpeed, peakSpeed) * Math.max(0, elapsedSeconds);
}

/**
 * GEO CHASE SERVICE — a live-GPS hunted/hunters game, ported conceptually
 * from QUniverse V1's `examples/hunt-lib.mjs`: one hunted team periodically
 * reports its location; one or more hunter teams see those pings and try
 * to get within a catch radius and declare a catch.
 *
 * SCOPE NOTE: V1's own UI layered a Leaflet map + OpenStreetMap tiles over
 * this same data model (`examples/hunt/app.mjs`). This port keeps the game
 * LOGIC (pings, verified team membership, `predictNextRadius()`, catch
 * enforcement) but ships a map-FREE UI (distance + bearing text - see
 * apps/geochase/client.js) rather than pulling in a mapping library and
 * live tile-server access neither this repo's dependency-free stance nor
 * this development environment's network access (no route to a tile
 * server) could actually verify end-to-end. A map is the natural richer
 * upgrade for a real deployment; the underlying service here doesn't care
 * how its data gets drawn.
 *
 * SECURITY NOTE, same one V1's own hunt-lib.mjs states plainly: GPS can be
 * spoofed client-side. Pings ARE cryptographically verified to come from
 * an actual configured team member (a forged team membership is not
 * possible), but nothing stops a genuine team member's device from
 * reporting a false position. Fine for a trust-based casual game, not a
 * security guarantee about physical location.
 */
export class GeoChaseService {
  /**
   * @param {import('@qu/core').QuCore} qu
   * @param {import('./document-service.js').DocumentService} documentService
   * @param {import('./collection-service.js').CollectionService} collectionService
   * @param {import('@qu/identity').QuIdentityEngine} identityEngine
   */
  constructor(qu, documentService, collectionService, identityEngine) {
    this.qu = qu;
    this.documents = documentService;
    this.collections = collectionService;
    this.identity = identityEngine;
  }

  async #myActorPub() {
    const mainKey = await this.identity.getMainKey();
    return QuCrypto.toBase64Url(mainKey.publicKey);
  }

  /**
   * Creates a game (idempotent - returns the existing config unchanged if
   * one already exists at this id, same "ensure" pattern ThreadService's
   * createThread() uses).
   * @param {string|number} gameId
   * @param {{huntedPubs: string[], hunterPubs: string[], pingIntervalMinutes?: number, catchRadiusMeters?: number}} config
   * @returns {Promise<object>}
   */
  async createGame(gameId, config) {
    const existing = await this.getConfig(gameId);
    if (existing) return existing;
    const normalized = { pingIntervalMinutes: 2, catchRadiusMeters: 50, ...config };
    const spaceId = spaceFor(gameId);
    await this.documents.create(spaceId, 'config', normalized);
    if ((await this.collections.list(spaceId, PINGS_COLLECTION)) === null) await this.collections.create(spaceId, PINGS_COLLECTION, []);
    if ((await this.collections.list(spaceId, HUNTER_PINGS_COLLECTION)) === null) await this.collections.create(spaceId, HUNTER_PINGS_COLLECTION, []);
    return normalized;
  }

  /** @param {string|number} gameId @returns {Promise<object|null>} */
  async getConfig(gameId) {
    return this.documents.get(spaceFor(gameId), 'config');
  }

  /**
   * Self-service join: adds this identity to `hunterPubs` if it isn't
   * already a team member, so sharing just the game's URL (`#/geochase/
   * <gameId>`, see apps/geochase/client.js) is enough to invite hunters -
   * the creator no longer has to have pre-selected every hunter from
   * their contacts at creation time. The config document itself is
   * unsigned/open (same "the link is the permission" model
   * apps/todo/client.js already documents for its own shared lists, not a
   * new trade-off introduced here) - idempotent, so joining twice is a
   * harmless no-op.
   * @param {string|number} gameId
   * @returns {Promise<object>} The updated config.
   * @throws {Error} If the game doesn't exist.
   */
  async joinAsHunter(gameId) {
    const config = await this.getConfig(gameId);
    if (!config) throw new Error(`GeoChaseService.joinAsHunter: no game "${gameId}"`);
    const myActorPub = await this.#myActorPub();
    if ((config.hunterPubs ?? []).includes(myActorPub)) return config;
    return this.documents.update(spaceFor(gameId), 'config', { hunterPubs: [...(config.hunterPubs ?? []), myActorPub] });
  }

  /**
   * Reports a position. Only a configured team member may call this
   * meaningfully - the write itself is signed with this identity's own
   * key, and every READ below re-verifies the signer is still an
   * authorized team member (never a self-asserted field in the ping data
   * itself) before trusting a ping at all.
   * @param {string|number} gameId
   * @param {{lat: number, lng: number, accuracy?: number}} position
   * @param {{asHunter?: boolean}} [options] - `asHunter: true` reports to
   *   the OPTIONAL hunterPings feed (hunters sharing their own position
   *   back to the hunted team) instead of the main (hunted team) pings feed.
   * @returns {Promise<object>} The stored ping.
   */
  async postPing(gameId, { lat, lng, accuracy = null }, { asHunter = false } = {}) {
    const spaceId = spaceFor(gameId);
    const mainKey = await this.identity.getMainKey();
    const pingId = crypto.randomUUID();
    const ping = { _id: pingId, lat, lng, accuracy, timestamp: Date.now() };
    const options = { signWith: mainKey.privateKeyPkcs8, writerPub: mainKey.publicKey };
    await this.documents.create(spaceId, pingId, ping, options);
    const collectionId = asHunter ? HUNTER_PINGS_COLLECTION : PINGS_COLLECTION;
    await this.collections.addItem(spaceId, collectionId, documentPath(spaceId, pingId));
    return ping;
  }

  /**
   * @param {string|number} gameId
   * @returns {Promise<Array<object>>} Every ping from the HUNTED team, verified, oldest-first.
   */
  async listPings(gameId) {
    const config = await this.getConfig(gameId);
    if (!config) return [];
    return this.#listVerified(gameId, PINGS_COLLECTION, config.huntedPubs ?? []);
  }

  /**
   * @param {string|number} gameId
   * @returns {Promise<Array<object>>} Every ping from HUNTERS (optional - only meaningful if hunters chose to share their position), verified, oldest-first.
   */
  async listHunterPings(gameId) {
    const config = await this.getConfig(gameId);
    if (!config) return [];
    return this.#listVerified(gameId, HUNTER_PINGS_COLLECTION, config.hunterPubs ?? []);
  }

  async #listVerified(gameId, collectionId, authorizedPubs) {
    const spaceId = spaceFor(gameId);
    const { adapter, rel } = this.qu.resolveMount(collectionPath(spaceId, collectionId));
    const raw = await adapter.get(rel);
    const paths = raw?.val?.$list ?? [];

    const pings = [];
    for (const path of paths) {
      const quBit = await this.qu.get(path);
      if (!quBit?.pub) continue;
      const signerPub = QuCrypto.toBase64Url(QuCrypto.fromBase64(quBit.pub));
      if (!authorizedPubs.includes(signerPub)) continue; // signed, but by someone no longer (or never) on the team - ignore
      pings.push({ ...quBit.val, author: signerPub });
    }
    return pings.sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Checks whether a claimed hunter position is within catch range of the
   * hunted team's most recent verified ping. Doesn't "declare" anything by
   * itself beyond returning the answer - the caller (an app) decides what
   * to do with a successful catch (e.g. record it, announce it in a
   * Thread - out of this service's scope).
   * @param {string|number} gameId
   * @param {{lat: number, lng: number}} hunterPosition
   * @returns {Promise<{caught: boolean, distanceMeters: number|null}>}
   */
  async checkCatch(gameId, hunterPosition) {
    const [config, pings] = await Promise.all([this.getConfig(gameId), this.listPings(gameId)]);
    if (!config || pings.length === 0) return { caught: false, distanceMeters: null };
    const lastPing = pings[pings.length - 1];
    const distance = distanceMeters(hunterPosition, lastPing);
    return { caught: distance <= config.catchRadiusMeters, distanceMeters: distance };
  }
}
