/**
 * QU-COMPONENTS — declarative, reactive Custom Elements over
 * @qu/reactive's `watch()`. The DOM-mount-lifecycle counterpart to that
 * plain function: `<qu-view>` subscribes in `connectedCallback()` and
 * unsubscribes in `disconnectedCallback()`, so a page full of these never
 * needs manually written subscribe/unsubscribe wiring.
 *
 * Deliberately BROWSER-ONLY (extends HTMLElement at module-evaluation time
 * - importing this in Node throws immediately). Import it directly wherever
 * it's used; it registers the tags as a side effect.
 *
 * Elements:
 *   <qu-view>  read-only, live-updating.
 *   <qu-bind>  IS a <qu-view> plus write-back, implemented as a one-method
 *              subclass, not a second mechanism.
 *   <qu-list>  the declarative form of "one <template> stamped per item in
 *              a collection", keyed by each item's own path (see its own
 *              doc comment below).
 *   <qu-key>   shows the CURRENT list item's own id (its path's last
 *              segment) - the one thing a <qu-list> <template> has no other
 *              declarative way to show.
 *   <qu-if>    shows/hides its children based on a watched value's
 *              truthiness (or equality to a fixed attribute) - see its own
 *              doc comment below.
 *
 * ---------------------------------------------------------------------
 * Attributes (<qu-view>/<qu-bind>):
 *   path   Absolute Qu path (e.g. "/store/wiki/docs/intro"). Required,
 *          UNLESS the current `.qu` context is itself a <qu-list> item (see
 *          below), in which case an omitted `path` defaults to that item's
 *          own path.
 *   field  Optional. QuV2 documents are typically ONE JSON object at ONE
 *          path (see @qu/services' DocumentService) rather than one QuBit
 *          per field - so unlike leaf-per-field designs, `field` reads/
 *          writes a PROPERTY of the object at `path`, not a separate QuBit.
 *          <qu-bind>'s write-back is therefore a read-modify-write on that
 *          whole document, not an independent, collision-free write to its
 *          own leaf - fine for the common "one person edits this document"
 *          case, worth knowing if you're binding something with genuinely
 *          concurrent multi-writer edits in mind.
 *   attr   Which DOM attribute/property carries the value:
 *            "value"        form controls (input/textarea/select)
 *            "textContent"  plain text (works with contenteditable)
 *            "innerHTML"    rich content (e.g. a Thread message's
 *                            formattedHtml - see @qu/services/thread-service.js)
 *            "checked"      checkboxes/radios (write-back event: "change")
 *            anything else  a generic HTML attribute (href, src, class,
 *                            data-*, ...), read/written via get/setAttribute
 *          Default ("auto", or omitted): form controls use `.value`,
 *          everything else uses `.textContent`.
 *
 * Target element: a plain `<qu-view>`/`<qu-bind>` acts on ITSELF. Wrap a
 * single real form control (or any element) as its one child, and that
 * child becomes the target instead:
 *
 *   <qu-bind path="/store/wiki/docs/intro" field="title" attr="value"><input></qu-bind>
 *   <qu-view path="/store/gallery/assets/logo/meta" field="mime"></qu-view>
 *
 * Which Qu instance: never a global. Set `.qu` as a plain property on the
 * element itself, or on any ancestor (including across a shadow-root
 * boundary) - findQu() below walks up looking for it. Because appendChild()
 * runs connectedCallback() synchronously, `container.qu = qu` must happen
 * BEFORE the qu-view/qu-bind children are appended - if it's missing at
 * mount time, one microtask retry covers the common "appended, then wired
 * up next line" ordering before giving up for real.
 */
import { watch } from '@qu/reactive';

/** Exported so other browser-only Qu-Components can reuse the same "walk up for `.qu`" resolution. */
export function findQu(el) {
  let node = el;
  while (node) {
    if (node.qu) return node.qu;
    node = node.parentNode || node.host || null;
  }
  return null;
}

function resolveTarget(el) {
  return el.children.length === 1 ? el.children[0] : el;
}

function resolveIO(attrName, target) {
  if (attrName === 'checked') {
    return { get: (el) => el.checked, set: (el, v) => { el.checked = !!v; }, event: 'change' };
  }
  if (attrName === 'value' || attrName === 'textContent' || attrName === 'innerHTML') {
    return { get: (el) => el[attrName], set: (el, v) => { el[attrName] = v ?? ''; }, event: 'input' };
  }
  if (attrName && attrName !== 'auto') {
    return {
      get: (el) => el.getAttribute(attrName),
      set: (el, v) => { if (v == null) el.removeAttribute(attrName); else el.setAttribute(attrName, String(v)); },
      event: 'input',
    };
  }
  const isFormControl = ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
  return isFormControl
    ? { get: (el) => el.value, set: (el, v) => { el.value = v ?? ''; }, event: 'input' }
    : { get: (el) => el.textContent, set: (el, v) => { el.textContent = v ?? ''; }, event: 'input' };
}

export class QuViewElement extends HTMLElement {
  static get observedAttributes() { return ['path', 'field', 'attr']; }

