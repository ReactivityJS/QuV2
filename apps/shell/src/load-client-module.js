/**
 * LOAD CLIENT MODULE — fetches and (optionally, but strongly recommended
 * for anything not served by the shell's OWN relay) integrity/signature
 * verifies a browser ES module before importing it. This is the
 * client-side counterpart to @qu/loader's `RemoteLoader.loadRemote()`
 * (server-side), used here for a single already-known file URL (an app's
 * `clientMain`, resolved from the relay's `/apps.json` - see @qu/relay)
 * rather than a full manifest-fetch flow.
 *
 * No pinning requested (`integrity` omitted) trusts the fetch source
 * directly via plain `import()` - the normal case for an app hosted by the
 * SAME relay that already decided to load it (see @qu/relay's boot()),
 * which is exactly as trusted as any other same-origin script this page
 * loads. Pinning is for anything crossing a trust boundary: a genuinely
 * different origin, or a same-relay app an operator wants extra assurance
 * on. Same constraint as server-side remote loading: a `data:` URL module
 * has no base to resolve relative imports from, so a pinned client module
 * must be a single, self-contained bundle.
 */
import { QuCrypto } from '@qu/core';

/**
 * @param {string} url
 * @param {{integrity?: string, signature?: string, trustedPublisherPubs?: string[]}} [options]
 * @returns {Promise<object>} The imported module.
 */
export async function loadClientModule(url, { integrity, signature, trustedPublisherPubs = [] } = {}) {
  if (!integrity) {
    return import(/* @vite-ignore */ url);
  }

  const res = await fetch(url);
  if (!res.ok) throw new Error(`loadClientModule: failed to fetch ${url} (HTTP ${res.status})`);
  const bytes = new Uint8Array(await res.arrayBuffer());

  const actual = QuCrypto.toBase64(await QuCrypto.sha256(bytes));
  const expected = integrity.replace(/^sha256-/, '');
  if (actual !== expected) {
    throw new Error(`loadClientModule: integrity mismatch for ${url} - expected sha256-${expected}, got sha256-${actual}`);
  }

  if (signature) {
    if (trustedPublisherPubs.length === 0) {
      console.warn(`[shell] ${url} is signed but no trustedPublisherPubs configured - signature was NOT verified`);
    } else {
      const sig = QuCrypto.fromBase64Url(signature);
      let verified = false;
      for (const pub of trustedPublisherPubs) {
        if (await QuCrypto.verify(bytes, sig, QuCrypto.fromBase64Url(pub))) {
          verified = true;
          break;
        }
      }
      if (!verified) throw new Error(`loadClientModule: signature on ${url} does not match any trusted publisher`);
    }
  }

  const dataUrl = `data:text/javascript;base64,${QuCrypto.toBase64(bytes)}`;
  return import(/* @vite-ignore */ dataUrl);
}
