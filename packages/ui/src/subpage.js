/**
 * SUBPAGE — the shared "navigate to a real hash route instead of opening a
 * modal" building block. Every route in this shell (`#/<app>/<...segments>`,
 * see apps/shell/src/router.js) is a REAL browser history entry - the
 * shell's own header already has working back/forward buttons over that
 * (see apps/shell/src/main.js), and the OS/browser back gesture just works
 * too. A `<dialog>` overlay gets none of that for free: closing it isn't a
 * history event, so "how did I get here" and "back" both have to be
 * hand-rolled per app that uses one.
 *
 * This is intentionally tiny: an app still owns its own route parsing
 * (which segment means "create" vs "detail" is app-specific, see
 * apps/calendar/client.js's `calendarId === 'new'` check) and its own form
 * fields - this only standardizes the "← back to X" link + content area
 * shell around whatever the app renders, so every subpage in the whole
 * shell looks and behaves the same way.
 *
 * @param {HTMLElement} container - Cleared and (re)populated in place.
 * @param {{backHref: string, backLabel: string, render: (content: HTMLElement) => void}} options
 *   `backHref`/`backLabel` build the back link (a plain `<a>` - not
 *   `history.back()`, so it works identically whether this subpage was
 *   reached by a link, a direct URL, or the browser's own back/forward).
 *   `render(content)` builds whatever the app needs into a fresh, empty
 *   content element already appended below the back link.
 */
export function renderSubpage(container, { backHref, backLabel, render }) {
  container.textContent = '';

  const back = document.createElement('a');
  back.href = backHref;
  back.className = 'qu-subpage-back';
  back.textContent = backLabel;
  container.appendChild(back);

  const content = document.createElement('div');
  content.className = 'qu-subpage-content';
  container.appendChild(content);

  render(content);
}