  connectedCallback() { this._mount(); }
  disconnectedCallback() { this._unmount(); }

  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue === newValue || !this.isConnected) return;
    this._mount();
  }

  /**
   * Always tears down any previous mount before building a fresh one - NOT
   * just when the caller already knows one exists. Parsing an element
   * straight from HTML markup with its attributes already present can fire
   * attributeChangedCallback() for those initial attributes while
   * isConnected is ALREADY true, i.e. BEFORE connectedCallback() itself
   * runs - both then call _mount(), and without this, that would mean two
   * independent subscriptions. Self-cleaning here means the order/count of
   * calls no longer matters.
   */
  _mount(isRetry = false) {
    this._unmount();
    const context = findQu(this);
    if (!context) {
      if (!isRetry) queueMicrotask(() => { if (this.isConnected && !this._off) this._mount(true); });
      else console.error(`[${this.tagName.toLowerCase()}] no Qu instance found - set .qu on this element or an ancestor`, this);
      return;
    }
    const pathAttr = this.getAttribute('path');
    const path = pathAttr !== null ? pathAttr : context.ownPath;
    if (!path) {
      console.error(`[${this.tagName.toLowerCase()}] missing "path" attribute (and the current .qu context has no implicit path to fall back to)`, this);
      return;
    }
    const field = this.getAttribute('field');
    const target = resolveTarget(this);
    const io = resolveIO(this.getAttribute('attr'), target);
    this._off = this._start(context, path, field, target, io);
  }

  _unmount() {
    this._off?.();
    this._off = null;
  }

  _start(context, path, field, target, { set }) {
    return watch(context, path, (value) => set(target, field ? value?.[field] : value));
  }
}

export class QuBindElement extends QuViewElement {
  _start(context, path, field, target, io) {
    const off = super._start(context, path, field, target, io);
    const handler = async () => {
      const newValue = io.get(target);
      if (field) {
        const current = (await context.get(path))?.val ?? {};
        await context.put(path, { ...current, [field]: newValue });
      } else {
        await context.put(path, newValue);
      }
    };
    target.addEventListener(io.event, handler);
    return () => {
      off();
      target.removeEventListener(io.event, handler);
    };
  }
}

/**
 * A `.qu`-duck-typed context for one <qu-list> item: forwards get()/
 * onStorageChange() to the real Qu instance (so watch() works unmodified),
 * and adds `ownPath` - the fallback a descendant <qu-view field="..."> with
 * no `path` attribute of its own resolves to, so a <template> never has to
 * repeat the item's id.
 */
class ItemContext {
  constructor(qu, ownPath) {
    this.qu = qu;
    this.ownPath = ownPath;
  }
  get(path) {
    return this.qu.get(path);
  }
  put(path, value) {
    return this.qu.put(path, value);
  }
  onStorageChange(handler) {
    return this.qu.onStorageChange(handler);
  }
}

/**
 * `<qu-list path="...">` - one `<template>` child, cloned once per item in
 * the collection at `path` (see @qu/services' CollectionService), each
 * clone's `.qu` set to an ItemContext so `<qu-view>`/`<qu-bind>` elements
 * inside the template can address that item's fields with a plain `field`,
 * no path math:
 *
 *   <qu-list path="/store/wiki/collections/all-pages">
 *     <template>
 *       <li>
 *         <qu-view field="title"></qu-view>
 *         <qu-bind field="body" attr="innerHTML" contenteditable="true"></qu-bind>
 *       </li>
 *     </template>
 *   </qu-list>
 *
 * Keyed by each item's own `path`: re-renders reuse the SAME cloned
 * elements across changes (tracked in `this._renderedByPath`), only
 * removing entries that dropped out and only reordering when position
 * actually changed - unlike a full teardown/rebuild, this preserves focus,
 * scroll position and any per-item local DOM state (e.g. an open
 * <details>) on items that didn't change, at the cost of "an item that
 * keeps the same path but everything else changes" doing an in-place
 * child update rather than a fresh clone (already the case - the clone's
 * descendants are plain <qu-view>/<qu-bind>, which update themselves).
 */
export class QuListElement extends HTMLElement {
  static get observedAttributes() { return ['path']; }

