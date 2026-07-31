import { documentPath } from './paths.js';

const PAGES_COLLECTION = 'cms-pages';

/** @param {string} slug @returns {string} */
function pageDocId(slug) {
  return `page-${slug}`;
}

/**
 * CMS SERVICE — content management, built entirely on DocumentService +
 * CollectionService with a `page-<slug>` naming convention. No new Engine:
 * a CMS page IS a document under a space's `docs` segment, so it already
 * gets DocumentEngine's `_id`/`_created` stamping for free - CMS is purely
 * a Service-level convention (slug addressing + a listing collection) over
 * primitives that already exist, not a new pipeline behaviour.
 */
export class CmsService {
  /**
   * @param {import('./document-service.js').DocumentService} documentService
   * @param {import('./collection-service.js').CollectionService} collectionService
   */
  constructor(documentService, collectionService) {
    this.documents = documentService;
    this.collections = collectionService;
  }

  /**
   * Creates or updates a page.
   * @param {string|number} spaceId
   * @param {string} slug
   * @param {{title: string, body: string, [key: string]: *}} content
   * @param {object} [options]
   * @returns {Promise<object>} The stored page.
   */
  async savePage(spaceId, slug, content, options = {}) {
    const existing = await this.getPage(spaceId, slug);
    const page = existing
      ? await this.documents.update(spaceId, pageDocId(slug), { ...content, slug }, options)
      : await this.documents.create(spaceId, pageDocId(slug), { ...content, slug }, options);
    await this.collections.addItem(spaceId, PAGES_COLLECTION, documentPath(spaceId, pageDocId(slug)));
    return page;
  }

  /** @param {string|number} spaceId @param {string} slug @returns {Promise<object|null>} */
  async getPage(spaceId, slug) {
    return this.documents.get(spaceId, pageDocId(slug));
  }

  /** @param {string|number} spaceId @returns {Promise<Array<object>>} */
  async listPages(spaceId) {
    return (await this.collections.list(spaceId, PAGES_COLLECTION)) ?? [];
  }
}
