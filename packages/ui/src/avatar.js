/**
 * AVATAR — one shared renderer for a profile's `avatar` field (an
 * emoji/short string, an `https://` image URL, or unset) used everywhere an
 * identity shows up: the shell header, Profile, User List, Contact List,
 * Chat. An image URL always renders as an actual `<img>` (never as raw
 * link/URL text) filling a colored, circular badge sized via `size`; a
 * short string (emoji) renders as text in that same badge; nothing set
 * falls back to the label's first letter. The badge color is derived from
 * `seed` (a pub or group id) so it stays stable across re-renders without
 * needing to persist a color anywhere.
 */
const PALETTE = ['#e17076', '#faa774', '#a695e7', '#7bc862', '#6ec9cb', '#65aadd', '#ee7aae', '#f2c94c'];

const STYLE_ID = 'qu-avatar-style';
const STYLE = `
  .qu-avatar { position: relative; display: inline-flex; flex-shrink: 0; align-items: center; justify-content: center; width: var(--qu-avatar-size, 2rem); height: var(--qu-avatar-size, 2rem); border-radius: 50%; overflow: hidden; color: #fff; font-weight: 600; line-height: 1; user-select: none; font-size: calc(var(--qu-avatar-size, 2rem) * 0.42); }
  .qu-avatar img { width: 100%; height: 100%; object-fit: cover; display: block; }
`;

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  document.head.appendChild(style);
}

function colorFor(seed) {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return PALETTE[hash % PALETTE.length];
}

function initialsOf(name) {
  return (name || '?').trim().slice(0, 1).toUpperCase();
}

/**
 * @param {string} seed - Stable identity for badge color (a pub, or a group id).
 * @param {string} label - Display name/alias to derive the letter fallback from.
 * @param {string|null|undefined} avatarValue - Profile `avatar` field: an emoji/short string, an image URL, or unset.
 * @param {{size?: string}} [opts] - Any valid CSS length for the badge's diameter (default `2rem`).
 * @returns {HTMLElement}
 */
export function renderAvatar(seed, label, avatarValue, { size = '2rem' } = {}) {
  ensureStyle();
  const el = document.createElement('div');
  el.className = 'qu-avatar';
  el.style.setProperty('--qu-avatar-size', size);
  el.style.background = colorFor(seed || label || '');
  if (avatarValue && /^https?:\/\//.test(avatarValue)) {
    const img = document.createElement('img');
    img.src = avatarValue;
    img.alt = '';
    el.appendChild(img);
  } else if (avatarValue) {
    el.textContent = avatarValue;
  } else {
    el.textContent = initialsOf(label);
  }
  return el;
}
