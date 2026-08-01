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
};
export * as paths from './paths.js';
export { unwrap, unwrapAll } from './unwrap.js';

/**
 * @param {import('@qu/core').QuCore} qu
 * @param {{assetEngine: import('@qu/engines').AssetEngine, identityEngine: import('@qu/identity').QuIdentityEngine}} deps
 * @returns {{documents: DocumentService, collections: CollectionService, assets: AssetService, actors: ActorService, starred: StarredService, threads: ThreadService, favorites: FavoritesService, contacts: ContactsService, directory: DirectoryService, cms: CmsService, profile: ProfileService}}
 */
export function createServices(qu, { assetEngine, identityEngine }) {
  const collections = new CollectionService(qu);
  const starred = new StarredService(qu, identityEngine);
  const documents = new DocumentService(qu);
  return {
    documents,
    collections,
    assets: new AssetService(qu, assetEngine),
    actors: new ActorService(identityEngine),
    starred,
    threads: new ThreadService(qu, identityEngine, collections),
    favorites: new FavoritesService(starred),
    contacts: new ContactsService(starred, identityEngine),
    directory: new DirectoryService(documents, collections, identityEngine),
    cms: new CmsService(documents, collections),
    profile: new ProfileService(qu, identityEngine),
  };
}
