/**
 * Q LOGO — one shared SVG markup generator used for both the header
 * wordmark and the PWA manifest icon (see pwa.js), so there's exactly one
 * place that defines what "the Q" looks like. A plain circle + letterform,
 * no external asset/font dependency - safe to inline directly into HTML or
 * base64-encode into a manifest icon's `data:` URI.
 *
 * @param {{size?: number, bg?: string, fg?: string}} [options]
 * @returns {string} Self-contained `<svg>...</svg>` markup.
 */
export function qLogoSvgMarkup({ size = 32, bg = '#5b5bd6', fg = '#ffffff' } = {}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${size}" height="${size}" role="img" aria-label="QUniverse">
    <circle cx="32" cy="32" r="32" fill="${bg}"/>
    <circle cx="32" cy="30" r="16" fill="none" stroke="${fg}" stroke-width="6"/>
    <line x1="41" y1="39" x2="50" y2="48" stroke="${fg}" stroke-width="6" stroke-linecap="round"/>
  </svg>`;
}

/** @returns {string} A `data:image/svg+xml` URI of the logo at the given size, e.g. for a manifest icon or <img src>. */
export function qLogoDataUri(options) {
  return `data:image/svg+xml;base64,${btoa(qLogoSvgMarkup(options))}`;
}
