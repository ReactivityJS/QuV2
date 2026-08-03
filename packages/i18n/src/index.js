/**
 * @QU/I18N — the smallest thing that keeps every app's user-facing strings
 * out of inline literals from day one, without building a full ICU/plural-
 * rules engine nobody's asked for yet. QUniverse's apps are meant to stay
 * "almost only UI" (see the architecture brainstorming) - that only holds up
 * if a UI's strings live in one lookup table per app, not scattered through
 * DOM-building code, so swapping/adding a locale later is a data change, not
 * a code change.
 *
 * Deliberately NOT doing: plural rules, date/number formatting (the
 * platform's own `Intl.*` already covers that per-locale, no need to wrap
 * it), lazy-loaded locale bundles (every app's dictionary here is small
 * enough to ship inline; revisit if that stops being true), or a global
 * singleton (every app creates its OWN `t()` from its OWN dictionary,
 * exactly like every app gets its own Qu Services - no shared mutable
 * i18n state to coordinate across independently-loaded apps).
 *
 * Usage (see apps/shell/src/i18n.js for a real dictionary):
 *   const strings = { en: { greeting: 'Hello, {name}!' }, de: { greeting: 'Hallo, {name}!' } };
 *   const { t, locale } = createI18n(strings);
 *   t('greeting', { name: 'Ada' }); // -> "Hello, Ada!" (or "Hallo, Ada!")
 */

/**
 * Picks the best-supported locale from the browser's own language
 * preference list, falling back to `fallback` if nothing matches. Compares
 * on the base language subtag only ("de-CH" -> "de") since this package's
 * dictionaries are keyed that coarsely - a per-region dictionary can still
 * be added later as a MORE specific key without breaking this match.
 * @param {string[]} supportedLocales
 * @param {string} [fallback='en']
 * @returns {string}
 */
export function detectLocale(supportedLocales, fallback = 'en') {
  const preferred = globalThis.navigator?.languages ?? [globalThis.navigator?.language].filter(Boolean);
  for (const tag of preferred) {
    const base = tag.slice(0, 2).toLowerCase();
    if (supportedLocales.includes(base)) return base;
  }
  return supportedLocales.includes(fallback) ? fallback : (supportedLocales[0] ?? fallback);
}

/** Locales every app's dictionary in this codebase actually ships - the one list a language picker (shell header, Profile, Relay Admin) iterates over. */
export const AVAILABLE_LOCALES = [
  { code: 'en', label: 'English' },
  { code: 'de', label: 'Deutsch' },
];

const LOCALE_STORAGE_KEY = 'qu-locale';

/**
 * @returns {string|null} The user's explicitly chosen locale (see
 *   setLocale()), or null if they've never set one (plain browser
 *   auto-detection applies - see createI18n()). A device-level preference,
 *   not per-identity - deliberately so: which language to render in isn't
 *   sensitive, and tying it to the identity would mean every Qu instance
 *   sharing a device (a public/shared computer) fights over one setting
 *   instead of each just keeping their own.
 */
export function getStoredLocale() {
  try {
    return localStorage.getItem(LOCALE_STORAGE_KEY);
  } catch {
    return null; // localStorage unavailable (e.g. private browsing, disabled storage) - no override
  }
}

/**
 * Persists the user's locale choice for THIS device - every app's own
 * `createI18n()` call picks it up automatically (see that function's own
 * doc comment), no per-app wiring needed. Takes effect on next page load,
 * not live mid-session - see apps/profile/client.js's language selector,
 * which reloads right after calling this.
 * @param {string|null} locale - null clears the override, reverting to
 *   plain browser auto-detection.
 */
export function setLocale(locale) {
  try {
    if (locale) localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    else localStorage.removeItem(LOCALE_STORAGE_KEY);
  } catch {
    // localStorage unavailable - the choice just won't persist across reloads, not worth surfacing as an error
  }
}

/**
 * @param {Record<string, Record<string, string>>} dictionaries - locale -> { key: template }.
 *   A template may reference `{paramName}` placeholders.
 * @param {{locale?: string, fallback?: string}} [options] - `locale` forces a
 *   locale (skip auto-detection AND the stored user preference below,
 *   e.g. for tests); `fallback` (default 'en') is used both as the
 *   last-resort dictionary for missing keys AND as detectLocale()'s
 *   fallback.
 * @returns {{t: (key: string, params?: Record<string, string|number>) => string, locale: string}}
 */
export function createI18n(dictionaries, { locale, fallback = 'en' } = {}) {
  // Priority: an explicit `locale` (a caller that already knows better,
  // e.g. a test) > the user's own stored choice (see setLocale() -
  // deliberately checked here, once, so every app's OWN createI18n() call
  // honors it automatically instead of every app needing its own
  // read-localStorage boilerplate) > plain browser auto-detection.
  const stored = getStoredLocale();
  const resolvedLocale = locale ?? (stored && dictionaries[stored] ? stored : detectLocale(Object.keys(dictionaries), fallback));

  function t(key, params = {}) {
    const template = dictionaries[resolvedLocale]?.[key] ?? dictionaries[fallback]?.[key];
    if (template === undefined) {
      console.warn(`[@qu/i18n] missing translation key "${key}" for locale "${resolvedLocale}" (and fallback "${fallback}")`);
      return key;
    }
    return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
  }

  return { t, locale: resolvedLocale };
}