  connectedCallback() { this._mount(); }
  disconnectedCallback() { this._unmount(); }

  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue === newValue || !this.isConnected) return;
    this._mount();
  }

  _mount(isRetry = false) {
    this._unmount();
    const context = findQu(this);
    if (!context) {
      if (!isRetry) queueMicrotask(() => { if (this.isConnected && !this._off) this._mount(true); });
      else console.error('[qu-list] no Qu instance found - set .qu on this element or an ancestor', this);
      return;
    }
    const path = this.getAttribute('path');
    if (!path) { console.error('[qu-list] missing required "path" attribute', this); return; }
    const template = this.querySelector('template');
    if (!template) { console.error('[qu-list] missing a <template> child to stamp per item', this); return; }

    this._renderedByPath = new Map();
    this._off = watch(context, path, (items) => this._render(items ?? [], context, template));
  }

  _render(items, qu, template) {
    // A collection can reference a path that no longer resolves (e.g. a
    // deleted item) - CollectionEngine's resolution then delivers `null`
    // for that slot. Skip it rather than stamping a clone with no real
    // item behind it (every descendant <qu-view>/<qu-bind> would have no
    // `ownPath` to fall back to and just log a "no path" error).
    const validItems = items.filter((item) => item?.path);

    const nextByPath = new Map();
    for (const item of validItems) {
      let els = this._renderedByPath.get(item.path);
      if (!els) {
        const clone = template.content.cloneNode(true);
        els = [...clone.children];
        for (const el of els) el.qu = new ItemContext(qu, item.path);
      }
      nextByPath.set(item.path, els);
    }

    // Anything that dropped out of the new item list gets removed - not
    // reused even if the same path reappears later, since a removed
    // <qu-view>'s subscription is gone with it.
    for (const [path, els] of this._renderedByPath) {
      if (!nextByPath.has(path)) for (const el of els) el.remove();
    }

    // Walk the target order, moving/inserting only what isn't already in
    // place - insertBefore() on a node that's already exactly there is a
    // no-op in the DOM, so unchanged items never move.
    let cursor = [...this.children].find((child) => child.tagName !== 'TEMPLATE') ?? null;
    for (const item of validItems) {
      for (const el of nextByPath.get(item.path)) {
        if (el !== cursor) this.insertBefore(el, cursor);
        else cursor = el.nextSibling;
      }
    }

    this._renderedByPath = nextByPath;
  }

  _clearItems() {
    for (const child of [...this.children]) {
      if (child.tagName !== 'TEMPLATE') child.remove();
    }
  }

  _unmount() {
    this._off?.();
    this._off = null;
    this._clearItems();
    this._renderedByPath = null;
  }
}

/**
 * `<qu-key>` - displays the current `.qu` context's `ownPath` last segment
 * as plain text (e.g. a <qu-list> item at `/store/wiki/docs/intro` ->
 * `intro`). Never subscribes to anything: an item's own id is exactly what
 * <qu-list> used to decide it's a distinct item in the first place, so it
 * cannot change without becoming a different item (a new stamped clone),
 * unlike its VALUE, which is why <qu-view> still needs a live subscription
 * and this doesn't.
 */
export class QuKeyElement extends HTMLElement {
  connectedCallback() {
    const context = findQu(this);
    const path = context?.ownPath;
    this.textContent = path ? path.slice(path.lastIndexOf('/') + 1) : '';
  }
}

/**
 * `<qu-if path="..." field="..." [equals="..."] [negate]>` - toggles
 * `this.hidden` on a watched value, live:
 *   - no `equals`: hidden when the (optional `field` of the) value is
 *     falsy, shown when truthy.
 *   - `equals="x"`: shown only when `String(value) === "x"` (e.g. an enum
 *     status field), hidden otherwise.
 *   - `negate`: inverts either of the above (a plain "shown unless" form,
 *     rather than requiring a second watch/attribute just to flip it).
 * Same `path`/`field`/implicit-`ownPath` resolution as <qu-view> - inside
 * a <qu-list> <template>, an omitted `path` defaults to that item's own
 * path, same as everywhere else in this file.
 *
 *   <qu-if field="archived" negate><qu-view field="title"></qu-view></qu-if>
 *   <qu-if field="status" equals="published">...</qu-if>
 */
export class QuIfElement extends HTMLElement {
  static get observedAttributes() { return ['path', 'field', 'equals']; }

  connectedCallback() { this._mount(); }
  disconnectedCallback() { this._unmount(); }

  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue === newValue || !this.isConnected) return;
    this._mount();
  }

  _mount(isRetry = false) {
    this._unmount();
    const context = findQu(this);
    if (!context) {
      if (!isRetry) queueMicrotask(() => { if (this.isConnected && !this._off) this._mount(true); });
      else console.error('[qu-if] no Qu instance found - set .qu on this element or an ancestor', this);
      return;
    }
    const pathAttr = this.getAttribute('path');
    const path = pathAttr !== null ? pathAttr : context.ownPath;
    if (!path) {
      console.error('[qu-if] missing "path" attribute (and the current .qu context has no implicit path to fall back to)', this);
      return;
    }
    const field = this.getAttribute('field');
    const hasEquals = this.hasAttribute('equals');
    const equals = this.getAttribute('equals');
    const negate = this.hasAttribute('negate');
    this._off = watch(context, path, (value) => {
      const actual = field ? value?.[field] : value;
      const truthy = hasEquals ? String(actual) === equals : !!actual;
      this.hidden = negate ? truthy : !truthy;
    });
  }

  _unmount() {
    this._off?.();
    this._off = null;
  }
}

if (!customElements.get('qu-view')) customElements.define('qu-view', QuViewElement);
if (!customElements.get('qu-bind')) customElements.define('qu-bind', QuBindElement);
if (!customElements.get('qu-list')) customElements.define('qu-list', QuListElement);
if (!customElements.get('qu-key')) customElements.define('qu-key', QuKeyElement);
if (!customElements.get('qu-if')) customElements.define('qu-if', QuIfElement);
