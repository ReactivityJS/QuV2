/**
 * QU SERVICES — public entry point.
 *
 * `createServices()` is the convenience most apps want: given a booted
 * QuCore plus its Engines, it returns the bundle of Services in one object,
 * matching the `Qu.documents.get(id)` shape from the architecture
 * brainstorming.
 */
import { DocumentService } from './document-service.js';
import { CollectionService } from './collection-service.js';
import { AssetService } from './asset-service.js';
import { ActorService } from './actor-service.js';
import { StarredService } from './starred-service.js';
import { ThreadService, THREAD_PRESETS } from './thread-service.js';
import { ChatService } from './chat-service.js';
import { FavoritesService } from './favorites-service.js';
import { ContactsService } from './contacts-service.js';
import { DirectoryService } from './directory-service.js';
import { CmsService } from './cms-service.js';
import { ProfileService } from './profile-service.js';
import { NotificationPrefsService } from './notification-prefs-service.js';
import { PushSubscriptionService } from './push-subscription-service.js';
import { GeoChaseService, distanceMeters, predictNextRadius } from './geochase-service.js';

export {
  DocumentService,
  CollectionService,
  AssetService,
  ActorService,
  StarredService,
  ThreadService,
  THREAD_PRESETS,
  ChatService,
  FavoritesService,
  ContactsService,
  DirectoryService,
  CmsService,
  ProfileService,
  NotificationPrefsService,
  PushSubscriptionService,
  GeoChaseService,
  distanceMeters,
  predictNextRadius,
};
export * as paths from './paths.js';
export { unwrap, unwrapAll } from './unwrap.js';
export { formatActorLabel, matchesActorQuery } from './actor-format.js';

/**
 * @param {import('@qu/core').QuCore} qu
 * @param {{assetEngine: import('@qu/engines').AssetEngine, identityEngine: import('@qu/identity').QuIdentityEngine, syncFetch?: (path: string) => Promise<object|null>, getSyncGeneration?: () => number}} deps
 *   `syncFetch` - typically `(path) => sync.fetch(path)` (see @qu/sync) -
 *   is forwarded to every Service that can backfill data which hasn't
 *   synced yet; omit it for a server-side/relay QuCore, which has no
 *   equivalent single upstream peer to fetch from.
 *   `getSyncGeneration` - typically `() => sync.getGeneration()` (see
 *   @qu/sync) - lets those same Services ALSO background-refresh data they
 *   already have locally cached but which might have gone stale while this
 *   session was offline (see @qu/services/sync-freshness.js) - the fix for
 *   "a message/event/game update from while I was offline never shows up,
 *   even after reconnecting", since `subscribe()`-based sync only ever
 *   delivers writes made after a live connection exists, never a catch-up.
 *   Omitting it (but providing `syncFetch`) still gets the miss-only
 *   backfill every Service already had; omitting both is the old,
 *   local-only behavior.
 * @returns {{documents: DocumentService, collections: CollectionService, assets: AssetService, actors: ActorService, starred: StarredService, threads: ThreadService, favorites: FavoritesService, contacts: ContactsService, directory: DirectoryService, cms: CmsService, profile: ProfileService}}
 */
export function createServices(qu, { assetEngine, identityEngine, syncFetch, getSyncGeneration }) {
  const collections = new CollectionService(qu, syncFetch, getSyncGeneration);
  const starred = new StarredService(qu, identityEngine, syncFetch, getSyncGeneration);
  const documents = new DocumentService(qu, syncFetch, getSyncGeneration);
  const threads = new ThreadService(qu, identityEngine, collections, syncFetch, getSyncGeneration);
  return {
    documents,
    collections,
    assets: new AssetService(qu, assetEngine, identityEngine, syncFetch),
    actors: new ActorService(identityEngine),
    starred,
    threads,
    chat: new ChatService(threads, identityEngine),
    favorites: new FavoritesService(starred),
    contacts: new ContactsService(starred, identityEngine),
    directory: new DirectoryService(documents, collections, identityEngine, syncFetch),
    cms: new CmsService(documents, collections),
    profile: new ProfileService(qu, identityEngine, syncFetch, getSyncGeneration),
    notificationPrefs: new NotificationPrefsService(qu, identityEngine),
    pushSubscriptions: new PushSubscriptionService(documents, collections, identityEngine, syncFetch),
    geochase: new GeoChaseService(qu, documents, collections, identityEngine),
  };
}
