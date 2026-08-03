/**
 * `renderFlagToggle()` — a small reusable button for FlagService's PRIVATE
 * mode (see @qu/services' FlagService doc comment): "star/bookmark this
 * entity", the same imperative toggle shape apps/user-list's contact
 * toggle and apps/shell's favorite toggle already hand-roll individually.
 * Pulled out once a THIRD, genuinely different entity kind (a Forum
 * thread) needed the identical behaviour, to prove the flag mechanism is
 * actually reusable across entity kinds rather than each caller
 * reinventing its own toggle button.
 *
 * Imperative (not reactive/watch()-based) on purpose, matching every other
 * star/favorite toggle in this codebase: it updates itself immediately on
 * its OWN click (no round-trip needed to see your own action), and
 * broadcasts `qu:flag-changed` (see apps/shell/src/main.js's listener) so
 * any OTHER mounted UI showing this same flag's state stays in sync - the
 * same tradeoff already accepted everywhere else a flag toggle exists.
 */
import { injectStyle } from './style.js';

const STYLE_ID = 'qu-flag-toggle-style';
const STYLE = `
  .qu-flag-toggle { background: none; border: none; cursor: pointer; font-size: 1.1em; opacity: 0.6; }
  .qu-flag-toggle:hover { opacity: 1; }
  .qu-flag-toggle.qu-flag-toggle-active { opacity: 1; }
  .qu-flag-toggle:disabled { cursor: default; }
`;

export function renderFlagToggle({ flags, flagType, entityKind, entityRef, icon, activeIcon, title, activeTitle }) {
  injectStyle(STYLE_ID, STYLE);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'qu-flag-toggle';
  btn.textContent = icon;
  btn.title = title;

  function render(active) {
    btn.textContent = active ? (activeIcon ?? icon) : icon;
    btn.classList.toggle('qu-flag-toggle-active', active);
    btn.title = active ? (activeTitle ?? title) : title;
  }

  flags.hasPrivate(flagType, entityKind, entityRef).then(render);

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    const active = btn.classList.contains('qu-flag-toggle-active');
    await flags.setPrivate(flagType, entityKind, entityRef, !active);
    render(!active);
    window.dispatchEvent(new CustomEvent('qu:flag-changed', { detail: { flagType, entityKind, entityRef, on: !active } }));
    btn.disabled = false;
  });

  return btn;
}
