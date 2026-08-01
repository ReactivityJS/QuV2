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

/**
 * @param {import('@qu/core').QuCore} qu
 * @param {{assetEngine: import('@qu/engines').AssetEngine, identityEngine: import('@qu/identity').QuIdentityEngine, syncFetch?: (path: string) => Promise<object|null>}} deps
 *   `syncFetch` - typically `(path) => sync.fetch(path)` (see @qu/sync) -
 *   is forwarded to ThreadService, DirectoryService and ProfileService so
 *   each can backfill data that hasn't synced yet (see ThreadService's own
 *   constructor doc comment for why); omit it for a server-side/relay
 *   QuCore, which has no equivalent single upstream peer to fetch from.
 * @returns {{documents: DocumentService, collections: CollectionService, assets: AssetService, actors: ActorService, starred: StarredService, threads: ThreadService, favorites: FavoritesService, contacts: ContactsService, directory: DirectoryService, cms: CmsService, profile: ProfileService}}
 */
export function createServices(qu, { assetEngine, identityEngine, syncFetch }) {
  const collections = new CollectionService(qu);
  const starred = new StarredService(qu, identityEngine);
  const documents = new DocumentService(qu);
  return {
    documents,
    collections,
    assets: new AssetService(qu, assetEngine),
    actors: new ActorService(identityEngine),
    starred,
    threads: new ThreadService(qu, identityEngine, collections, syncFetch),
    favorites: new FavoritesService(starred),
    contacts: new ContactsService(starred, identityEngine),
    directory: new DirectoryService(documents, collections, identityEngine, syncFetch),
    cms: new CmsService(documents, collections),
    profile: new ProfileService(qu, identityEngine, syncFetch),
    notificationPrefs: new NotificationPrefsService(qu, identityEngine),
    pushSubscriptions: new PushSubscriptionService(documents, collections, identityEngine),
    geochase: new GeoChaseService(qu, documents, collections, identityEngine),
  };
}
