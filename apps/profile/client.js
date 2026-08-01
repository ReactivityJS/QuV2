/**
 * PROFILE — edit this identity's own profile: alias + avatar (always
 * public - User List/Contact List need them to show anyone at all), plus
 * any number of custom fields, each individually toggled public or
 * private (see @qu/services/profile-service.js for exactly what that
 * toggle means and doesn't mean - private is "only I ever see this
 * again", not "shared with trusted contacts").
 */
import { createI18n } from '@qu/i18n';

const DICT = {
  en: {
    title: 'Profile',
    alias: 'Alias',
    avatar: 'Avatar (emoji or image URL)',
    fields: 'Custom fields',
    fieldKey: 'Field name',
    fieldValue: 'Value',
    public: 'Public',
    private: 'Private',
    addField: 'Add field',
    remove: 'Remove',
    save: 'Save',
    saved: 'Saved',
  },
  de: {
    title: 'Profil',
    alias: 'Alias',
    avatar: 'Avatar (Emoji oder Bild-URL)',
    fields: 'Eigene Felder',
    fieldKey: 'Feldname',
    fieldValue: 'Wert',
    public: 'Öffentlich',
    private: 'Privat',
    addField: 'Feld hinzufügen',
    remove: 'Entfernen',
    save: 'Speichern',
    saved: 'Gespeichert',
  },
};
const { t } = createI18n(DICT);

const STYLE_ID = 'qu-profile-style';
const STYLE = `
  .qu-profile-form { display: flex; flex-direction: column; gap: 0.8rem; max-width: 32rem; }
  .qu-profile-row { display: flex; flex-direction: column; gap: 0.2rem; }
  .qu-profile-row label { font-size: 0.85em; opacity: 0.7; }
  .qu-profile-row input { padding: 0.4rem; }
  .qu-profile-field { display: flex; gap: 0.4rem; align-items: center; }
  .qu-profile-field input[data-role="key"] { width: 9rem; }
  .qu-profile-field input[data-role="value"] { flex: 1; }
  .qu-profile-status { opacity: 0.7; font-size: 0.85em; }
`;

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  document.head.appendChild(style);
}

export function mount(container, { services }) {
  ensureStyle();
  let stopped = false;

  (async () => {
    const own = await services.profile.getOwnProfile();
    if (stopped) return;
    container.textContent = '';

    const heading = document.createElement('h1');
    heading.textContent = t('title');

    const form = document.createElement('form');
    form.className = 'qu-profile-form';

    const aliasInput = textRow(t('alias'), own.alias);
    const avatarInput = textRow(t('avatar'), own.avatar);

    const fieldsHeading = document.createElement('h2');
    fieldsHeading.textContent = t('fields');
    const fieldsEl = document.createElement('div');
    fieldsEl.className = 'qu-profile-fields';
    for (const field of own.fields) fieldsEl.appendChild(fieldRow(field));

    const addFieldBtn = document.createElement('button');
    addFieldBtn.type = 'button';
    addFieldBtn.textContent = t('addField');
    addFieldBtn.addEventListener('click', () => fieldsEl.appendChild(fieldRow({ key: '', value: '', visibility: 'public' })));

    const saveBtn = document.createElement('button');
    saveBtn.type = 'submit';
    saveBtn.textContent = t('save');

    const status = document.createElement('span');
    status.className = 'qu-profile-status';

    form.append(
      aliasInput.row, avatarInput.row,
      fieldsHeading, fieldsEl, addFieldBtn,
      saveBtn, status
    );

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fields = [...fieldsEl.querySelectorAll('.qu-profile-field')]
        .map((row) => ({
          key: row.querySelector('[data-role="key"]').value.trim(),
          value: row.querySelector('[data-role="value"]').value,
          visibility: row.querySelector('[data-role="visibility"]').value,
        }))
        .filter((f) => f.key);

      await services.profile.saveProfile({ alias: aliasInput.input.value, avatar: avatarInput.input.value, fields });
      status.textContent = t('saved');
      setTimeout(() => { status.textContent = ''; }, 1500);
    });

    container.append(heading, form);
  })();

  return () => { stopped = true; };
}

function textRow(label, value) {
  const row = document.createElement('div');
  row.className = 'qu-profile-row';
  const labelEl = document.createElement('label');
  labelEl.textContent = label;
  const input = document.createElement('input');
  input.type = 'text';
  input.value = value ?? '';
  row.append(labelEl, input);
  return { row, input };
}

function fieldRow({ key, value, visibility }) {
  const row = document.createElement('div');
  row.className = 'qu-profile-field';

  const keyInput = document.createElement('input');
  keyInput.dataset.role = 'key';
  keyInput.placeholder = t('fieldKey');
  keyInput.value = key ?? '';

  const valueInput = document.createElement('input');
  valueInput.dataset.role = 'value';
  valueInput.placeholder = t('fieldValue');
  valueInput.value = value ?? '';

  const visibilitySelect = document.createElement('select');
  visibilitySelect.dataset.role = 'visibility';
  for (const [optValue, optLabel] of [['public', t('public')], ['private', t('private')]]) {
    const option = document.createElement('option');
    option.value = optValue;
    option.textContent = optLabel;
    if (optValue === (visibility ?? 'public')) option.selected = true;
    visibilitySelect.appendChild(option);
  }

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.textContent = t('remove');
  removeBtn.addEventListener('click', () => row.remove());

  row.append(keyInput, valueInput, visibilitySelect, removeBtn);
  return row;
}
