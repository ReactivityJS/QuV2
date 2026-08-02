/**
 * ONBOARDING — the "this browser has no identity yet" screen, shown by
 * boot() (see main.js) INSTEAD of silently auto-generating a fresh
 * identity, before the real shell/UI ever mounts. Two paths:
 *   - Create a new identity: generates a mnemonic, shows it once (the
 *     ONLY time it's ever recoverable - see @qu/identity's own doc
 *     comment on why a backup CODE exported later can't reconstruct the
 *     original words), requires an explicit "I saved it" confirmation
 *     before importing it.
 *   - Import an existing identity: paste a backup code (see
 *     QuIdentityEngine.exportSeedCode()) or scan its QR code with the
 *     camera - the cross-device transfer mechanism apps/profile's backup
 *     section also uses to CREATE that code on the source device.
 *
 * Renders directly into `document.body` (no shell chrome exists yet at
 * this point in boot()) and resolves once an identity has actually been
 * stored - see main.js's `boot()` for how the result feeds back in.
 */
import { startCamera, scanQrFromVideo } from '@qu/qr';
import { t } from './i18n.js';

const STYLE_ID = 'qu-onboarding-style';
const STYLE = `
  .qu-onboard { max-width: 32rem; margin: 3rem auto; padding: 0 1.2rem; display: flex; flex-direction: column; gap: 1rem; }
  .qu-onboard h1 { margin: 0; }
  .qu-onboard p { opacity: 0.85; line-height: 1.5; }
  .qu-onboard-choices { display: flex; flex-direction: column; gap: 0.6rem; margin-top: 0.5rem; }
  .qu-onboard-choices button { padding: 0.8rem 1rem; font-size: 1rem; border-radius: 0.5rem; border: 1px solid #8884; background: transparent; color: inherit; cursor: pointer; text-align: left; }
  .qu-onboard-choices button:hover { background: #8882; }
  .qu-onboard-mnemonic { font-family: ui-monospace, monospace; font-size: 1.05em; line-height: 1.8; background: #8881; border-radius: 0.5rem; padding: 0.8rem 1rem; word-spacing: 0.3em; }
  .qu-onboard-warning { border-left: 3px solid #d0a02a; padding-left: 0.7rem; }
  .qu-onboard-row { display: flex; gap: 0.6rem; align-items: center; flex-wrap: wrap; }
  .qu-onboard textarea { width: 100%; min-height: 4rem; font-family: ui-monospace, monospace; padding: 0.5rem; box-sizing: border-box; }
  .qu-onboard-qr { display: flex; flex-direction: column; align-items: center; gap: 0.6rem; }
  .qu-onboard-qr video { width: 100%; max-width: 20rem; border-radius: 0.5rem; }
  .qu-onboard-error { color: #c0392b; }
  .qu-onboard label { display: flex; align-items: center; gap: 0.5rem; }
  .qu-onboard button[disabled] { opacity: 0.5; cursor: not-allowed; }
`;

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  document.head.appendChild(style);
}

/**
 * @param {HTMLElement} root - Cleared and populated (typically `document.body`).
 * @param {import('@qu/identity').QuIdentityEngine} identity
 * @returns {Promise<'created'|'imported'>}
 */
