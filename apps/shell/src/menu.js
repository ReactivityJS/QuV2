/**
 * DISCLOSURE MENU — the one small reusable dropdown-button widget both the
 * header menu (favorites/App-List/Relay-Admin, see main.js) and the
 * per-app context menu (Share/Install/Favorite, see context-menu.js) are
 * built from. A native `<details>/<summary>` rather than a hand-rolled
 * open/close state machine: the browser already handles keyboard toggling
 * and focus correctly for free. The only thing native `<details>` doesn't
 * do - closing when the user clicks elsewhere on the page - is added here,
 * once, instead of twice.
 */

/**
 * @param {{label: string, buttonContent: string}} options - `label` is an
 *   aria-label (e.g. "Menu"/"App menu"); `buttonContent` is the visible
 *   button text/icon (e.g. "☰" or "⋯").
 * @returns {{el: HTMLDetailsElement, panel: HTMLDivElement, close: () => void, destroy: () => void}}
 *   `destroy()` removes the outside-click listener - call it when the menu
 *   itself is torn down (e.g. the per-app context menu, rebuilt on every
 *   route change); the header's own menu lives for the whole page and never
 *   needs to.
 */
export function createDisclosureMenu({ label, buttonContent }) {
  const details = document.createElement('details');
  details.className = 'qu-menu';
  const summary = document.createElement('summary');
  summary.className = 'qu-menu-button';
  summary.setAttribute('aria-label', label);
  summary.textContent = buttonContent;
  const panel = document.createElement('div');
  panel.className = 'qu-menu-panel';
  details.append(summary, panel);

  const onOutsideClick = (event) => {
    if (details.open && !details.contains(event.target)) details.open = false;
  };
  document.addEventListener('click', onOutsideClick);

  return {
    el: details,
    panel,
    close: () => { details.open = false; },
    destroy: () => document.removeEventListener('click', onOutsideClick),
  };
}

/**
 * @param {{label: string, onClick: () => void}} options
 * @returns {HTMLButtonElement}
 */
export function menuItem({ label, onClick }) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'qu-menu-item';
  button.textContent = label;
  button.addEventListener('click', onClick);
  return button;
}
