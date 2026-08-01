/**
 * APP CONTEXT MENU — the "⋯" menu the shell renders next to whichever app
 * is currently mounted (see main.js's _renderRoute()). Every app gets this
 * for free without knowing it exists: Share, Install (shortcut or full
 * PWA), a link back home, and a Favorite toggle for the CURRENT app - the
 * same favoriting FavoritesService/App-List use, just reachable from
 * wherever you already are instead of only from the App-List.
 */
import { createDisclosureMenu, menuItem } from './menu.js';
import { canInstall, installApp, installCurrentPageAsShortcut } from './pwa.js';
import { t } from './i18n.js';

/**
 * @param {{isFavorite: boolean, onToggleFavorite: () => Promise<void>}} options
 * @returns {{el: HTMLDetailsElement, destroy: () => void}}
 */
export function buildAppContextMenu({ isFavorite, onToggleFavorite }) {
  const menu = createDisclosureMenu({ label: t('appMenu.button'), buttonContent: '⋯' });

  const shareItem = menuItem({
    label: t('appMenu.share'),
    onClick: async () => {
      const url = location.href;
      if (navigator.share) {
        try { await navigator.share({ url, title: document.title }); } catch { /* user cancelled - not an error */ }
      } else {
        await navigator.clipboard.writeText(url);
        shareItem.textContent = t('appMenu.shareCopied');
        setTimeout(() => { shareItem.textContent = t('appMenu.share'); }, 1500);
      }
      menu.close();
    },
  });

  const installShortcutItem = menuItem({
    label: t('appMenu.installShortcut'),
    onClick: async () => {
      menu.close();
      if (!canInstall()) return alert(t('appMenu.installUnavailable'));
      await installCurrentPageAsShortcut(location.hash);
    },
  });

  const installAppItem = menuItem({
    label: t('appMenu.installApp'),
    onClick: async () => {
      menu.close();
      if (!canInstall()) return alert(t('appMenu.installUnavailable'));
      await installApp();
    },
  });

  const backItem = menuItem({
    label: t('appMenu.backHome'),
    onClick: () => { menu.close(); location.hash = ''; },
  });

  const favoriteItem = menuItem({
    label: isFavorite ? t('appMenu.favorite.remove') : t('appMenu.favorite.add'),
    onClick: async () => {
      menu.close();
      await onToggleFavorite();
    },
  });

  menu.panel.append(shareItem, installShortcutItem, installAppItem, backItem, favoriteItem);
  return { el: menu.el, destroy: menu.destroy };
}
