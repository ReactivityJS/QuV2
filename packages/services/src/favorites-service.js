const NAMESPACE = 'apps';

/**
 * FAVORITES SERVICE — "apps I use most", a thin wrapper over
 * StarredService with a fixed namespace. Directly mirrors the real Qu's
 * `modules/favorites.js`, which documents itself the same way: a favorited
 * app is just a starred app, nothing more.
 */
export class FavoritesService {
  /** @param {import('./starred-service.js').StarredService} starredService */
  constructor(starredService) {
    this.starred = starredService;
  }

  /** @param {string} appId - A loaded app's manifest `name`. @returns {Promise<Array<object>>} */
  async add(appId) {
    return this.starred.star(NAMESPACE, appId);
  }

  /** @param {string} appId @returns {Promise<Array<object>>} */
  async remove(appId) {
    return this.starred.unstar(NAMESPACE, appId);
  }

  /** @returns {Promise<string[]>} Favorited app ids. */
  async list() {
    return (await this.starred.list(NAMESPACE)).map((item) => item.id);
  }

  /** @param {string} appId @returns {Promise<boolean>} */
  async isFavorite(appId) {
    return this.starred.isStarred(NAMESPACE, appId);
  }
}
