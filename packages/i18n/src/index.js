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

/**
 * @param {Record<string, Record<string, string>>} dictionaries - locale -> { key: template }.
 *   A template may reference `{paramName}` placeholders.
 * @param {{locale?: string, fallback?: string}} [options] - `locale` forces a
 *   locale (skip auto-detection, e.g. for tests or a user-chosen setting);
 *   `fallback` (default 'en') is used both as the last-resort dictionary for
 *   missing keys AND as detectLocale()'s fallback.
 * @returns {{t: (key: string, params?: Record<string, string|number>) => string, locale: string}}
 */
export function createI18n(dictionaries, { locale, fallback = 'en' } = {}) {
  const resolvedLocale = locale ?? detectLocale(Object.keys(dictionaries), fallback);

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
