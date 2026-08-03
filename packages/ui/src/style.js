/**
 * INJECT STYLE — the one-line version of the `ensureStyle()`/`STYLE_ID`
 * boilerplate every app under `apps/*` used to hand-roll identically
 * (create a `<style>` once, keyed by id, skip if already present so a
 * remount doesn't duplicate it). Idempotent for the same reason every one
 * of those copies was: `mount()` can run more than once per page load
 * (navigating away from an app and back), and a `<style>` element doesn't
 * deduplicate itself the way a real stylesheet `<link>` would.
 *
 * @param {string} id - Unique per app (e.g. `'qu-todo-style'`) - reused as
 *   the injected `<style>`'s own `id` so a second call is a no-op.
 * @param {string} css
 */
export function injectStyle(id, css) {
  if (document.getElementById(id)) return;
  const style = document.createElement('style');
  style.id = id;
  style.textContent = css;
  document.head.appendChild(style);
}
