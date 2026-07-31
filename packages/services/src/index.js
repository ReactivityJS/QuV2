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

export { DocumentService, CollectionService, AssetService, ActorService };
export * as paths from './paths.js';
export { unwrap, unwrapAll } from './unwrap.js';

/**
 * @param {import('@qu/core').QuCore} qu
 * @param {{assetEngine: import('@qu/engines').AssetEngine, identityEngine: import('@qu/identity').QuIdentityEngine}} deps
 * @returns {{documents: DocumentService, collections: CollectionService, assets: AssetService, actors: ActorService}}
 */
export function createServices(qu, { assetEngine, identityEngine }) {
  return {
    documents: new DocumentService(qu),
    collections: new CollectionService(qu),
    assets: new AssetService(qu, assetEngine),
    actors: new ActorService(identityEngine),
  };
}
