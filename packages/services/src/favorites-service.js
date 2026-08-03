const FLAG_TYPE = 'favorite';
const ENTITY_KIND = 'app';

/**
 * FAVORITES SERVICE — "apps I use most". Directly mirrors the real Qu's
 * `modules/favorites.js` ("a favorited app is just a starred app, nothing
 * more"), now expressed as flagType `'favorite'` on entityKind `'app'`
 * over the universal `FlagService` (see that file's own doc comment) -
 * same storage path as before (`FlagService`'s legacy-namespace mapping
 * keeps this on StarredService's original `'apps'` namespace), so existing
 * users' favorites are unaffected by this being a facade now rather than
 * a direct `StarredService` wrapper.
 */
export class FavoritesService {
  /** @param {import('./flag-service.js').FlagService} flagService */
  constructor(flagService) {
    this.flags = flagService;
  }

  /** @param {string} appId - A loaded app's manifest `name`. @returns {Promise<Array<object>>} */
  async add(appId) {
    return this.flags.setPrivate(FLAG_TYPE, ENTITY_KIND, appId, true);
  }

  /** @param {string} appId @returns {Promise<Array<object>>} */
  async remove(appId) {
    return this.flags.setPrivate(FLAG_TYPE, ENTITY_KIND, appId, false);
  }

  /** @returns {Promise<string[]>} Favorited app ids. */
  async list() {
    return (await this.flags.listPrivate(FLAG_TYPE, ENTITY_KIND)).map((item) => item.id);
  }

  /** @param {string} appId @returns {Promise<boolean>} */
  async isFavorite(appId) {
    return this.flags.hasPrivate(FLAG_TYPE, ENTITY_KIND, appId);
  }
}
