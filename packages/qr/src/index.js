/**
 * QU QR — encode (render a string as a scannable QR code) and decode (read
 * one back from a camera stream, or from any raw RGBA pixel buffer). The
 * device-to-device transfer mechanism apps/profile's identity backup
 * section and apps/shell's onboarding screen both use: show a QR code on
 * one device, scan it on another the user physically controls.
 *
 * Thin wrappers around two small, audited third-party libraries (`qrcode`
 * for encoding, `jsqr` for decoding) rather than a hand-rolled QR
 * codec - the same reasoning @qu/identity's bip39.js gives for not
 * hand-rolling BIP-39: Reed-Solomon error correction and format/mask-
 * pattern bit-packing is exactly the kind of thing that's easy to get
 * subtly wrong and hard to notice.
 *
 * `encodeToImageData()` is deliberately DOM-free (pure pixel-buffer math)
 * so the actual encode+decode round trip is testable in Node (see
 * scripts/smoke-test.mjs) without a browser - `renderQrCode()` below is
 * just that same buffer painted onto a real `<canvas>`.
 */
import QRCode from 'qrcode';
import jsQR from 'jsqr';

const QUIET_ZONE_MODULES = 4; // modules of white border around the code - jsQR (and most scanners) need this to find the finder patterns reliably

/**
 * @param {string} text
 * @param {{scale?: number}} [options] - Pixels per QR module (default 6 -
 *   comfortably scannable at typical screen-to-camera distances).
 * @returns {{data: Uint8ClampedArray, width: number, height: number}} RGBA
 *   pixel buffer, black-on-white, includes the quiet zone.
 */
export function encodeToImageData(text, { scale = 6 } = {}) {
  const qr = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const moduleCount = qr.modules.size;
  const size = (moduleCount + QUIET_ZONE_MODULES * 2) * scale;
  const data = new Uint8ClampedArray(size * size * 4);
  data.fill(255); // white background, including the quiet zone

  for (let row = 0; row < moduleCount; row++) {
    for (let col = 0; col < moduleCount; col++) {
      if (!qr.modules.get(row, col)) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const px = (col + QUIET_ZONE_MODULES) * scale + dx;
          const py = (row + QUIET_ZONE_MODULES) * scale + dy;
          const idx = (py * size + px) * 4;
          data[idx] = 0;
          data[idx + 1] = 0;
          data[idx + 2] = 0;
          data[idx + 3] = 255;
        }
      }
    }
  }
  return { data, width: size, height: size };
}

/**
 * Renders `text` as a QR code into `container` - clears it and appends a
 * single `<canvas>`. Browser-only (touches the DOM).
 * @param {HTMLElement} container
 * @param {string} text
 * @param {{scale?: number}} [options]
 */
export function renderQrCode(container, text, { scale = 6 } = {}) {
  const { data, width, height } = encodeToImageData(text, { scale });
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').putImageData(new ImageData(data, width, height), 0, 0);
  container.textContent = '';
  container.appendChild(canvas);
}

/**
 * Decodes a QR code from a raw RGBA pixel buffer - the shared core both
 * `scanQrFromVideo()` (a live camera frame, browser-only) and
 * scripts/smoke-test.mjs (proving the encode/decode round trip without a
 * browser) use.
 * @param {Uint8ClampedArray} data
 * @param {number} width @param {number} height
 * @returns {string|null} The decoded text, or null if no QR code was found.
 */
export function decodeFromImageData(data, width, height) {
  const result = jsQR(data, width, height);
  return result?.data ?? null;
}

/**
 * Requests camera access and attaches the stream to `videoEl`, ready for
 * `scanQrFromVideo()`. Browser-only.
 * @param {HTMLVideoElement} videoEl
 * @returns {Promise<() => void>} Stop function - releases the camera.
 *   ALWAYS call it when done (successful scan, cancel, unmount), or the
 *   camera stays active / the OS recording indicator stays lit.
 */
export async function startCamera(videoEl) {
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  videoEl.srcObject = stream;
  videoEl.muted = true;
  videoEl.playsInline = true;
  await videoEl.play();
  return () => { for (const track of stream.getTracks()) track.stop(); };
}

/**
 * Polls `videoEl` (an already-playing camera stream - see `startCamera()`)
 * for a QR code, calling `onResult(text)` the first time one is found, then
 * stopping automatically. Browser-only.
 * @param {HTMLVideoElement} videoEl
 * @param {{onResult: (text: string) => void, signal?: AbortSignal, intervalMs?: number}} options
 * @returns {() => void} Stop function - also respected via `signal` if given.
 */
export function scanQrFromVideo(videoEl, { onResult, signal, intervalMs = 200 }) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const timer = setInterval(() => {
    if (!videoEl.videoWidth) return; // stream not ready yet
    canvas.width = videoEl.videoWidth;
    canvas.height = videoEl.videoHeight;
    ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
    const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const text = decodeFromImageData(frame.data, canvas.width, canvas.height);
    if (text) { stop(); onResult(text); }
  }, intervalMs);
  function stop() { clearInterval(timer); }
  signal?.addEventListener('abort', stop);
  return stop;
}