export function renderOnboarding(root, identity) {
  ensureStyle();
  return new Promise((resolve) => {
    renderChoice();

    function wrap() {
      root.textContent = '';
      const el = document.createElement('div');
      el.className = 'qu-onboard';
      root.appendChild(el);
      return el;
    }

    function renderChoice() {
      const el = wrap();
      const h1 = document.createElement('h1');
      h1.textContent = t('onboarding.welcome');
      const intro = document.createElement('p');
      intro.textContent = t('onboarding.intro');
      const choices = document.createElement('div');
      choices.className = 'qu-onboard-choices';

      const createBtn = document.createElement('button');
      createBtn.type = 'button';
      createBtn.textContent = t('onboarding.createNew');
      createBtn.addEventListener('click', renderCreate);

      const importBtn = document.createElement('button');
      importBtn.type = 'button';
      importBtn.textContent = t('onboarding.importExisting');
      importBtn.addEventListener('click', renderImport);

      choices.append(createBtn, importBtn);
      el.append(h1, intro, choices);
    }

    function renderCreate() {
      const el = wrap();
      const mnemonic = identity.generateMnemonic();

      const h1 = document.createElement('h1');
      h1.textContent = t('onboarding.createNew');
      const warning = document.createElement('p');
      warning.className = 'qu-onboard-warning';
      warning.textContent = t('onboarding.mnemonicIntro');

      const box = document.createElement('div');
      box.className = 'qu-onboard-mnemonic';
      box.textContent = mnemonic;

      const copyRow = document.createElement('div');
      copyRow.className = 'qu-onboard-row';
      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.textContent = t('onboarding.copy');
      copyBtn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(mnemonic);
          copyBtn.textContent = t('onboarding.copied');
          setTimeout(() => { copyBtn.textContent = t('onboarding.copy'); }, 1500);
        } catch { /* clipboard unavailable - the visible box above is still copyable by hand */ }
      });
      copyRow.appendChild(copyBtn);

      const confirmLabel = document.createElement('label');
      const confirmCheckbox = document.createElement('input');
      confirmCheckbox.type = 'checkbox';
      const continueBtn = document.createElement('button');
      continueBtn.type = 'button';
      continueBtn.textContent = t('onboarding.continue');
      continueBtn.disabled = true;
      confirmCheckbox.addEventListener('change', () => { continueBtn.disabled = !confirmCheckbox.checked; });
      confirmLabel.append(confirmCheckbox, document.createTextNode(t('onboarding.mnemonicConfirm')));

      const backBtn = document.createElement('button');
      backBtn.type = 'button';
      backBtn.textContent = t('onboarding.back');
      backBtn.addEventListener('click', renderChoice);

      continueBtn.addEventListener('click', async () => {
        continueBtn.disabled = true;
        await identity.importMnemonic(mnemonic);
        resolve('created');
      });

      const actions = document.createElement('div');
      actions.className = 'qu-onboard-row';
      actions.append(backBtn, continueBtn);

      el.append(h1, warning, box, copyRow, confirmLabel, actions);
    }

    function renderImport() {
      const el = wrap();
      const h1 = document.createElement('h1');
      h1.textContent = t('onboarding.importExisting');
      const intro = document.createElement('p');
      intro.textContent = t('onboarding.importIntro');

      const textarea = document.createElement('textarea');
      textarea.placeholder = t('onboarding.pasteCodePlaceholder');

      const qrSlot = document.createElement('div');

      const scanBtn = document.createElement('button');
      scanBtn.type = 'button';
      scanBtn.textContent = t('onboarding.scanQr');
      let stopScan = null;
      scanBtn.addEventListener('click', async () => {
        if (stopScan) { stopScan(); stopScan = null; qrSlot.textContent = ''; scanBtn.textContent = t('onboarding.scanQr'); return; }
        qrSlot.textContent = '';
        const qrWrap = document.createElement('div');
        qrWrap.className = 'qu-onboard-qr';
        const video = document.createElement('video');
        const cancelScanBtn = document.createElement('button');
        cancelScanBtn.type = 'button';
        cancelScanBtn.textContent = t('onboarding.cancelScan');
        qrWrap.append(video, cancelScanBtn);
        qrSlot.appendChild(qrWrap);
        try {
          const stopCamera = await startCamera(video);
          const stopScanning = scanQrFromVideo(video, {
            onResult: (text) => {
              textarea.value = text;
              stopCamera();
              qrSlot.textContent = '';
              stopScan = null;
              scanBtn.textContent = t('onboarding.scanQr');
            },
          });
          stopScan = () => { stopScanning(); stopCamera(); };
          cancelScanBtn.addEventListener('click', () => { stopScan?.(); stopScan = null; qrSlot.textContent = ''; scanBtn.textContent = t('onboarding.scanQr'); });
        } catch (err) {
          const error = document.createElement('p');
          error.className = 'qu-onboard-error';
          error.textContent = t('onboarding.cameraFailed', { message: err.message });
          qrSlot.textContent = '';
          qrSlot.appendChild(error);
        }
      });

      const importBtn = document.createElement('button');
      importBtn.type = 'button';
      importBtn.textContent = t('onboarding.import');

      const backBtn = document.createElement('button');
      backBtn.type = 'button';
      backBtn.textContent = t('onboarding.back');
      backBtn.addEventListener('click', () => { stopScan?.(); renderChoice(); });

      const error = document.createElement('p');
      error.className = 'qu-onboard-error';

      importBtn.addEventListener('click', async () => {
        error.textContent = '';
        try {
          await identity.importSeedCode(textarea.value);
          stopScan?.();
          resolve('imported');
        } catch (err) {
          error.textContent = t('onboarding.importFailed', { message: err.message });
        }
      });

      const actions = document.createElement('div');
      actions.className = 'qu-onboard-row';
      actions.append(backBtn, scanBtn, importBtn);

      el.append(h1, intro, textarea, qrSlot, actions, error);
    }
  });
}
