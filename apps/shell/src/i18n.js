/**
 * SHELL I18N — the shell chrome's own strings (header, menus, home screen),
 * built on @qu/i18n. Every mounted APP is free to bring its own dictionary
 * the same way (see apps/app-list/client.js for the pattern); the shell
 * only owns the strings for parts of the page it renders itself.
 *
 * Locale is auto-detected from the browser (see @qu/i18n's detectLocale())
 * unless QU_SHELL_CONFIG.locale forces one - the same override point
 * apps/shell/src/main.js already reads CONFIG.trustedPublisherPubs from.
 */
import { createI18n } from '@qu/i18n';

const DICTIONARIES = {
  en: {
    'nav.back': 'Back',
    'nav.forward': 'Forward',
    'nav.menu': 'Menu',
    'nav.appList': 'App List',
    'nav.admin': 'Relay Admin',
    'nav.favorites.empty': 'No favorite apps yet — pin some from the App List.',
    'identity.you': 'you',
    'home.welcome': 'Welcome, ~{actor}…',
    'home.listedInDirectory': 'Listed in directory (visible to the User List)',
    'appMenu.button': 'App menu',
    'appMenu.share': 'Share',
    'appMenu.shareCopied': 'Link copied to clipboard',
    'appMenu.installShortcut': 'Install this page as a shortcut',
    'appMenu.installApp': 'Install QUniverse (PWA)',
    'appMenu.installUnavailable': 'Install not available in this browser right now',
    'appMenu.favorite.add': 'Add to favorites',
    'appMenu.favorite.remove': 'Remove from favorites',
    'appMenu.backHome': 'Back to home',
  },
  de: {
    'nav.back': 'Zurück',
    'nav.forward': 'Vor',
    'nav.menu': 'Menü',
    'nav.appList': 'App-Liste',
    'nav.admin': 'Relay-Admin',
    'nav.favorites.empty': 'Noch keine favorisierten Apps — in der App-Liste anheften.',
    'identity.you': 'du',
    'home.welcome': 'Willkommen, ~{actor}…',
    'home.listedInDirectory': 'In der Nutzerliste sichtbar',
    'appMenu.button': 'App-Menü',
    'appMenu.share': 'Teilen',
    'appMenu.shareCopied': 'Link in die Zwischenablage kopiert',
    'appMenu.installShortcut': 'Diese Seite als Verknüpfung installieren',
    'appMenu.installApp': 'QUniverse installieren (PWA)',
    'appMenu.installUnavailable': 'Installation in diesem Browser gerade nicht verfügbar',
    'appMenu.favorite.add': 'Zu Favoriten hinzufügen',
    'appMenu.favorite.remove': 'Aus Favoriten entfernen',
    'appMenu.backHome': 'Zurück zur Startseite',
  },
};

export const { t, locale } = createI18n(DICTIONARIES, { locale: globalThis.QU_SHELL_CONFIG?.locale });
