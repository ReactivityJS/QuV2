/**
 * CHAT — Telegram/WhatsApp/Signal-style messenger: a room list (1:1 rooms
 * derived from Contacts, plus groups this identity has been invited to)
 * and a room view with message bubbles, reactions, pins, replies,
 * forwarding, attachments, voice messages, and location sharing.
 *
 * A richer room view than @qu/thread-ui's shared mountThreadView() (which
 * Forum/Inbox still use) - ported from QUniverse V1's modules/chat.js +
 * modules/presence.js (calls/WebRTC deliberately excluded per the port
 * request), then given group-chat support and reworked to match the
 * INTERACTION MODEL of ReactivityJS/Qu's own examples/chat/app.mjs (the
 * "Qu V1" messenger this was ported from originally): every message has
 * exactly ONE always-visible affordance (a "⋮" button), which opens a
 * single SHARED floating popup menu (React/Pin/Reply/Edit/Forward/Copy) -
 * not a persistent row of buttons under every bubble. Reactions themselves
 * only ever occupy screen space once at least one exists; the picker is a
 * second on-demand popup opened from the menu's "React" item. Kept OUT of
 * the shared thread-ui component on purpose - Forum/Inbox don't need this
 * much chrome, and a generic component trying to serve all three would
 * need a pile of feature flags for no real benefit.
 *
 * ENCRYPTION IS THE DEFAULT for both room kinds, not an opt-in: a 1:1 room
 * (THREAD_PRESETS.chat) and a group (THREAD_PRESETS.group) both set
 * `readers` to the fixed member list, which makes every message body AND
 * every attachment (see the `readerPubs` passed to `services.assets.upload()`
 * below) end-to-end encrypted for exactly those members - a relay operator,
 * or anyone else syncing the space, sees ciphertext only.
 *
 * GROUP MEMBERSHIP IS FIXED AT CREATION - adding/removing members would
 * mean re-keying every future message for a different reader set, which is
 * real future work, not implemented here (create a new group instead, the
 * same workaround many messengers' own encrypted-group implementations
 * reach for too).
 *
 * READ TICKS are simplified from the V1 reference's three states
 * (pending/sent/read) to two (✓ sent, ✓✓ read): this app awaits
 * `postMessage()` before ever rendering the message, so there's no
 * optimistic "still sending" window to visualize - "sent" is true the
 * instant it appears at all. "Read" is a real, separate signal:
 * `ThreadService.publishReadReceipt()` (distinct from the pre-existing
 * PRIVATE `markRead()`/`getLastReadAt()`, which only drive this
 * identity's own unread badge and are invisible to other members).
 *
 * Routes: `#/chat` (room list), `#/chat/<peerActorPub>` (1:1 room),
 * `#/chat/g/<groupId>` (group room).
 */
import { THREAD_PRESETS, ChatService, paths } from '@qu/services';
import { watch } from '@qu/reactive';
import { createI18n } from '@qu/i18n';

const SPACE = 'chat';
const REACTION_CHOICES = ['👍', '❤️', '😂', '😮', '😢', '🙏', '🔥', '✅'];
// A broad curated set, not the full Unicode emoji table (thousands of
// codepoints, no reasonable way to hand-maintain that list here and no
// emoji-picker dependency in this vanilla-JS codebase) - shown when the
// reaction popup's own "+" is clicked, for anything beyond the 8 quick
// picks above.
const EXTENDED_EMOJI_SET = [
  '😀', '😃', '😄', '😁', '😆', '😅', '🤣', '😂', '🙂', '🙃', '😉', '😊', '😇', '🥰', '😍', '🤩',
  '😘', '😗', '😚', '😙', '😋', '😛', '😜', '🤪', '😝', '🤑', '🤗', '🤭', '🤫', '🤔', '🫡', '🤐',
  '🤨', '😐', '😑', '😶', '😏', '😒', '🙄', '😬', '🤥', '😌', '😔', '😪', '🤤', '😴', '😷', '🤒',
  '🤕', '🤢', '🤮', '🤧', '🥵', '🥶', '🥴', '😵', '🤯', '🤠', '🥳', '🥸', '😎', '🤓', '🧐', '😕',
  '😟', '🙁', '☹️', '😮', '😯', '😲', '😳', '🥺', '😦', '😧', '😨', '😰', '😥', '😢', '😭', '😱',
  '😖', '😣', '😞', '😓', '😩', '😫', '🥱', '😤', '😡', '😠', '🤬', '😈', '👿', '💀', '👻', '👽',
  '🤖', '💩', '😺', '😸', '😹', '😻', '😼', '😽', '🙀', '😿', '😾', '👍', '👎', '👏', '🙌', '🤝',
  '🙏', '💪', '👋', '✌️', '🤞', '🫶', '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '💔',
  '❣️', '💕', '💞', '💓', '💗', '💖', '💘', '💝', '💯', '✅', '❌', '⭐', '🌟', '✨', '🔥', '🎉',
  '🎊', '🎈', '🎁', '🏆', '⚡', '☀️', '🌈', '☕', '🍕', '🍔', '🍎', '🍺', '🎂', '📌', '🔗', '📎',
];
const AVATAR_PALETTE = ['#e17076', '#faa774', '#a695e7', '#7bc862', '#6ec9cb', '#65aadd', '#ee7aae', '#f2c94c'];
const PRESENCE_STALE_MS = 15_000;
const PRESENCE_HEARTBEAT_MS = 5_000;
const READ_RECEIPT_POLL_MS = 4_000;

const DICT = {
  en: {
    title: 'Chats', empty: 'No chats yet — add a contact from the User List, or start a group.', back: '←',
    online: 'online', offline: 'offline', lastSeen: 'last seen {time}', membersOnline: '{count} members, {online} online',
    pinned: 'Pinned', pinnedMessage: 'Pinned message', unpin: 'Unpin', pin: 'Pin', react: 'React', reply: 'Reply',
    edit: 'Edit', forward: 'Forward', copyText: 'Copy text', copied: 'Copied',
    replyingTo: 'Replying to {name}', editingMessage: 'Edit message', forwardingFrom: 'Forward from {name}', cancel: 'Cancel',
    forwardedFrom: 'Forwarded from {name}', forwardTo: 'Forward to…', noRoomsToForward: 'No other chats yet.',
    attach: 'Attach file', removeAttachment: 'Remove attachment', download: 'Download',
    send: 'Send', composerPlaceholder: 'Message',
    newGroup: 'New group', groupName: 'Group name', selectMembers: 'Add members', create: 'Create',
    membersCount: '{count} members', you: 'You', noContacts: 'No contacts yet — add some from the User List first.',
    groupNotFound: 'This group doesn\'t exist, or you\'re not a member.', encrypted: 'Messages and files are end-to-end encrypted.',
    photo: 'Photo', video: 'Video', file: 'File', voiceMessage: '🎙️ Voice message', location: '📍 Location',
    members: 'Members', close: 'Close', more: 'More',
    recordVoice: 'Record a voice message', shareLocation: 'Share my location',
    voiceNotSupported: 'Voice messages aren\'t supported in this browser.', voiceStart: 'Start recording',
    voicePause: 'Pause', voiceResume: 'Resume', voiceStop: 'Stop', voiceSend: 'Send', voiceDiscard: 'Discard',
    locationNotSupported: 'Location sharing isn\'t supported in this browser.', locationFailed: 'Couldn\'t get your location.',
    settings: 'Chat settings', settingsBtn: 'Chat settings', showAliasIn1to1: 'Show sender name in 1:1 chats',
    ownColor: 'Your message color', save: 'Save', saved: 'Saved',
    search: 'Search', searchPlaceholder: 'Search messages…', searchAll: 'All', searchLinks: '🔗 Links', searchFiles: '📎 Files',
    searchImages: '🖼️ Images', searchVideos: '🎬 Videos', searchDateFrom: 'From', searchDateTo: 'To',
    noResults: 'No results', searchThisChat: 'Search this chat', searchEverywhere: 'Search all chats',
    synced: 'Delivered to server', pendingSync: 'Not yet delivered to server', readBy: 'Read',
    permalink: 'Click to copy a link to this message',
    resetScroll: 'Jump to newest message', moreEmoji: 'More emoji',
    clearChat: 'Clear chat', clearChatConfirm: 'Delete all messages in this chat? This cannot be undone, and clears the chat for everyone in it, not just you.',
    messageRenderError: '⚠️ This message could not be displayed.',
  },
  de: {
    title: 'Chats', empty: 'Noch keine Chats — Kontakt aus der Nutzerliste hinzufügen oder eine Gruppe starten.', back: '←',
    online: 'online', offline: 'offline', lastSeen: 'zuletzt online {time}', membersOnline: '{count} Mitglieder, {online} online',
    pinned: 'Angeheftet', pinnedMessage: 'Angeheftete Nachricht', unpin: 'Lösen', pin: 'Anheften', react: 'Reagieren', reply: 'Antworten',
    edit: 'Bearbeiten', forward: 'Weiterleiten', copyText: 'Text kopieren', copied: 'Kopiert',
    replyingTo: 'Antwort an {name}', editingMessage: 'Nachricht bearbeiten', forwardingFrom: 'Weiterleiten von {name}', cancel: 'Abbrechen',
    forwardedFrom: 'Weitergeleitet von {name}', forwardTo: 'Weiterleiten an…', noRoomsToForward: 'Noch keine weiteren Chats.',
    attach: 'Datei anhängen', removeAttachment: 'Anhang entfernen', download: 'Herunterladen',
    send: 'Senden', composerPlaceholder: 'Nachricht',
    newGroup: 'Neue Gruppe', groupName: 'Gruppenname', selectMembers: 'Mitglieder hinzufügen', create: 'Erstellen',
    membersCount: '{count} Mitglieder', you: 'Du', noContacts: 'Noch keine Kontakte — zuerst in der Nutzerliste hinzufügen.',
    groupNotFound: 'Diese Gruppe existiert nicht, oder du bist kein Mitglied.', encrypted: 'Nachrichten und Dateien sind Ende-zu-Ende-verschlüsselt.',
    photo: 'Foto', video: 'Video', file: 'Datei', voiceMessage: '🎙️ Sprachnachricht', location: '📍 Standort',
    members: 'Mitglieder', close: 'Schließen', more: 'Mehr',
    recordVoice: 'Sprachnachricht aufnehmen', shareLocation: 'Meinen Standort teilen',
    voiceNotSupported: 'Sprachnachrichten werden von diesem Browser nicht unterstützt.', voiceStart: 'Aufnahme starten',
    voicePause: 'Pause', voiceResume: 'Fortsetzen', voiceStop: 'Stopp', voiceSend: 'Senden', voiceDiscard: 'Verwerfen',
    locationNotSupported: 'Standortfreigabe wird von diesem Browser nicht unterstützt.', locationFailed: 'Standort konnte nicht ermittelt werden.',
    settings: 'Chat-Einstellungen', settingsBtn: 'Chat-Einstellungen', showAliasIn1to1: 'Absendername in 1:1-Chats anzeigen',
    ownColor: 'Farbe deiner Nachrichten', save: 'Speichern', saved: 'Gespeichert',
    search: 'Suche', searchPlaceholder: 'Nachrichten durchsuchen…', searchAll: 'Alle', searchLinks: '🔗 Links', searchFiles: '📎 Dateien',
    searchImages: '🖼️ Bilder', searchVideos: '🎬 Videos', searchDateFrom: 'Von', searchDateTo: 'Bis',
    noResults: 'Keine Treffer', searchThisChat: 'Diesen Chat durchsuchen', searchEverywhere: 'Alle Chats durchsuchen',
    synced: 'Auf dem Server gespeichert', pendingSync: 'Noch nicht auf dem Server gespeichert', readBy: 'Gelesen',
    permalink: 'Klicken, um einen Link zu dieser Nachricht zu kopieren',
    resetScroll: 'Zur neuesten Nachricht springen', moreEmoji: 'Weitere Emojis',
    clearChat: 'Chat leeren', clearChatConfirm: 'Alle Nachrichten in diesem Chat löschen? Das kann nicht rückgängig gemacht werden und leert den Chat für alle Beteiligten, nicht nur für dich.',
    messageRenderError: '⚠️ Diese Nachricht konnte nicht angezeigt werden.',
  },
};
const { t } = createI18n(DICT);

const STYLE_ID = 'qu-chat-style';
const STYLE = `
  /* This class is added directly onto the shell's own screenEl (see
     mount() below - Chat is the one app that manages its own internal
     scroll region rather than letting the whole screen scroll), which
     already carries the shell's own qu-shell-screen rule (padding +
     "this element itself scrolls" - see apps/shell/public/index.html).
     Both rules apply to the SAME element, cascading per-property, not
     per-selector - overflow/padding here are declared specifically to
     cancel those out, or the shell's own scrolling and Chat's internal
     qu-chat-messages scrolling fight over the same box (nested
     auto-scroll containers with a stale outer scrollHeight), and the
     1rem padding eats into the height budget on top of that. */
  .qu-chat-app { display: flex; flex-direction: column; height: 100%; min-height: 0; overflow: hidden; padding: 0; box-sizing: border-box; }
  .qu-chat-list-header { display: flex; align-items: center; justify-content: space-between; gap: 0.6rem; margin-bottom: 0.6rem; }
  .qu-chat-list-header h1 { margin: 0; }
  .qu-chat-header-actions { display: flex; gap: 0.4rem; }
  .qu-chat-header-actions > * { border: none; background: #3390ec; color: #fff; border-radius: 50%; width: 2.4rem; height: 2.4rem; font-size: 1.2rem; cursor: pointer; flex-shrink: 0; display: flex; align-items: center; justify-content: center; text-decoration: none; box-sizing: border-box; }
  .qu-chat-header-actions > *:hover { background: #2b7cd3; }
  .qu-chat-rooms { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
  .qu-chat-room-link { display: flex; align-items: center; gap: 0.7rem; padding: 0.5rem 0.4rem; text-decoration: none; color: inherit; border-radius: 0.5rem; }
  .qu-chat-room-link:hover { background: #8881; }
  .qu-chat-room-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 0.1rem; }
  .qu-chat-room-top { display: flex; align-items: baseline; justify-content: space-between; gap: 0.5rem; }
  .qu-chat-room-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .qu-chat-room-time { font-size: 0.75em; opacity: 0.55; flex-shrink: 0; }
  .qu-chat-room-bottom { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; }
  .qu-chat-room-preview { font-size: 0.85em; opacity: 0.65; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .qu-chat-unread-badge { background: #3390ec; color: #fff; font-size: 0.72em; border-radius: 1rem; min-width: 1.3rem; height: 1.3rem; display: flex; align-items: center; justify-content: center; padding: 0 0.35rem; flex-shrink: 0; }

  .qu-chat-avatar { flex-shrink: 0; width: 2.7rem; height: 2.7rem; border-radius: 50%; display: flex; align-items: center; justify-content: center; color: #fff; font-weight: 600; font-size: 1.05em; overflow: hidden; user-select: none; }
  .qu-chat-avatar img { width: 100%; height: 100%; object-fit: cover; }
  .qu-chat-avatar-sm { width: 1.8rem; height: 1.8rem; font-size: 0.8em; }

  .qu-chat-room-view { display: flex; flex-direction: column; height: 100%; min-height: 0; }
  .qu-chat-header { display: flex; align-items: center; gap: 0.6rem; padding-bottom: 0.5rem; border-bottom: 1px solid #8883; margin-bottom: 0.4rem; flex-shrink: 0; }
  .qu-chat-back { text-decoration: none; color: inherit; font-size: 1.3em; padding: 0 0.3rem; }
  .qu-chat-header-info { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .qu-chat-header-info button { all: unset; cursor: pointer; }
  .qu-chat-header-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .qu-chat-presence { font-size: 0.8em; opacity: 0.65; display: flex; align-items: center; gap: 0.3rem; }
  .qu-chat-presence-dot { width: 0.5rem; height: 0.5rem; border-radius: 50%; background: #888; }
  .qu-chat-presence-dot[data-online="true"] { background: #3cb371; }
  .qu-chat-encrypted-hint { font-size: 0.72em; opacity: 0.5; display: flex; align-items: center; gap: 0.25rem; flex-shrink: 0; }

  .qu-chat-members { padding: 0.5rem 0.6rem; border: 1px solid #8884; border-radius: 0.5rem; margin-bottom: 0.5rem; display: flex; flex-direction: column; gap: 0.4rem; flex-shrink: 0; }
  .qu-chat-members-row { display: flex; align-items: center; gap: 0.5rem; }
  .qu-chat-members-close { margin-left: auto; background: none; border: none; cursor: pointer; opacity: 0.6; }

  .qu-chat-pinned-bar { display: none; align-items: center; gap: 0.5rem; padding: 0.4rem 0.6rem; border-radius: 0.5rem; background: #3390ec14; border: 1px solid #3390ec33; margin-bottom: 0.4rem; flex-shrink: 0; }
  .qu-chat-pinned-bar[data-visible="true"] { display: flex; }
  .qu-chat-pinned-jump { all: unset; cursor: pointer; flex: 1; min-width: 0; display: flex; align-items: center; gap: 0.4rem; }
  .qu-chat-pinned-jump-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 0.85em; }
  .qu-chat-pinned-count { all: unset; cursor: pointer; flex-shrink: 0; font-size: 0.78em; opacity: 0.7; padding: 0.1rem 0.4rem; border: 1px solid #8886; border-radius: 999px; }

  .qu-chat-messages { list-style: none; margin: 0; padding: 0.3rem 0; display: flex; flex-direction: column; gap: 0.5rem; flex: 1; min-height: 0; overflow-y: auto; scroll-behavior: smooth; }
  .qu-chat-msg-row { display: flex; flex-direction: column; max-width: min(32rem, 82%); }
  .qu-chat-msg-row[data-mine="true"] { align-self: flex-end; }
  .qu-chat-msg-row[data-mine="false"] { align-self: flex-start; }
  .qu-chat-msg-row-error { padding: 0.4rem 0.7rem; border-radius: 0.9rem; background: #c003; opacity: 0.8; font-size: 0.85em; align-self: center; }

  /* OUTER "bubble" - a subtle card holding the chrome (optional alias
     header, footer with reactions/time/read-tick/menu). Deliberately much
     less visually prominent than the INNER message bubble below, so the
     actual content stays what draws the eye - the outer card just gives
     header/footer somewhere to live without floating in empty space. */
  .qu-chat-msg-outer { display: flex; flex-direction: column; gap: 0.15rem; background: #8881; border-radius: 1.1rem; padding: 0.3rem 0.5rem; }
  .qu-chat-msg-header { display: flex; align-items: center; gap: 0.4rem; font-size: 0.74em; opacity: 0.65; padding: 0.1rem 0.3rem 0; }
  .qu-chat-msg-author { font-weight: 600; color: #3390ec; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  /* INNER bubble - the actual message, visually offset from the outer card by its own stronger background/color. */
  .qu-chat-message { padding: 0.45rem 0.7rem; border-radius: 0.9rem; background: canvas; }
  .qu-chat-msg-row[data-mine="true"] .qu-chat-message { background: var(--qu-chat-own-color, #3390ec); color: #fff; }
  .qu-chat-reply-quote, .qu-chat-forward-note { font-size: 0.8em; opacity: 0.8; border-left: 2px solid currentColor; padding-left: 0.4rem; margin-bottom: 0.3rem; cursor: pointer; }
  .qu-chat-forward-note { cursor: default; opacity: 0.65; }
  .qu-chat-quote-author { font-weight: 600; }
  .qu-chat-body { white-space: pre-wrap; overflow-wrap: break-word; }
  .qu-chat-body a { color: inherit; text-decoration: underline; }
  .qu-chat-link-preview { display: block; margin-top: 0.4rem; padding: 0.4rem 0.6rem; border-radius: 0.6rem; background: #0002; text-decoration: none; color: inherit; }
  .qu-chat-msg-row[data-mine="true"] .qu-chat-link-preview { background: #fff2; }
  .qu-chat-link-preview-host { font-size: 0.72em; opacity: 0.75; text-transform: uppercase; letter-spacing: 0.02em; }
  .qu-chat-link-preview-title { font-size: 0.88em; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .qu-chat-attachment img, .qu-chat-attachment video { max-width: 100%; max-height: 18rem; border-radius: 0.6rem; margin-top: 0.3rem; display: block; cursor: pointer; }
  .qu-chat-attachment audio { margin-top: 0.3rem; max-width: 16rem; }
  .qu-chat-attachment a { display: inline-flex; align-items: center; gap: 0.3rem; margin-top: 0.3rem; color: inherit; }
  .qu-chat-voice-label { font-size: 0.8em; opacity: 0.8; margin-top: 0.2rem; }
  .qu-chat-location { display: flex; align-items: center; gap: 0.6rem; text-decoration: none; color: inherit; }
  .qu-chat-location img { width: 4.5rem; height: 4.5rem; border-radius: 0.5rem; object-fit: cover; flex-shrink: 0; background: #8882; }
  .qu-chat-location-coords { font-size: 0.72em; opacity: 0.7; }

  /* FOOTER: reactions bottom-left, time/read-tick/pin/menu bottom-right - matches how most messengers place these, and gives the "⋮" menu company instead of floating alone at the top when there's no alias header shown. */
  .qu-chat-msg-footer { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; padding: 0 0.2rem; min-height: 1.3rem; }
  .qu-chat-reactions { display: flex; flex-wrap: wrap; gap: 0.25rem; }
  .qu-chat-reaction-chip { border: 1px solid #8886; border-radius: 999px; padding: 0.05rem 0.45rem; font-size: 0.82em; cursor: pointer; background: #8881; }
  .qu-chat-reaction-chip[data-mine="true"] { border-color: var(--qu-chat-own-color, #3390ec); background: color-mix(in srgb, var(--qu-chat-own-color, #3390ec) 20%, transparent); }
  .qu-chat-msg-meta { display: flex; align-items: center; gap: 0.35rem; font-size: 0.68em; opacity: 0.65; margin-left: auto; }
  .qu-chat-msg-pin-badge { flex-shrink: 0; }
  .qu-chat-msg-time { all: unset; cursor: pointer; font: inherit; opacity: 1; }
  .qu-chat-msg-time:hover { text-decoration: underline; }
  .qu-chat-tick { display: inline-flex; align-items: center; gap: 0.1rem; }
  .qu-chat-tick[data-state="read"] { opacity: 1; color: var(--qu-chat-own-color, #3390ec); }
  .qu-chat-tick-spinner { display: inline-block; animation: qu-chat-spin 1s linear infinite; font-size: 0.9em; }
  @keyframes qu-chat-spin { to { transform: rotate(360deg); } }
  .qu-chat-msg-actions-btn { all: unset; cursor: pointer; padding: 0 0.2rem; opacity: 0.7; line-height: 1; }
  .qu-chat-msg-actions-btn:hover { opacity: 1; }
  .qu-chat-msg-quick-react-btn { all: unset; cursor: pointer; padding: 0 0.2rem; opacity: 0.55; line-height: 1; font-size: 0.95em; }
  .qu-chat-msg-quick-react-btn:hover { opacity: 1; }
  .qu-chat-msg-row[data-anchored="true"] .qu-chat-msg-outer { animation: qu-chat-anchor-flash 1.6s ease; }
  @keyframes qu-chat-anchor-flash { 0%, 100% { background: #8881; } 30% { background: color-mix(in srgb, var(--qu-chat-own-color, #3390ec) 35%, transparent); } }

  .qu-chat-popup { position: fixed; z-index: 60; background: canvas; color: canvastext; border: 1px solid #8884; border-radius: 0.7rem; padding: 0.3rem; min-width: 11rem; box-shadow: 0 4px 16px #00000050; }
  .qu-chat-popup-item { all: unset; display: block; width: 100%; box-sizing: border-box; padding: 0.5rem 0.6rem; border-radius: 0.5rem; cursor: pointer; font-size: 0.9em; }
  .qu-chat-popup-item:hover { background: #8882; }
  .qu-chat-reaction-popup { position: fixed; z-index: 60; background: canvas; border: 1px solid #8884; border-radius: 999px; padding: 0.3rem; gap: 0.15rem; box-shadow: 0 4px 16px #00000050; }
  /* display split out into its own :not([hidden]) rule (not folded into
     the base rule above) - this popup, like the lightbox further down, is
     appended to document.body, OUTSIDE .qu-chat-app's own subtree, so the
     blanket ".qu-chat-app [hidden]" rule below never reaches it; an
     unconditional "display" here would otherwise always beat the
     browser's built-in "[hidden] { display: none }" purely by appearing
     later in this stylesheet, regardless of the element's actual .hidden
     state - see that rule's own doc comment for the full explanation of
     this bug class. */
  .qu-chat-reaction-popup:not([hidden]) { display: flex; }
  .qu-chat-reaction-popup button { all: unset; cursor: pointer; font-size: 1.3rem; line-height: 1; padding: 0.25rem; border-radius: 50%; }
  .qu-chat-reaction-popup button:hover { background: #8882; }
  .qu-chat-reaction-more-btn { font-weight: 700; opacity: 0.7; }
  /* Extended (the "+" was clicked): the full curated emoji grid doesn't
     fit a single-row pill anymore - switch to a wrapping, scrollable
     panel instead of the compact one-line strip. */
  .qu-chat-reaction-popup-extended { flex-wrap: wrap; border-radius: 0.8rem; width: min(18rem, 90vw); max-height: min(16rem, 60vh); overflow-y: auto; }
  .qu-chat-reaction-popup-extended button { font-size: 1.15rem; }
  .qu-chat-pin-list-popup { position: fixed; z-index: 60; width: min(20rem, 90vw); max-height: min(24rem, 70vh); overflow-y: auto; background: canvas; border: 1px solid #8884; border-radius: 0.6rem; box-shadow: 0 4px 16px #00000050; padding: 0.3rem; }
  .qu-chat-pin-list-row { display: flex; align-items: center; gap: 0.5rem; padding: 0.4rem 0.5rem; border-radius: 0.4rem; }
  .qu-chat-pin-list-row:hover { background: #8882; }
  .qu-chat-pin-list-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 0.85em; cursor: pointer; }
  .qu-chat-pin-list-unpin { all: unset; cursor: pointer; opacity: 0.6; padding: 0.1rem 0.3rem; }

  .qu-chat-forward-modal-backdrop { position: fixed; inset: 0; background: #00000060; z-index: 70; display: flex; align-items: center; justify-content: center; }
  .qu-chat-forward-modal { background: canvas; color: canvastext; border-radius: 0.7rem; width: min(24rem, 92vw); max-height: 80vh; display: flex; flex-direction: column; padding: 0.8rem; gap: 0.5rem; box-shadow: 0 8px 30px #00000060; }
  .qu-chat-forward-modal h2 { margin: 0; font-size: 1.05em; }
  .qu-chat-forward-list { list-style: none; margin: 0; padding: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 0.2rem; }
  .qu-chat-forward-room-btn { all: unset; display: flex; align-items: center; gap: 0.6rem; padding: 0.5rem; border-radius: 0.5rem; cursor: pointer; width: 100%; box-sizing: border-box; }
  .qu-chat-forward-room-btn:hover { background: #8882; }
  .qu-chat-forward-close { align-self: flex-end; background: none; border: 1px solid #8884; border-radius: 0.4rem; cursor: pointer; padding: 0.3rem 0.7rem; }

  .qu-chat-reply-banner { display: flex; align-items: center; gap: 0.5rem; font-size: 0.85em; opacity: 0.85; padding: 0.35rem 0.6rem; border-radius: 0.5rem; background: #8882; margin-bottom: 0.4rem; flex-shrink: 0; }
  .qu-chat-reply-banner-body { flex: 1; min-width: 0; }
  .qu-chat-reply-banner-label { font-weight: 600; display: block; }
  .qu-chat-reply-banner-text { opacity: 0.75; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: block; }
  .qu-chat-reply-banner button { background: none; border: none; cursor: pointer; opacity: 0.6; flex-shrink: 0; }

  .qu-chat-composer { display: flex; gap: 0.4rem; align-items: center; padding-top: 0.4rem; flex-shrink: 0; position: sticky; bottom: 0; background: canvas; }
  .qu-chat-composer textarea { flex: 1; resize: none; max-height: 7rem; font: inherit; padding: 0.55rem 0.9rem; border-radius: 1.3rem; border: 1px solid #8884; background: transparent; color: inherit; }
  .qu-chat-icon-btn, .qu-chat-send-btn { border: none; background: #8882; border-radius: 50%; width: 2.4rem; height: 2.4rem; flex-shrink: 0; cursor: pointer; font-size: 1.1em; display: flex; align-items: center; justify-content: center; text-decoration: none; color: inherit; box-sizing: border-box; }
  .qu-chat-send-btn { background: #3390ec; color: #fff; }
  .qu-chat-send-btn:hover { background: #2b7cd3; }
  .qu-chat-pending-attachment { font-size: 0.8em; opacity: 0.8; display: flex; align-items: center; gap: 0.4rem; margin-bottom: 0.3rem; flex-shrink: 0; }

  .qu-chat-voice-bar { display: flex; align-items: center; gap: 0.6rem; padding: 0.4rem 0; flex-shrink: 0; position: sticky; bottom: 0; background: canvas; }
  .qu-chat-voice-status { display: flex; align-items: center; gap: 0.4rem; flex: 1; font-variant-numeric: tabular-nums; }
  .qu-chat-voice-dot { width: 0.6rem; height: 0.6rem; border-radius: 50%; background: #8886; }
  .qu-chat-voice-status[data-recording="true"] .qu-chat-voice-dot { background: #e5484d; animation: qu-chat-voice-pulse 1.2s ease-in-out infinite; }
  @keyframes qu-chat-voice-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }
  .qu-chat-voice-bar audio { flex: 1; max-width: 14rem; }

  .qu-chat-new-group { border: 1px solid #8884; border-radius: 0.6rem; padding: 0.7rem; margin-bottom: 0.7rem; display: flex; flex-direction: column; gap: 0.6rem; }
  .qu-chat-new-group input[type="text"] { padding: 0.5rem 0.7rem; border-radius: 0.5rem; border: 1px solid #8884; background: transparent; color: inherit; font: inherit; }
  .qu-chat-member-picker { display: flex; flex-direction: column; gap: 0.3rem; max-height: 12rem; overflow-y: auto; }
  .qu-chat-member-picker label { display: flex; align-items: center; gap: 0.5rem; }
  .qu-chat-new-group-actions { display: flex; gap: 0.5rem; justify-content: flex-end; }

  .qu-chat-settings-form { display: flex; flex-direction: column; gap: 0.9rem; max-width: 24rem; margin-top: 0.6rem; }
  .qu-chat-settings-row { display: flex; align-items: center; gap: 0.6rem; justify-content: space-between; }
  .qu-chat-settings-row input[type="color"] { width: 2.6rem; height: 1.8rem; padding: 0; border: 1px solid #8884; border-radius: 0.3rem; background: none; cursor: pointer; }
  .qu-chat-settings-status { font-size: 0.85em; opacity: 0.7; }

  .qu-chat-search { display: flex; flex-direction: column; gap: 0.5rem; height: 100%; min-height: 0; }
  .qu-chat-search h1 { margin: 0; font-size: 1.1em; }
  .qu-chat-search-input { padding: 0.5rem 0.8rem; border-radius: 1.2rem; border: 1px solid #8884; background: transparent; color: inherit; font: inherit; }
  .qu-chat-search-date-row { display: flex; gap: 0.8rem; flex-wrap: wrap; font-size: 0.85em; }
  .qu-chat-search-date-row label { display: flex; align-items: center; gap: 0.3rem; opacity: 0.8; }
  .qu-chat-search-date-row input[type="date"] { padding: 0.25rem 0.4rem; border-radius: 0.4rem; border: 1px solid #8884; background: transparent; color: inherit; font: inherit; }
  .qu-chat-search-filters { display: flex; gap: 0.4rem; flex-wrap: wrap; }
  .qu-chat-search-filter-btn { border: 1px solid #8884; background: none; color: inherit; border-radius: 999px; padding: 0.25rem 0.7rem; font-size: 0.85em; cursor: pointer; }
  .qu-chat-search-filter-btn[data-active="true"] { background: #3390ec; border-color: #3390ec; color: #fff; }
  .qu-chat-search-results { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.3rem; overflow-y: auto; flex: 1; min-height: 0; }
  .qu-chat-search-result a { display: block; text-decoration: none; color: inherit; padding: 0.5rem 0.6rem; border-radius: 0.5rem; border: 1px solid #8884; }
  .qu-chat-search-result a:hover { background: #8881; }
  .qu-chat-search-result-room { font-weight: 600; font-size: 0.85em; opacity: 0.8; }
  .qu-chat-search-result-time { font-size: 0.72em; opacity: 0.6; margin-top: 0.2rem; }
  .qu-chat-search-empty { opacity: 0.6; padding: 0.5rem; }

  .qu-chat-lightbox { position: fixed; inset: 0; background: #000000e6; z-index: 100; align-items: center; justify-content: center; touch-action: none; overflow: hidden; }
  .qu-chat-lightbox:not([hidden]) { display: flex; }
  .qu-chat-lightbox img { max-width: 100vw; max-height: 100vh; cursor: zoom-in; user-select: none; transition: transform 0.15s ease; }
  .qu-chat-lightbox img.qu-chat-lightbox-zoomed { cursor: zoom-out; transform: scale(2.2); }
  .qu-chat-lightbox-close { position: absolute; top: max(0.8rem, env(safe-area-inset-top)); right: 0.8rem; background: #ffffff20; border: none; color: #fff; width: 2.4rem; height: 2.4rem; border-radius: 50%; font-size: 1.3rem; cursor: pointer; }

  /* MUST be last (or otherwise win on specificity/source-order) and !important:
     several selectors above set an unconditional "display" (flex/block) on
     elements this file ALSO toggles via the DOM \`hidden\` property/attribute
     - the browser's own built-in "[hidden] { display: none }" rule has the
     SAME specificity as a plain class selector, so whichever was defined
     LATER in the cascade wins; every one of those "display: flex" rules
     above was quietly overriding "[hidden]" and leaving the element visibly
     on screen (with real layout space) even while \`el.hidden = true\` was
     set - the reply banner, pending-attachment preview, voice recorder bar,
     member list, and even the composer itself were all affected. Real,
     confirmed bugs this fixes: the pending-attachment preview staying stuck
     on screen after a message was sent, and the voice recorder appearing
     ALONGSIDE the (never actually hidden) composer instead of replacing it,
     pushing the layout down and requiring a scroll to reach it. One
     high-specificity, always-last rule closes the whole class of bug at
     once, for every current AND future element in this file - simpler and
     more robust than hunting down and patching each selector individually. */
  .qu-chat-app [hidden] { display: none !important; }
`;

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  document.head.appendChild(style);
}

function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function fmtTime(ts) {
  if (!ts) return '';
  const date = new Date(ts);
  const sameDay = date.toDateString() === new Date().toDateString();
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return time;
  const day = date.toLocaleDateString([], { day: '2-digit', month: '2-digit' });
  return `${day} ${time}`;
}

function colorFor(seed) {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_PALETTE[hash % AVATAR_PALETTE.length];
}

function initialsOf(name) {
  return (name || '?').trim().slice(0, 1).toUpperCase();
}

/** @param {string} seed - Stable identity for color (a pub, or a groupId). @param {string} label - Display name/alias to derive initials from. @param {string|null} [avatarValue] - Profile `avatar` field: an emoji/short string, or an image URL. */
function renderAvatar(seed, label, avatarValue, { small = false } = {}) {
  const el = document.createElement('div');
  el.className = small ? 'qu-chat-avatar qu-chat-avatar-sm' : 'qu-chat-avatar';
  el.style.background = colorFor(seed);
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

function attachmentPreviewLabel(attachment) {
  if (!attachment) return '';
  if (isVoiceMessageFilename(attachment.name)) return t('voiceMessage');
  if (attachment.mime?.startsWith('image/')) return `📷 ${t('photo')}`;
  if (attachment.mime?.startsWith('video/')) return `🎥 ${t('video')}`;
  if (attachment.mime?.startsWith('audio/')) return t('voiceMessage');
  return `📎 ${t('file')}`;
}

// ============================================================================
// LOCATION SHARING — a shared location is deliberately NOT a special message
// type. It's a plain text message whose body happens to be a recognized map
// URL (see parseLocationFromUrl()) - the same trick ReactivityJS/Qu's own
// chat-lib.mjs uses. Rendering recognizes the URL shape and shows a static
// OSM tile + coordinates instead of the raw link. No API key, no third-party
// static-map service - a single 256x256 tile fetched directly from
// tile.openstreetmap.org using the standard slippy-map tile math.
// ============================================================================

function buildLocationUrl(lat, lng) {
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=16/${lat}/${lng}`;
}

/** @param {string} text @returns {{lat: number, lng: number}|null} */
function parseLocationFromUrl(text) {
  const osm = text.match(/openstreetmap\.org\/\?mlat=(-?[\d.]+)&mlon=(-?[\d.]+)/);
  if (osm) return { lat: parseFloat(osm[1]), lng: parseFloat(osm[2]) };
  const google = text.match(/google\.com\/maps\/search\/\?api=1&query=(-?[\d.]+),(-?[\d.]+)/);
  if (google) return { lat: parseFloat(google[1]), lng: parseFloat(google[2]) };
  return null;
}

function staticMapTileUrl(lat, lng, zoom = 15) {
  const n = 2 ** zoom;
  const x = Math.floor(((lng + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
  return `https://tile.openstreetmap.org/${zoom}/${x}/${y}.png`;
}

// ============================================================================
// VOICE MESSAGES — an ordinary attachment (same encrypted upload path as an
// image/video), distinguished purely by filename convention so playback can
// label it "🎙️ Voice message" instead of a generic file - no separate
// message-type field needed.
// ============================================================================

function voiceMessageFilename(ts) {
  return `voice-message-${ts}.webm`;
}

function isVoiceMessageFilename(name) {
  return typeof name === 'string' && /^voice-message-\d+\.\w+$/.test(name);
}

/** Shared floating-popup positioning: docks below the anchor, flips above if it would overflow the viewport bottom, clamps horizontally. */
function positionPopup(popupEl, anchorRect) {
  const popupRect = popupEl.getBoundingClientRect();
  let top = anchorRect.bottom + 4;
  if (top + popupRect.height > window.innerHeight) top = Math.max(4, anchorRect.top - popupRect.height - 4);
  let left = anchorRect.left;
  if (left + popupRect.width > window.innerWidth) left = window.innerWidth - popupRect.width - 4;
  popupEl.style.top = `${top}px`;
  popupEl.style.left = `${Math.max(4, left)}px`;
}

// ============================================================================
// CHAT SETTINGS — device-level UI preferences (which alias to show, own
// bubble color), same "not shared/synced data" reasoning as @qu/i18n's own
// getStoredLocale()/setLocale(): these are about how THIS session renders
// chat, not data other members need to see, so plain localStorage is
// enough - no identity/encryption plumbing needed. Alias visibility
// defaults OFF for 1:1 (the room header already names the other person;
// WhatsApp/Signal/Telegram don't repeat it per-bubble either) and is
// always ON for groups regardless of this setting (there IS no other way
// to tell senders apart there) - see messageRow()'s own header-visibility
// check.
// ============================================================================
const SETTINGS_KEY = 'qu-chat-settings';
const DEFAULT_OWN_COLOR = '#3390ec';

function getChatSettings() {
  try {
    return { showAliasIn1to1: false, ownColor: DEFAULT_OWN_COLOR, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') };
  } catch {
    return { showAliasIn1to1: false, ownColor: DEFAULT_OWN_COLOR };
  }
}

function setChatSettings(patch) {
  const next = { ...getChatSettings(), ...patch };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  return next;
}

// ============================================================================
// LINKS — detection matches ReactivityJS/Qu's own chat-lib.mjs: a plain
// regex scan, no fetched preview (no OpenGraph/oEmbed) beyond the
// location special-case above, which already fetches a raw OSTM tile
// image directly (a plain <img src>, no CORS/CSP concern since images
// don't need CORS to display) - deliberately NOT doing a cross-origin
// fetch() of arbitrary third-party HTML for metadata, which would need
// either relay-side proxying or fighting CSP for no real benefit here.
// ============================================================================
const URL_RE = /(https?:\/\/[^\s<>"]+)/gi;

/** @param {string} text @returns {Array<{type:'text'|'link', value:string, hostname?:string}>} */
function linkifySegments(text) {
  const segments = [];
  let lastIndex = 0;
  for (const match of text.matchAll(URL_RE)) {
    const url = match[0];
    const index = match.index;
    if (index > lastIndex) segments.push({ type: 'text', value: text.slice(lastIndex, index) });
    let hostname = url;
    try { hostname = new URL(url).hostname; } catch { /* not a real URL - fall back to showing it verbatim */ }
    segments.push({ type: 'link', value: url, hostname });
    lastIndex = index + url.length;
  }
  if (lastIndex < text.length) segments.push({ type: 'text', value: text.slice(lastIndex) });
  return segments;
}

/** Renders `text` as a text node with any http(s) URLs turned into real, clickable, new-tab anchors - used instead of a plain textContent assignment wherever message bodies are shown. */
function renderLinkedText(container, text) {
  for (const seg of linkifySegments(text)) {
    if (seg.type === 'text') { container.appendChild(document.createTextNode(seg.value)); continue; }
    const a = document.createElement('a');
    a.href = seg.value;
    a.textContent = seg.value;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.addEventListener('click', (e) => e.stopPropagation());
    container.appendChild(a);
  }
}

/** @returns {HTMLElement|null} A compact hostname+URL preview card for the FIRST link in `text` (skipped if it's a location URL, which already gets its own richer map-tile preview - see locationBlock()). */
function buildLinkPreview(text) {
  const link = linkifySegments(text).find((seg) => seg.type === 'link');
  if (!link || parseLocationFromUrl(link.value)) return null;
  const a = document.createElement('a');
  a.className = 'qu-chat-link-preview';
  a.href = link.value;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.addEventListener('click', (e) => e.stopPropagation());
  const host = document.createElement('div');
  host.className = 'qu-chat-link-preview-host';
  host.textContent = `🔗 ${link.hostname}`;
  const title = document.createElement('div');
  title.className = 'qu-chat-link-preview-title';
  title.textContent = link.value;
  a.append(host, title);
  return a;
}

export function mount(container, { qu, services, segments, subscribe, fetch: syncFetch }) {
  ensureStyle();
  let stopped = false;
  let unwatch = null;
  let unwatchPins = null;
  const reactionUnwatches = new Map(); // messageId -> unwatch(), see reload()'s watchReactions() below
  let stopHeartbeat = null;
  let presenceTimer = null;
  let readReceiptTimer = null;
  const roomCleanups = []; // per-renderRoom() teardown (shared popups, document click listener) - see cleanupRoom() below

  container.classList.add('qu-chat-app');

  // See apps/forum/client.js's identical call for why this is needed - the
  // shell's own default subscriptions don't cover this app's space. Two
  // separate subscriptions, not one: an attachment's binary CHUNKS live
  // under the `blob` mount (`/blob/<space>/...`, see @qu/engines'
  // AssetEngine and its `toBlobPath()`), a completely different top-level
  // prefix from the message/metadata documents under `/store/<space>/...`.
  subscribe(`/store/${SPACE}`);
  subscribe(`/blob/${SPACE}`);

  // Routes: #/chat, #/chat/settings, #/chat/search, #/chat/search/<pub>,
  // #/chat/search/g/<id>, #/chat/g/<id>[/m/<msgId>], #/chat/<pub>[/m/<msgId>].
  const isSearchRoute = segments[1] === 'search';
  const searchIsGroup = isSearchRoute && segments[2] === 'g';
  const searchGroupId = searchIsGroup ? (segments[3] ?? null) : null;
  const searchPeerActorPub = isSearchRoute && !searchIsGroup ? (segments[2] ?? null) : null;
  const isGroupRoute = !isSearchRoute && segments[1] === 'g';
  const groupId = isGroupRoute ? (segments[2] ?? null) : null;
  const peerActorPub = !isSearchRoute && !isGroupRoute && segments[1] !== 'settings' ? (segments[1] ?? null) : null;
  const anchorMessageId = isGroupRoute ? (segments[3] === 'm' ? segments[4] ?? null : null) : (peerActorPub ? (segments[2] === 'm' ? segments[3] ?? null : null) : null);

  (async () => {
    const myActorPub = await services.actors.whoAmI();
    if (stopped) return;

    // Group invites arrive here (see @qu/services' ChatService) - subscribed
    // unconditionally, not just on the room-list route, so a group room
    // opened directly via a shared groupId still gets live invite traffic
    // (e.g. this identity's OWN createGroup() call, from another tab).
    const inviteSpace = await services.chat.myInviteSpace();
    if (stopped) return;
    subscribe(`/store/${inviteSpace}`);

    if (segments[1] === 'settings') await renderSettings();
    else if (searchGroupId) await renderChatSearchPage(myActorPub, { type: 'group', groupId: searchGroupId });
    else if (searchPeerActorPub) await renderChatSearchPage(myActorPub, { type: 'direct', peerActorPub: searchPeerActorPub });
    else if (isSearchRoute) await renderGlobalSearch(myActorPub);
    else if (groupId) await renderRoom(myActorPub, { type: 'group', groupId, anchorMessageId });
    else if (peerActorPub) await renderRoom(myActorPub, { type: 'direct', peerActorPub, anchorMessageId });
    else await renderRoomList(myActorPub);
  })();

  async function renderRoomList(myActorPub) {
    if (stopped) return;
    container.textContent = '';

    const header = document.createElement('div');
    header.className = 'qu-chat-list-header';
    const heading = document.createElement('h1');
    heading.textContent = t('title');
    const headerActions = document.createElement('div');
    headerActions.className = 'qu-chat-header-actions';
    const searchBtn = document.createElement('a');
    searchBtn.className = 'qu-chat-search-header-btn';
    searchBtn.href = '#/chat/search';
    searchBtn.title = t('search');
    searchBtn.textContent = '🔍';
    const settingsBtn = document.createElement('a');
    settingsBtn.className = 'qu-chat-settings-header-btn';
    settingsBtn.href = '#/chat/settings';
    settingsBtn.title = t('settingsBtn');
    settingsBtn.textContent = '⚙️';
    const newGroupBtn = document.createElement('button');
    newGroupBtn.type = 'button';
    newGroupBtn.className = 'qu-chat-new-group-btn';
    newGroupBtn.textContent = '+';
    newGroupBtn.title = t('newGroup');
    headerActions.append(searchBtn, settingsBtn, newGroupBtn);
    header.append(heading, headerActions);
    container.appendChild(header);

    const formSlot = document.createElement('div');
    container.appendChild(formSlot);
    newGroupBtn.addEventListener('click', () => renderNewGroupForm(formSlot, myActorPub));

    const [contacts, groupIds] = await Promise.all([services.contacts.listContacts(), services.chat.listMyGroups()]);
    if (stopped) return;

    const rooms = [];
    for (const { actorPub, profile } of contacts) {
      const id = await ChatService.roomId([myActorPub, actorPub]);
      rooms.push({ type: 'direct', href: `#/chat/${actorPub}`, seed: actorPub, name: profile?.alias || `~${actorPub.slice(0, 10)}…`, avatar: profile?.avatar ?? null, spaceId: SPACE, threadId: id });
    }
    for (const id of groupIds) {
      const config = await services.threads.getConfig(SPACE, id);
      if (!config) continue; // invited, but the group's own config hasn't synced to this session yet
      rooms.push({ type: 'group', href: `#/chat/g/${id}`, seed: id, name: config.name || id, avatar: '👥', spaceId: SPACE, threadId: id });
    }
    if (stopped) return;

    if (rooms.length === 0) {
      const empty = document.createElement('p');
      empty.textContent = t('empty');
      container.appendChild(empty);
      return;
    }

    // Enrich with last message + unread count, then sort newest-activity-first.
    await Promise.all(rooms.map(async (room) => {
      const [messages, lastReadAt] = await Promise.all([
        services.threads.listMessages(room.spaceId, room.threadId),
        services.threads.getLastReadAt(room.spaceId, room.threadId),
      ]);
      const last = messages[messages.length - 1] ?? null;
      room.lastTs = last?.ts ?? 0;
      room.previewText = last ? (last.body?.trim() || attachmentPreviewLabel(last.attachment)) : '';
      room.unread = messages.filter((m) => (m.ts ?? 0) > lastReadAt && m.author !== myActorPub).length;
    }));
    if (stopped) return;
    rooms.sort((a, b) => b.lastTs - a.lastTs);

    const list = document.createElement('ul');
    list.className = 'qu-chat-rooms';
    for (const room of rooms) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.className = 'qu-chat-room-link';
      a.href = room.href;
      a.append(renderAvatar(room.seed, room.name, room.avatar));

      const main = document.createElement('div');
      main.className = 'qu-chat-room-main';
      const top = document.createElement('div');
      top.className = 'qu-chat-room-top';
      const name = document.createElement('span');
      name.className = 'qu-chat-room-name';
      name.textContent = room.name;
      top.appendChild(name);
      if (room.lastTs) {
        const time = document.createElement('span');
        time.className = 'qu-chat-room-time';
        time.textContent = fmtTime(room.lastTs);
        top.appendChild(time);
      }
      const bottom = document.createElement('div');
      bottom.className = 'qu-chat-room-bottom';
      const preview = document.createElement('span');
      preview.className = 'qu-chat-room-preview';
      preview.textContent = room.previewText;
      bottom.appendChild(preview);
      if (room.unread > 0) {
        const badge = document.createElement('span');
        badge.className = 'qu-chat-unread-badge';
        badge.textContent = String(room.unread);
        bottom.appendChild(badge);
      }
      main.append(top, bottom);
      a.appendChild(main);
      li.appendChild(a);
      list.appendChild(li);
    }
    container.appendChild(list);
  }

  async function renderNewGroupForm(slot, myActorPub) {
    slot.textContent = '';
    const contacts = await services.contacts.listContacts();
    if (stopped) return;

    const form = document.createElement('form');
    form.className = 'qu-chat-new-group';

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.placeholder = t('groupName');
    nameInput.required = true;
    form.appendChild(nameInput);

    if (contacts.length === 0) {
      const note = document.createElement('p');
      note.textContent = t('noContacts');
      form.appendChild(note);
    } else {
      const label = document.createElement('div');
      label.textContent = t('selectMembers');
      form.appendChild(label);
      const picker = document.createElement('div');
      picker.className = 'qu-chat-member-picker';
      for (const { actorPub, profile } of contacts) {
        const row = document.createElement('label');
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.value = actorPub;
        const span = document.createElement('span');
        span.textContent = profile?.alias || `~${actorPub.slice(0, 10)}…`;
        row.append(checkbox, span);
        picker.appendChild(row);
      }
      form.appendChild(picker);
    }

    const actions = document.createElement('div');
    actions.className = 'qu-chat-new-group-actions';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.textContent = t('cancel');
    cancelBtn.addEventListener('click', () => { slot.textContent = ''; });
    const createBtn = document.createElement('button');
    createBtn.type = 'submit';
    createBtn.textContent = t('create');
    actions.append(cancelBtn, createBtn);
    form.appendChild(actions);

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const name = nameInput.value.trim();
      if (!name) return;
      const memberPubs = [...form.querySelectorAll('input[type="checkbox"]:checked')].map((el) => el.value);
      createBtn.disabled = true;
      const { groupId: newGroupId } = await services.chat.createGroup({ name, memberPubs });
      location.hash = `#/chat/g/${newGroupId}`;
    });

    slot.appendChild(form);
  }

  async function renderSettings() {
    if (stopped) return;
    container.textContent = '';
    const back = document.createElement('a');
    back.className = 'qu-chat-back';
    back.href = '#/chat';
    back.textContent = t('back');
    const heading = document.createElement('h1');
    heading.textContent = t('settings');
    container.append(back, heading);

    const settings = getChatSettings();
    const form = document.createElement('form');
    form.className = 'qu-chat-settings-form';

    const aliasRow = document.createElement('label');
    aliasRow.className = 'qu-chat-settings-row';
    const aliasCheckbox = document.createElement('input');
    aliasCheckbox.type = 'checkbox';
    aliasCheckbox.checked = settings.showAliasIn1to1;
    aliasRow.append(aliasCheckbox, document.createTextNode(` ${t('showAliasIn1to1')}`));

    const colorRow = document.createElement('label');
    colorRow.className = 'qu-chat-settings-row';
    const colorLabel = document.createElement('span');
    colorLabel.textContent = t('ownColor');
    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.value = settings.ownColor;
    colorRow.append(colorLabel, colorInput);

    const status = document.createElement('span');
    status.className = 'qu-chat-settings-status';
    const saveBtn = document.createElement('button');
    saveBtn.type = 'submit';
    saveBtn.textContent = t('save');

    form.append(aliasRow, colorRow, saveBtn, status);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      setChatSettings({ showAliasIn1to1: aliasCheckbox.checked, ownColor: colorInput.value });
      status.textContent = t('saved');
      setTimeout(() => { status.textContent = ''; }, 2000);
    });
    container.appendChild(form);
  }

  /** Global search: scans every room's already-listMessages()-fetched content, same local-only-scan approach as the room-scoped search below - see renderSearchUI() (shared) for the matching logic. */
  async function renderGlobalSearch(myActorPub) {
    if (stopped) return;
    container.textContent = '';
    const [contacts, groupIds] = await Promise.all([services.contacts.listContacts(), services.chat.listMyGroups()]);
    if (stopped) return;

    const rooms = [];
    for (const { actorPub, profile } of contacts) {
      const id = await ChatService.roomId([myActorPub, actorPub]);
      rooms.push({ href: `#/chat/${actorPub}`, name: profile?.alias || `~${actorPub.slice(0, 10)}…`, spaceId: SPACE, threadId: id, isGroup: false });
    }
    for (const id of groupIds) {
      const config = await services.threads.getConfig(SPACE, id);
      if (!config) continue;
      rooms.push({ href: `#/chat/g/${id}`, name: config.name || id, spaceId: SPACE, threadId: id, isGroup: true });
    }
    if (stopped) return;

    renderSearchUI(container, rooms, '#/chat', null);
  }

  /**
   * Search scoped to ONE chat - its own subpage (#/chat/search/<pub> or
   * #/chat/search/g/<groupId>), not an inline in-room toggle: a real route
   * means a real back button, a shareable/bookmarkable URL, and no risk of
   * the toggle panel fighting the message list for vertical space.
   */
  async function renderChatSearchPage(myActorPub, target) {
    if (stopped) return;
    container.textContent = '';
    let spaceId, threadId, href, name;
    if (target.type === 'group') {
      spaceId = SPACE;
      threadId = target.groupId;
      href = `#/chat/g/${threadId}`;
      const config = await services.threads.getConfig(spaceId, threadId);
      if (stopped) return;
      if (!config || config.kind !== 'group' || !config.readers?.includes(myActorPub)) {
        const back = document.createElement('a');
        back.className = 'qu-chat-back';
        back.href = '#/chat';
        back.textContent = t('back');
        const msg = document.createElement('p');
        msg.textContent = t('groupNotFound');
        container.append(back, msg);
        return;
      }
      name = config.name || threadId;
    } else {
      spaceId = SPACE;
      threadId = await ChatService.roomId([myActorPub, target.peerActorPub]);
      if (stopped) return;
      href = `#/chat/${target.peerActorPub}`;
      const theirProfile = await services.profile.getPublicProfile(target.peerActorPub);
      if (stopped) return;
      name = theirProfile?.alias || `~${target.peerActorPub.slice(0, 10)}…`;
    }
    renderSearchUI(container, [{ href, name, spaceId, threadId }], href, { href, name });
  }

  /**
   * Shared by both global search (every room in `rooms`) and a single
   * chat's search subpage (`rooms` narrowed to one entry, `onlyRoom` set
   * for the heading/room-label suppression) - a plain local substring scan
   * over already-`listMessages()`-fetched content, no network query,
   * matching ReactivityJS/Qu's own search (it never queries the relay
   * either - search only ever covers what's already synced locally).
   * @param {HTMLElement} mountEl
   * @param {Array<{href:string, name:string, spaceId, threadId}>} rooms
   * @param {string} backHref
   * @param {{href:string, name:string}|null} onlyRoom - if set, this is a single-chat search: room label is suppressed on each result (redundant - already all one chat) and the heading names the chat.
   */
  function renderSearchUI(mountEl, rooms, backHref, onlyRoom) {
    const wrap = document.createElement('div');
    wrap.className = 'qu-chat-search';

    const back = document.createElement('a');
    back.className = 'qu-chat-back';
    back.href = backHref;
    back.textContent = t('back');
    wrap.appendChild(back);

    const heading = document.createElement('h1');
    heading.textContent = onlyRoom ? t('searchThisChat') + (onlyRoom.name ? ` – ${onlyRoom.name}` : '') : t('searchEverywhere');
    wrap.appendChild(heading);

    const input = document.createElement('input');
    input.type = 'search';
    input.className = 'qu-chat-search-input';
    input.placeholder = t('searchPlaceholder');

    const dateRow = document.createElement('div');
    dateRow.className = 'qu-chat-search-date-row';
    const dateFromLabel = document.createElement('label');
    dateFromLabel.textContent = t('searchDateFrom');
    const dateFrom = document.createElement('input');
    dateFrom.type = 'date';
    dateFromLabel.appendChild(dateFrom);
    const dateToLabel = document.createElement('label');
    dateToLabel.textContent = t('searchDateTo');
    const dateTo = document.createElement('input');
    dateTo.type = 'date';
    dateToLabel.appendChild(dateTo);
    dateRow.append(dateFromLabel, dateToLabel);

    const filters = document.createElement('div');
    filters.className = 'qu-chat-search-filters';
    let activeFilter = 'all';
    const filterBtns = [];
    for (const [key, label] of [['all', t('searchAll')], ['links', t('searchLinks')], ['images', t('searchImages')], ['videos', t('searchVideos')], ['files', t('searchFiles')]]) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'qu-chat-search-filter-btn';
      btn.dataset.active = String(key === 'all');
      btn.textContent = label;
      btn.addEventListener('click', () => {
        activeFilter = key;
        for (const b of filterBtns) b.dataset.active = String(b === btn);
        runSearch();
      });
      filterBtns.push(btn);
      filters.appendChild(btn);
    }

    const resultsEl = document.createElement('ul');
    resultsEl.className = 'qu-chat-search-results';

    wrap.append(input, dateRow, filters, resultsEl);
    mountEl.appendChild(wrap);
    input.focus();

    async function runSearch() {
      const query = input.value.trim().toLowerCase();
      // A plain <input type=date>'s value is a LOCAL calendar date
      // ("YYYY-MM-DD") with no time zone attached - anchoring it to
      // midnight/23:59:59.999 in the browser's own local time (not UTC)
      // is what makes "from 2026-01-01" actually include messages sent
      // that whole day in the user's own time zone.
      const fromTs = dateFrom.value ? new Date(`${dateFrom.value}T00:00:00`).getTime() : null;
      const toTs = dateTo.value ? new Date(`${dateTo.value}T23:59:59.999`).getTime() : null;
      resultsEl.textContent = '';
      const matches = [];
      for (const room of rooms) {
        const messages = await services.threads.listMessages(room.spaceId, room.threadId);
        for (const message of messages) {
          if (fromTs !== null && message.ts < fromTs) continue;
          if (toTs !== null && message.ts > toTs) continue;
          const mime = message.attachment?.mime ?? '';
          const isImage = mime.startsWith('image/');
          const isVideo = mime.startsWith('video/');
          const isOtherFile = !!message.attachment && !isImage && !isVideo;
          const hasLink = !!message.body && linkifySegments(message.body).some((s) => s.type === 'link');
          if (activeFilter === 'links' && !hasLink) continue;
          if (activeFilter === 'images' && !isImage) continue;
          if (activeFilter === 'videos' && !isVideo) continue;
          if (activeFilter === 'files' && !isOtherFile) continue;
          if (query) {
            const haystack = `${message.body ?? ''} ${message.attachment?.name ?? ''}`.toLowerCase();
            if (!haystack.includes(query)) continue;
          }
          matches.push({ room, message });
        }
      }
      matches.sort((a, b) => (b.message.ts ?? 0) - (a.message.ts ?? 0));
      if (matches.length === 0) {
        const empty = document.createElement('li');
        empty.className = 'qu-chat-search-empty';
        empty.textContent = t('noResults');
        resultsEl.appendChild(empty);
        return;
      }
      for (const { room, message } of matches.slice(0, 100)) {
        const li = document.createElement('li');
        li.className = 'qu-chat-search-result';
        const a = document.createElement('a');
        a.href = `${room.href}/m/${message.id}`;
        if (!onlyRoom) {
          const roomLabel = document.createElement('div');
          roomLabel.className = 'qu-chat-search-result-room';
          roomLabel.textContent = room.name;
          a.appendChild(roomLabel);
        }
        const snippet = document.createElement('div');
        snippet.textContent = message.body?.trim() || attachmentPreviewLabel(message.attachment);
        a.appendChild(snippet);
        const time = document.createElement('div');
        time.className = 'qu-chat-search-result-time';
        time.textContent = fmtTime(message.ts);
        a.appendChild(time);
        li.appendChild(a);
        resultsEl.appendChild(li);
      }
    }

    input.addEventListener('input', runSearch);
    dateFrom.addEventListener('change', runSearch);
    dateTo.addEventListener('change', runSearch);
    runSearch();
  }

  async function renderRoom(myActorPub, target) {
    container.textContent = '';
    container.style.setProperty('--qu-chat-own-color', getChatSettings().ownColor);

    let spaceId, threadId, config, headerName, headerAvatar, headerSeed;
    if (target.type === 'group') {
      spaceId = SPACE;
      threadId = target.groupId;
      config = await services.threads.getConfig(spaceId, threadId);
      if (stopped) return;
      if (!config || config.kind !== 'group' || !config.readers?.includes(myActorPub)) {
        const back = document.createElement('a');
        back.className = 'qu-chat-back';
        back.href = '#/chat';
        back.textContent = t('back');
        const msg = document.createElement('p');
        msg.textContent = t('groupNotFound');
        container.append(back, msg);
        return;
      }
      headerName = config.name || threadId;
      headerAvatar = '👥';
      headerSeed = threadId;
    } else {
      spaceId = SPACE;
      threadId = await ChatService.roomId([myActorPub, target.peerActorPub]);
      if (stopped) return;
      config = await services.threads.createThread(spaceId, threadId, THREAD_PRESETS.chat([myActorPub, target.peerActorPub]));
      if (stopped) return;
      const theirProfile = await services.profile.getPublicProfile(target.peerActorPub);
      if (stopped) return;
      headerName = theirProfile?.alias || `~${target.peerActorPub.slice(0, 10)}…`;
      headerAvatar = theirProfile?.avatar ?? null;
      headerSeed = target.peerActorPub;
    }

    const memberPubs = config.readers;
    const readerPubsForEncryption = config.readers !== '*' ? config.readers : null;
    const isGroup = target.type === 'group';

    const header = document.createElement('div');
    header.className = 'qu-chat-header';
    const back = document.createElement('a');
    back.className = 'qu-chat-back';
    back.href = '#/chat';
    back.textContent = t('back');
    header.appendChild(back);
    header.appendChild(renderAvatar(headerSeed, headerName, headerAvatar));

    const headerInfo = document.createElement('div');
    headerInfo.className = 'qu-chat-header-info';
    const nameEl = document.createElement('span');
    nameEl.className = 'qu-chat-header-name';
    nameEl.textContent = headerName;
    headerInfo.appendChild(nameEl);

    const presenceEl = document.createElement('span');
    presenceEl.className = 'qu-chat-presence';
    const membersToggle = document.createElement('button');
    membersToggle.type = 'button';
    if (isGroup) headerInfo.appendChild(membersToggle);
    else headerInfo.appendChild(presenceEl);
    header.appendChild(headerInfo);

    const searchToggleBtn = document.createElement('a');
    searchToggleBtn.className = 'qu-chat-icon-btn';
    searchToggleBtn.href = isGroup ? `#/chat/search/g/${threadId}` : `#/chat/search/${target.peerActorPub}`;
    searchToggleBtn.textContent = '🔍';
    searchToggleBtn.title = t('searchThisChat');
    header.appendChild(searchToggleBtn);

    // Manual escape hatch for the auto-scroll/anchor bookkeeping above -
    // whatever state it's in, this always jumps to the newest message,
    // clears any active permalink anchor, and resumes auto-scroll.
    const resetScrollBtn = document.createElement('button');
    resetScrollBtn.type = 'button';
    resetScrollBtn.className = 'qu-chat-icon-btn';
    resetScrollBtn.textContent = '⬇️';
    resetScrollBtn.title = t('resetScroll');
    resetScrollBtn.addEventListener('click', () => scrollToVeryBottom());
    header.appendChild(resetScrollBtn);

    const roomMenuBtn = document.createElement('button');
    roomMenuBtn.type = 'button';
    roomMenuBtn.className = 'qu-chat-icon-btn';
    roomMenuBtn.textContent = '⋮';
    roomMenuBtn.title = t('more');
    roomMenuBtn.addEventListener('click', (e) => { e.stopPropagation(); openRoomMenu(roomMenuBtn); });
    header.appendChild(roomMenuBtn);

    const encHint = document.createElement('div');
    encHint.className = 'qu-chat-encrypted-hint';
    encHint.textContent = '🔒';
    encHint.title = t('encrypted');
    header.appendChild(encHint);
    container.appendChild(header);

    const membersEl = document.createElement('div');
    membersEl.className = 'qu-chat-members';
    membersEl.hidden = true;
    if (isGroup) container.appendChild(membersEl);
    membersToggle.addEventListener('click', async () => {
      if (!membersEl.hidden) { membersEl.hidden = true; return; }
      membersEl.textContent = '';
      const heading = document.createElement('strong');
      heading.textContent = t('members');
      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'qu-chat-members-close';
      closeBtn.textContent = t('close');
      closeBtn.addEventListener('click', () => { membersEl.hidden = true; });
      const headRow = document.createElement('div');
      headRow.className = 'qu-chat-members-row';
      headRow.append(heading, closeBtn);
      membersEl.appendChild(headRow);
      for (const pub of memberPubs) {
        const profile = pub === myActorPub ? null : await services.profile.getPublicProfile(pub);
        const row = document.createElement('div');
        row.className = 'qu-chat-members-row';
        row.append(renderAvatar(pub, profile?.alias || pub, profile?.avatar ?? null, { small: true }));
        const label = document.createElement('span');
        label.textContent = pub === myActorPub ? t('you') : (profile?.alias || `~${pub.slice(0, 10)}…`);
        row.appendChild(label);
        membersEl.appendChild(row);
      }
      membersEl.hidden = false;
    });

    const pinnedBar = document.createElement('div');
    pinnedBar.className = 'qu-chat-pinned-bar';
    container.appendChild(pinnedBar);

    const listEl = document.createElement('ul');
    listEl.className = 'qu-chat-messages';
    container.appendChild(listEl);

    // ---- Shared floating popups (ONE instance each, repositioned/repopulated
    // per message - not one per bubble). Matches ReactivityJS/Qu's own
    // examples/chat/app.mjs interaction model. ----
    const actionsMenuEl = document.createElement('div');
    actionsMenuEl.className = 'qu-chat-popup';
    actionsMenuEl.hidden = true;
    const reactionPopupEl = document.createElement('div');
    reactionPopupEl.className = 'qu-chat-reaction-popup';
    reactionPopupEl.hidden = true;
    // Rebuilt on every open (not built once) - starts back at the quick
    // 8-choice view each time rather than remembering "was left expanded"
    // from a previous message's reaction pick.
    function renderReactionPopup(extended = false) {
      reactionPopupEl.textContent = '';
      reactionPopupEl.classList.toggle('qu-chat-reaction-popup-extended', extended);
      const emojiClickHandler = async (emoji) => {
        const message = reactionPopupContext;
        closePopups();
        if (!message) return;
        await services.threads.setReaction(spaceId, threadId, message.id, emoji);
        await reload();
      };
      for (const emoji of REACTION_CHOICES) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = emoji;
        btn.addEventListener('click', () => emojiClickHandler(emoji));
        reactionPopupEl.appendChild(btn);
      }
      if (!extended) {
        const more = document.createElement('button');
        more.type = 'button';
        more.className = 'qu-chat-reaction-more-btn';
        more.textContent = '+';
        more.title = t('moreEmoji');
        more.addEventListener('click', (e) => { e.stopPropagation(); renderReactionPopup(true); });
        reactionPopupEl.appendChild(more);
      } else {
        for (const emoji of EXTENDED_EMOJI_SET) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.textContent = emoji;
          btn.addEventListener('click', () => emojiClickHandler(emoji));
          reactionPopupEl.appendChild(btn);
        }
      }
    }
    const pinListPopupEl = document.createElement('div');
    pinListPopupEl.className = 'qu-chat-pin-list-popup';
    pinListPopupEl.hidden = true;
    document.body.append(actionsMenuEl, reactionPopupEl, pinListPopupEl);

    // A single shared lightbox for every image attachment in this room -
    // same "one instance, repositioned/repopulated" reasoning as the
    // popups above, matching ReactivityJS/Qu's own single #lightbox element.
    const lightboxEl = document.createElement('div');
    lightboxEl.className = 'qu-chat-lightbox';
    lightboxEl.hidden = true;
    const lightboxImg = document.createElement('img');
    const lightboxClose = document.createElement('button');
    lightboxClose.type = 'button';
    lightboxClose.className = 'qu-chat-lightbox-close';
    lightboxClose.textContent = '✕';
    lightboxEl.append(lightboxClose, lightboxImg);
    document.body.appendChild(lightboxEl);

    function openLightbox(url) {
      lightboxImg.src = url;
      lightboxImg.classList.remove('qu-chat-lightbox-zoomed');
      lightboxEl.hidden = false;
    }
    function closeLightbox() {
      lightboxEl.hidden = true;
      lightboxImg.src = '';
    }
    lightboxClose.addEventListener('click', closeLightbox);
    lightboxEl.addEventListener('click', (e) => { if (e.target === lightboxEl) closeLightbox(); });
    lightboxImg.addEventListener('click', () => lightboxImg.classList.toggle('qu-chat-lightbox-zoomed'));
    const onLightboxKeydown = (e) => { if (e.key === 'Escape' && !lightboxEl.hidden) closeLightbox(); };
    document.addEventListener('keydown', onLightboxKeydown);

    let actionsMenuContext = null; // the message the actions menu is currently open for
    let reactionPopupContext = null;

    function closePopups() {
      actionsMenuEl.hidden = true;
      reactionPopupEl.hidden = true;
      pinListPopupEl.hidden = true;
      actionsMenuContext = null;
      reactionPopupContext = null;
    }
    const onDocClick = (event) => {
      if (!actionsMenuEl.hidden && !actionsMenuEl.contains(event.target) && !event.target.closest('.qu-chat-msg-actions-btn')) closePopups();
      else if (!reactionPopupEl.hidden && !reactionPopupEl.contains(event.target)) closePopups();
      else if (!pinListPopupEl.hidden && !pinListPopupEl.contains(event.target) && !event.target.closest('.qu-chat-pinned-count')) closePopups();
    };
    document.addEventListener('click', onDocClick);

    // Per-room cleanup (this function's own popups/timers), layered under
    // the mount-level cleanup below which handles cross-room state (watch,
    // heartbeat, presence timer already assigned to the outer closure).
    // Registered HERE - right after the popups/lightbox exist - rather
    // than at the end of renderRoom(), which still has a good amount of
    // further async work ahead of it (the initial reload(), presence
    // setup, etc.). That further work can genuinely still be in flight
    // when the user navigates away again quickly (an automated test
    // clicking through several routes back-to-back reproduces it
    // reliably, but a fast real user can trigger it too) - the shell
    // unmounts the CURRENT app on every navigation (see
    // apps/shell/src/main.js's _renderRoute(), which calls
    // stopMountedApp() unconditionally before mounting the next route),
    // and that runs THIS mount()'s own cleanup - the `return () => {...}`
    // below - which drains `roomCleanups` at that exact moment. If this
    // registration hadn't happened yet (still stuck behind an in-flight
    // await), the drain finds nothing to clean up, `lightboxEl`/the
    // popups are appended to document.body but never removed, and stay
    // there orphaned for the lifetime of the page - exactly the "two
    // lightboxes" duplicate-popup bug this was reordered to fix.
    const cleanupRoom = () => {
      document.removeEventListener('click', onDocClick);
      document.removeEventListener('keydown', onLightboxKeydown);
      actionsMenuEl.remove();
      reactionPopupEl.remove();
      pinListPopupEl.remove();
      lightboxEl.remove();
      if (readReceiptTimer) clearInterval(readReceiptTimer);
      releaseMic(); // navigating away mid-recording (without discarding first) must not leave the mic indicator on
    };
    roomCleanups.push(cleanupRoom);

    function openActionsMenu(message, allMessages, isPinned, anchorEl) {
      actionsMenuContext = message;
      reactionPopupEl.hidden = true;
      actionsMenuEl.textContent = '';
      const mine = message.author === myActorPub;
      const items = [
        { label: t('react'), onClick: () => { closeActionsKeepMessage(); openReactionPopup(message, anchorEl); } },
        { label: isPinned ? `📌 ${t('unpin')}` : `📌 ${t('pin')}`, onClick: async () => { closePopups(); await services.threads.setPinned(spaceId, threadId, message.id, !isPinned); await reload(); } },
        { label: `↩️ ${t('reply')}`, onClick: () => { closePopups(); setComposerMode('reply', message); } },
      ];
      if (mine && message.body && !message.attachment) {
        items.push({ label: `✏️ ${t('edit')}`, onClick: () => { closePopups(); setComposerMode('edit', message); } });
      }
      if (message.body) {
        items.push({ label: `➡️ ${t('forward')}`, onClick: () => { closePopups(); openForwardModal(message); } });
        items.push({ label: `📋 ${t('copyText')}`, onClick: async () => { closePopups(); try { await navigator.clipboard.writeText(message.body); } catch { /* clipboard unavailable - silently ignored, not critical */ } } });
      }
      for (const item of items) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'qu-chat-popup-item';
        btn.textContent = item.label;
        btn.addEventListener('click', (e) => { e.stopPropagation(); item.onClick(); });
        actionsMenuEl.appendChild(btn);
      }
      actionsMenuEl.hidden = false;
      positionPopup(actionsMenuEl, anchorEl.getBoundingClientRect());
    }
    function closeActionsKeepMessage() { actionsMenuEl.hidden = true; }
    function openReactionPopup(message, anchorEl) {
      reactionPopupContext = message;
      renderReactionPopup();
      reactionPopupEl.hidden = false;
      positionPopup(reactionPopupEl, anchorEl.getBoundingClientRect());
    }

    // Room-level menu (currently just "clear chat") - reuses the SAME
    // shared popup element as the per-message ⋮ menu (openActionsMenu()
    // above), same "one instance, repositioned/repopulated" reasoning.
    function openRoomMenu(anchorEl) {
      actionsMenuContext = null;
      reactionPopupEl.hidden = true;
      actionsMenuEl.textContent = '';
      const items = [
        { label: `🗑 ${t('clearChat')}`, onClick: async () => {
          closePopups();
          // A real confirm() dialog, not a custom one - this is a
          // destructive, hard-to-reverse action (there's no delete
          // primitive in Qu's storage layer, so "clearing" really does
          // wipe every member's view of the history the moment it syncs
          // - see ThreadService.clearMessages()'s own doc comment) and
          // the native dialog is the simplest reliable way to gate it.
          if (!confirm(t('clearChatConfirm'))) return;
          await services.threads.clearMessages(spaceId, threadId);
          await reload({ forceScrollBottom: true });
        } },
      ];
      for (const item of items) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'qu-chat-popup-item';
        btn.textContent = item.label;
        btn.addEventListener('click', (e) => { e.stopPropagation(); item.onClick(); });
        actionsMenuEl.appendChild(btn);
      }
      actionsMenuEl.hidden = false;
      positionPopup(actionsMenuEl, anchorEl.getBoundingClientRect());
    }

    async function openForwardModal(message) {
      const [contacts, groupIds] = await Promise.all([services.contacts.listContacts(), services.chat.listMyGroups()]);
      if (stopped) return;
      const targets = [];
      for (const { actorPub, profile } of contacts) {
        if (target.type === 'direct' && actorPub === target.peerActorPub) continue;
        targets.push({ href: `#/chat/${actorPub}`, seed: actorPub, name: profile?.alias || `~${actorPub.slice(0, 10)}…`, avatar: profile?.avatar ?? null, spaceId: SPACE, threadId: await ChatService.roomId([myActorPub, actorPub]), config: THREAD_PRESETS.chat([myActorPub, actorPub]) });
      }
      for (const id of groupIds) {
        if (target.type === 'group' && id === target.groupId) continue;
        const gConfig = await services.threads.getConfig(SPACE, id);
        if (!gConfig) continue;
        targets.push({ href: `#/chat/g/${id}`, seed: id, name: gConfig.name || id, avatar: '👥', spaceId: SPACE, threadId: id, config: gConfig });
      }
      if (stopped) return;

      const backdrop = document.createElement('div');
      backdrop.className = 'qu-chat-forward-modal-backdrop';
      const modal = document.createElement('div');
      modal.className = 'qu-chat-forward-modal';
      const heading = document.createElement('h2');
      heading.textContent = t('forwardTo');
      modal.appendChild(heading);

      if (targets.length === 0) {
        const empty = document.createElement('p');
        empty.textContent = t('noRoomsToForward');
        modal.appendChild(empty);
      } else {
        const list = document.createElement('ul');
        list.className = 'qu-chat-forward-list';
        for (const targetRoom of targets) {
          const li = document.createElement('li');
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'qu-chat-forward-room-btn';
          btn.append(renderAvatar(targetRoom.seed, targetRoom.name, targetRoom.avatar, { small: true }));
          const span = document.createElement('span');
          span.textContent = targetRoom.name;
          btn.appendChild(span);
          btn.addEventListener('click', async () => {
            await services.threads.createThread(targetRoom.spaceId, targetRoom.threadId, targetRoom.config);
            await services.threads.postMessage(targetRoom.spaceId, targetRoom.threadId, {
              body: message.body,
              extra: { forwardedFrom: { author: message.author, ts: message.ts, body: message.body } },
            });
            backdrop.remove();
            location.hash = targetRoom.href;
          });
          li.appendChild(btn);
          list.appendChild(li);
        }
        modal.appendChild(list);
      }

      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'qu-chat-forward-close';
      closeBtn.textContent = t('cancel');
      closeBtn.addEventListener('click', () => backdrop.remove());
      modal.appendChild(closeBtn);

      backdrop.appendChild(modal);
      backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.remove(); });
      document.body.appendChild(backdrop);
    }

    const replyBanner = document.createElement('div');
    replyBanner.className = 'qu-chat-reply-banner';
    replyBanner.hidden = true;
    container.appendChild(replyBanner);

    const pendingAttachmentEl = document.createElement('div');
    pendingAttachmentEl.className = 'qu-chat-pending-attachment';
    pendingAttachmentEl.hidden = true;
    container.appendChild(pendingAttachmentEl);

    const form = document.createElement('form');
    form.className = 'qu-chat-composer';
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.hidden = true;
    const attachBtn = document.createElement('button');
    attachBtn.type = 'button';
    attachBtn.className = 'qu-chat-icon-btn';
    attachBtn.textContent = '📎';
    attachBtn.title = t('attach');
    const locationBtn = document.createElement('button');
    locationBtn.type = 'button';
    locationBtn.className = 'qu-chat-icon-btn';
    locationBtn.textContent = '📍';
    locationBtn.title = t('shareLocation');
    const voiceBtn = document.createElement('button');
    voiceBtn.type = 'button';
    voiceBtn.className = 'qu-chat-icon-btn';
    voiceBtn.textContent = '🎤';
    voiceBtn.title = t('recordVoice');
    const input = document.createElement('textarea');
    input.rows = 1;
    input.placeholder = t('composerPlaceholder');
    const sendBtn = document.createElement('button');
    sendBtn.type = 'submit';
    sendBtn.className = 'qu-chat-send-btn';
    sendBtn.textContent = '➤';
    sendBtn.title = t('send');
    form.append(fileInput, attachBtn, locationBtn, voiceBtn, input, sendBtn);
    container.appendChild(form);

    const voiceBar = document.createElement('div');
    voiceBar.className = 'qu-chat-voice-bar';
    voiceBar.hidden = true;
    container.appendChild(voiceBar);

    let replyTo = null; // { id, author, body }
    let editTarget = null; // message being edited
    let forwardHint = null; // { author, ts, body } shown while composing a NEW message that will carry forwardedFrom - unused here (forwarding posts directly, see openForwardModal), kept null
    let pendingFile = null;
    let profileCache = new Map();

    async function nameFor(actorPub) {
      if (actorPub === myActorPub) return t('you');
      if (!isGroup) return headerName;
      if (!profileCache.has(actorPub)) {
        profileCache.set(actorPub, await services.profile.getPublicProfile(actorPub));
      }
      const profile = profileCache.get(actorPub);
      return profile?.alias || `~${actorPub.slice(0, 10)}…`;
    }

    function setComposerMode(mode, message) {
      replyTo = null;
      editTarget = null;
      if (mode === 'reply') replyTo = { id: message.id, author: message.author, body: message.body };
      else if (mode === 'edit') { editTarget = message; input.value = message.body ?? ''; }
      renderComposerBanner();
      input.focus();
    }

    async function renderComposerBanner() {
      replyBanner.hidden = !(replyTo || editTarget);
      replyBanner.textContent = '';
      if (!replyTo && !editTarget) return;
      const body = document.createElement('div');
      body.className = 'qu-chat-reply-banner-body';
      const label = document.createElement('span');
      label.className = 'qu-chat-reply-banner-label';
      const text = document.createElement('span');
      text.className = 'qu-chat-reply-banner-text';
      if (editTarget) {
        label.textContent = `✏️ ${t('editingMessage')}`;
        text.textContent = editTarget.body?.slice(0, 80) ?? '';
      } else {
        label.textContent = t('replyingTo', { name: await nameFor(replyTo.author) });
        text.textContent = replyTo.body?.slice(0, 80) || attachmentPreviewLabel(replyTo.attachment);
      }
      body.append(label, text);
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.textContent = '✕';
      cancel.addEventListener('click', () => {
        replyTo = null;
        editTarget = null;
        input.value = '';
        renderComposerBanner();
      });
      replyBanner.append(body, cancel);
    }

    attachBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      pendingFile = fileInput.files[0] ?? null;
      pendingAttachmentEl.hidden = !pendingFile;
      pendingAttachmentEl.textContent = '';
      if (pendingFile) {
        const label = document.createElement('span');
        label.textContent = `📎 ${pendingFile.name} (${fmtSize(pendingFile.size)})`;
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.textContent = '✕';
        remove.title = t('removeAttachment');
        remove.addEventListener('click', () => {
          pendingFile = null;
          fileInput.value = '';
          pendingAttachmentEl.hidden = true;
        });
        pendingAttachmentEl.append(label, remove);
      }
    });

    // ---- Location sharing: one-time position, sent as a plain text message
    // whose body a recognized-URL renderer (see locationBlock() below) turns
    // into a static-tile preview for every reader, including this one. ----
    locationBtn.addEventListener('click', () => {
      if (!navigator.geolocation) { pendingAttachmentEl.hidden = false; pendingAttachmentEl.textContent = t('locationNotSupported'); return; }
      locationBtn.disabled = true;
      navigator.geolocation.getCurrentPosition(
        async (pos) => {
          locationBtn.disabled = false;
          const { latitude, longitude } = pos.coords;
          const posted = await services.threads.postMessage(spaceId, threadId, { body: buildLocationUrl(latitude.toFixed(5), longitude.toFixed(5)) });
          pendingSyncIds.add(posted.id);
          await reload({ forceScrollBottom: true });
          confirmSync(posted.id, paths.threadMessagePath(spaceId, threadId, posted.id));
        },
        () => { locationBtn.disabled = false; pendingAttachmentEl.hidden = false; pendingAttachmentEl.textContent = t('locationFailed'); },
        { enableHighAccuracy: false, timeout: 10_000 }
      );
    });

    // ---- Voice messages: MediaRecorder, armed-but-not-recording until an
    // explicit Start tap (so the first moment isn't lost while the mic
    // permission prompt is still up), then preview-before-send. ----
    let mediaRecorder = null;
    let activeStream = null; // the getUserMedia() MediaStream - tracked OUTSIDE mediaRecorder so it can always be released (see releaseMic() below), regardless of whether recording ever actually started
    let recordedChunks = [];
    let recordingStartedAt = 0;
    let voiceTimerInterval = null;
    let discardRecording = false;

    /**
     * Stops every track of the current getUserMedia() stream, if any -
     * releasing the OS/browser mic indicator. MUST be called on every exit
     * path (send, discard from ANY state, or the room unmounting entirely),
     * not just after a real recording: a `MediaRecorder` that was only
     * ARMED (constructed, never `.start()`-ed) has `state === 'inactive'`
     * from the moment it's created - the SAME value it has after a real
     * stop() - so branching discard behavior on `mediaRecorder.state`
     * (the previous approach) could never tell "never started" apart from
     * "already stopped", and silently left the mic stream open when
     * discarding before ever pressing record.
     */
    function releaseMic() {
      if (!activeStream) return;
      for (const track of activeStream.getTracks()) track.stop();
      activeStream = null;
    }

    voiceBtn.addEventListener('click', async () => {
      if (typeof MediaRecorder === 'undefined') { pendingAttachmentEl.hidden = false; pendingAttachmentEl.textContent = t('voiceNotSupported'); return; }
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        pendingAttachmentEl.hidden = false; pendingAttachmentEl.textContent = t('voiceNotSupported');
        return;
      }
      activeStream = stream;
      recordedChunks = [];
      discardRecording = false;
      const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
      mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      mediaRecorder.addEventListener('dataavailable', (e) => { if (e.data.size) recordedChunks.push(e.data); });
      mediaRecorder.addEventListener('stop', () => {
        releaseMic();
        if (discardRecording) { resetVoiceBar(); return; }
        renderVoicePreview(new Blob(recordedChunks, { type: mediaRecorder.mimeType || 'audio/webm' }));
      });
      form.hidden = true;
      renderVoiceBar('armed');
    });

    function resetVoiceBar() {
      releaseMic();
      if (voiceTimerInterval) clearInterval(voiceTimerInterval);
      voiceTimerInterval = null;
      voiceBar.hidden = true;
      voiceBar.textContent = '';
      form.hidden = false;
    }

    function renderVoiceBar(state) {
      voiceBar.hidden = false;
      voiceBar.textContent = '';
      const status = document.createElement('div');
      status.className = 'qu-chat-voice-status';
      status.dataset.recording = String(state === 'recording');
      const dot = document.createElement('span');
      dot.className = 'qu-chat-voice-dot';
      const label = document.createElement('span');
      label.textContent = '0:00';
      status.append(dot, label);
      voiceBar.appendChild(status);

      const canPause = typeof mediaRecorder?.pause === 'function';
      if (state === 'armed') {
        const startBtn = document.createElement('button');
        startBtn.type = 'button';
        startBtn.className = 'qu-chat-icon-btn';
        startBtn.textContent = '⏺';
        startBtn.title = t('voiceStart');
        startBtn.addEventListener('click', () => {
          mediaRecorder.start();
          recordingStartedAt = Date.now();
          renderVoiceBar('recording');
          voiceTimerInterval = setInterval(() => {
            const seconds = Math.floor((Date.now() - recordingStartedAt) / 1000);
            label.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
          }, 250);
        });
        voiceBar.appendChild(startBtn);
      } else if (state === 'recording' || state === 'paused') {
        status.dataset.recording = String(state === 'recording');
        if (canPause) {
          const toggleBtn = document.createElement('button');
          toggleBtn.type = 'button';
          toggleBtn.className = 'qu-chat-icon-btn';
          if (state === 'recording') {
            toggleBtn.textContent = '⏸';
            toggleBtn.title = t('voicePause');
            toggleBtn.addEventListener('click', () => { mediaRecorder.pause(); renderVoiceBar('paused'); });
          } else {
            toggleBtn.textContent = '▶';
            toggleBtn.title = t('voiceResume');
            toggleBtn.addEventListener('click', () => { mediaRecorder.resume(); renderVoiceBar('recording'); });
          }
          voiceBar.appendChild(toggleBtn);
        }
        const stopBtn = document.createElement('button');
        stopBtn.type = 'button';
        stopBtn.className = 'qu-chat-icon-btn';
        stopBtn.textContent = '⏹';
        stopBtn.title = t('voiceStop');
        stopBtn.addEventListener('click', () => { if (voiceTimerInterval) clearInterval(voiceTimerInterval); mediaRecorder.stop(); });
        voiceBar.appendChild(stopBtn);
      }
      const discardBtn = document.createElement('button');
      discardBtn.type = 'button';
      discardBtn.className = 'qu-chat-icon-btn';
      discardBtn.textContent = '🗑';
      discardBtn.title = t('voiceDiscard');
      discardBtn.addEventListener('click', () => {
        if (state === 'armed') {
          // Never actually started recording (no 'stop' event will ever
          // fire to release it) - the mic stream opened the moment this
          // bar was armed and must be released here directly.
          resetVoiceBar();
        } else {
          discardRecording = true;
          if (voiceTimerInterval) clearInterval(voiceTimerInterval);
          mediaRecorder.stop(); // 'stop' listener releases the mic and resets the bar
        }
      });
      voiceBar.appendChild(discardBtn);
    }

    function renderVoicePreview(blob) {
      voiceBar.textContent = '';
      const audio = document.createElement('audio');
      audio.controls = true;
      audio.src = URL.createObjectURL(blob);
      voiceBar.appendChild(audio);
      const sendVoiceBtn = document.createElement('button');
      sendVoiceBtn.type = 'button';
      sendVoiceBtn.className = 'qu-chat-icon-btn';
      sendVoiceBtn.textContent = '➤';
      sendVoiceBtn.title = t('voiceSend');
      sendVoiceBtn.addEventListener('click', async () => {
        resetVoiceBar();
        const ts = Date.now();
        const assetId = crypto.randomUUID();
        const file = { name: voiceMessageFilename(ts), mime: blob.type || 'audio/webm', data: blob };
        const meta = await services.assets.upload(spaceId, assetId, file, { readerPubs: readerPubsForEncryption });
        const posted = await services.threads.postMessage(spaceId, threadId, { body: '', extra: { attachment: { assetId, name: meta.name, mime: meta.mime, size: meta.size } } });
        pendingSyncIds.add(posted.id);
        await reload({ forceScrollBottom: true });
        confirmSync(posted.id, paths.threadMessagePath(spaceId, threadId, posted.id));
      });
      voiceBar.appendChild(sendVoiceBtn);
      const discardBtn = document.createElement('button');
      discardBtn.type = 'button';
      discardBtn.className = 'qu-chat-icon-btn';
      discardBtn.textContent = '🗑';
      discardBtn.title = t('voiceDiscard');
      discardBtn.addEventListener('click', resetVoiceBar);
      voiceBar.appendChild(discardBtn);
    }

    // reload() is triggered from two places that can land close together -
    // a direct call right after posting, and watch()'s own callback firing
    // for that same write - and messageRow() below has several real await
    // points (attachment lookups, reactions, profile resolution). Without
    // a generation guard, a second reload() starting mid-build of the
    // first would race it: the first's now-stale `await messageRow(...)`
    // calls keep resolving and appending into `listEl` even after the
    // second reload() already cleared and rebuilt it, leaving duplicated
    // or stale rows behind. Each reload() checks it's still the LATEST
    // one before every DOM mutation and bails out otherwise.
    let renderToken = 0;

    // Auto-scroll: only jump to the newest message if the user was already
    // near the bottom (or this is the first render) - otherwise someone
    // reading scrollback would get yanked away by an unrelated new message.
    // Tracked via a scroll listener (not recomputed inline in reload()),
    // since a synchronous check during/right after a DOM rebuild can see a
    // stale scrollHeight before layout settles.
    let stickingToBottom = true;
    let firstReload = true;
    let currentAnchorMessageId = target.anchorMessageId ?? null;
    let lastFlashedAnchorId = null; // see reload()'s re-anchor branch below - only flash on a genuinely NEW anchor, not every incidental re-render while one is active

    function isNearBottom() {
      return listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight <= 60;
    }
    // A smooth scrollIntoView() (scrollToMessage() below) fires 'scroll'
    // events throughout its own animation, same as any other scroll - the
    // listener further down would otherwise see one of THOSE events land
    // near the bottom (plausible for an anchor close to the end of the
    // list) and wrongly conclude "the user scrolled to the bottom",
    // clearing the very anchor that scroll was FOR. Suppressed for a
    // fixed settle window around any such programmatic jump - see
    // scrollToMessage()'s own comment for why this is the fix for the
    // "jumps back and can't stay on the anchored message" report.
    let suppressScrollTracking = false;
    function scrollToVeryBottom() {
      // Arriving at the bottom is unconditionally "sticking" and
      // anchor-free, set directly rather than left to the scroll
      // listener to infer - deterministic regardless of whether a
      // suppression window (see above) happens to be active right now.
      stickingToBottom = true;
      clearAnchor();
      // Set it synchronously first (correct immediately for the common
      // all-text case, and critically means a NEXT reload() starting right
      // after - a fast send burst can trigger several in close succession,
      // see the render-token comment above - reads an already-caught-up
      // scrollTop instead of a stale one). The rAF pass afterward corrects
      // for a freshly-appended image/attachment that may not have its
      // final height until after the next paint (one rAF alone can still
      // read a pre-layout scrollHeight, so two).
      listEl.scrollTop = listEl.scrollHeight;
      requestAnimationFrame(() => requestAnimationFrame(() => { listEl.scrollTop = listEl.scrollHeight; }));
    }
    function clearAnchor() {
      if (!currentAnchorMessageId) return;
      currentAnchorMessageId = null;
      history.replaceState(null, '', location.hash.split('/m/')[0]);
    }
    function setAnchor(messageId) {
      currentAnchorMessageId = messageId;
      // location.hash reliably IS this room's own URL here (setAnchor()
      // only ever runs from within an already-mounted renderRoom()) - the
      // current path minus any existing /m/<id> suffix, plus the new one.
      history.replaceState(null, '', `${location.hash.split('/m/')[0]}/m/${messageId}`);
    }
    // The native 'scroll' event fires identically for a real user gesture
    // and for our OWN programmatic scrollToVeryBottom() calls above, with
    // no reliable way to tell them apart from the event alone - and during
    // a fast send burst several reload()s (each doing its own
    // scrollToVeryBottom()) can be in flight together, so a naive
    // "trust every scroll event" listener can catch one mid-flight, at a
    // transiently-short scrollHeight, and wrongly conclude the user
    // scrolled away - permanently losing stickiness for the rest of the
    // session (nothing else would ever flip it back true). Splitting the
    // two directions onto different, unambiguous signals sidesteps that
    // entirely: only a genuine user gesture (wheel/touch) can ever move
    // you AWAY from the bottom, while arriving AT the bottom - by any
    // means, including our own auto-scroll - is always safe to trust,
    // since "further down" is where the reader intends to end up either way.
    for (const evt of ['wheel', 'touchmove']) {
      listEl.addEventListener(evt, () => { if (!isNearBottom()) stickingToBottom = false; }, { passive: true });
    }
    listEl.addEventListener('scroll', () => {
      if (suppressScrollTracking) return;
      if (!isNearBottom()) return;
      stickingToBottom = true;
      clearAnchor();
    });

    /**
     * @param {object} [options]
     * @param {boolean} [options.forceScrollBottom] - THIS device just sent
     *   a message - jump to the bottom unconditionally, same as any real
     *   messenger (you're clearly at the composer, not reading scrollback),
     *   regardless of what `stickingToBottom` currently says.
     */
    async function reload({ forceScrollBottom = false } = {}) {
      if (stopped) return;
      const myToken = ++renderToken;
      const messages = await services.threads.listMessages(spaceId, threadId);
      const pinnedIds = await services.threads.listPinned(spaceId, threadId);
      if (stopped || myToken !== renderToken) return;

      watchReactions(messages);
      renderPinnedBar(messages, pinnedIds);

      if (forceScrollBottom) stickingToBottom = true;
      const wasStickingToBottom = stickingToBottom;

      // Preserve scroll position across a reload while reading scrollback:
      // remember which row is currently topmost-visible so it can be
      // restored after the list is rebuilt, rather than always snapping
      // somewhere else.
      let anchorRow = null, anchorOffset = 0;
      if (!wasStickingToBottom && !currentAnchorMessageId) {
        for (const li of listEl.children) {
          if (li.getBoundingClientRect().bottom > listEl.getBoundingClientRect().top) {
            anchorRow = li.dataset?.messageId;
            anchorOffset = li.getBoundingClientRect().top - listEl.getBoundingClientRect().top;
            break;
          }
        }
      }

      listEl.textContent = '';
      if (messages.length === 0) {
        const li = document.createElement('li');
        li.textContent = t('empty');
        listEl.appendChild(li);
      } else {
        for (const message of messages) {
          let row;
          try {
            row = await messageRow(message, messages, pinnedIds.includes(message.id));
          } catch (err) {
            // One malformed/legacy message (e.g. from an older schema,
            // or an attachment that no longer resolves) must not silently
            // wedge the ENTIRE room: every future reload() - and
            // reload() fires constantly, for reasons having nothing to
            // do with this message (any reaction, presence, or read
            // receipt elsewhere) - would hit the exact same exception on
            // the exact same message and never get past it, leaving the
            // list permanently stuck showing only whatever came before
            // it. Render a visible placeholder for just this one message
            // and keep going instead of losing the rest of the room.
            console.error('[chat] messageRow() failed for message', message.id, err);
            row = document.createElement('li');
            row.className = 'qu-chat-msg-row qu-chat-msg-row-error';
            row.dataset.messageId = message.id;
            row.textContent = t('messageRenderError');
          }
          if (myToken !== renderToken) return; // a newer reload() started mid-loop - abandon this stale one
          listEl.appendChild(row);
        }
        if (currentAnchorMessageId) {
          // Re-anchor on EVERY reload while an anchor is active, not just
          // the first one - an anchor stays active until the user
          // actually scrolls to the bottom (see clearAnchor()), and
          // reload() fires constantly for reasons that have nothing to do
          // with what this device is looking at (a reaction on some other
          // message, someone else's new message, a pin change - see
          // watchReactions() above). Falling through to the
          // "wasStickingToBottom" bottom-jump below on any of those was
          // the actual bug: it silently overrode the user's own anchor
          // click/permalink navigation the moment anything else happened
          // to trigger a reload, which read as the whole view randomly
          // snapping to the bottom and back.
          firstReload = false;
          const isNewAnchor = currentAnchorMessageId !== lastFlashedAnchorId;
          if (isNewAnchor) lastFlashedAnchorId = currentAnchorMessageId;
          scrollToMessage(currentAnchorMessageId, true, isNewAnchor);
        } else if (firstReload || wasStickingToBottom) {
          firstReload = false;
          scrollToVeryBottom();
        } else if (anchorRow) {
          const restored = listEl.querySelector(`[data-message-id="${CSS.escape(anchorRow)}"]`);
          if (restored) listEl.scrollTop = restored.getBoundingClientRect().top - listEl.getBoundingClientRect().top - anchorOffset + listEl.scrollTop;
        }
      }
      services.threads.markRead(spaceId, threadId).catch(() => {});
      const lastTs = messages[messages.length - 1]?.ts;
      if (lastTs) services.threads.publishReadReceipt(spaceId, threadId, lastTs).catch(() => {});
      refreshTicks(messages);
    }

    // Reactions live in a SEPARATE per-message collection (see
    // ThreadService.setReaction()'s doc comment), not the messages
    // collection reload() is already watching below - without this, a
    // reaction from another member would silently never appear here until
    // something ELSE happened to trigger a reload (e.g. this identity's
    // own next message). Keeps one watch per currently-known message id,
    // added as new messages appear; never removed (messages aren't
    // deleted in this app, so there's nothing to prune).
    function watchReactions(messages) {
      for (const message of messages) {
        if (reactionUnwatches.has(message.id)) continue;
        const path = paths.collectionPath(spaceId, paths.threadReactionsCollectionId(threadId, message.id));
        reactionUnwatches.set(message.id, watch(qu, path, reload, { initial: false }));
      }
    }

    // Read receipts (for the ✓✓ tick) live at fixed per-member paths, same
    // as presence - polled alongside it rather than watch()'d individually,
    // and update ONLY the tick elements in place (not a full reload()) so
    // someone else marking a message read doesn't reset scroll position or
    // interrupt an in-progress reaction-picker interaction.
    const tickEls = new Map(); // messageId -> tick <span>

    // Three-state sync/read indicator, per the user's own spec: locally
    // saved but not yet confirmed on the relay (1 tick + spinner) -> the
    // relay has it (2 ticks) -> a recipient's read receipt covers it (2
    // BLUE ticks). `pendingSyncIds` holds ids THIS device posted this
    // session that haven't been confirmed on the relay yet - see
    // confirmSync()'s own doc comment for why only just-posted messages
    // (not the whole history) get checked.
    const pendingSyncIds = new Set();

    function renderTickState(el, state) {
      el.dataset.state = state;
      el.title = state === 'pending' ? t('pendingSync') : state === 'read' ? t('readBy') : t('synced');
      el.textContent = '';
      const check = document.createElement('span');
      check.textContent = state === 'pending' ? '✓' : '✓✓';
      el.appendChild(check);
      if (state === 'pending') {
        const spinner = document.createElement('span');
        spinner.className = 'qu-chat-tick-spinner';
        spinner.textContent = '⟳';
        el.appendChild(spinner);
      }
    }

    function tickStateFor(messageId, isRead) {
      return isRead ? 'read' : pendingSyncIds.has(messageId) ? 'pending' : 'synced';
    }

    /**
     * There's no server ACK for "the relay received your broadcast" in this
     * sync protocol (writes are fire-and-forget broadcast - see
     * SyncEngine's own doc comment). fetch()ing the same path back FROM the
     * relay is the closest available proxy: a non-null response proves the
     * relay's copy exists, upgrading the tick from pending to synced. Only
     * called right after THIS device posts a message - re-checking the
     * whole history on every reload() would mean an unbounded burst of
     * fetch() calls on every mount, for no user-facing benefit (an old
     * message's sync state isn't something anyone is watching).
     */
    async function confirmSync(messageId, path) {
      if (!syncFetch) { pendingSyncIds.delete(messageId); const el = tickEls.get(messageId); if (el) renderTickState(el, tickStateFor(messageId, el.dataset.read === 'true')); return; }
      try {
        const quBit = await syncFetch(path);
        if (quBit) pendingSyncIds.delete(messageId);
      } catch {
        // timed out / relay unreachable - leave marked pending, matches reality
      }
      const el = tickEls.get(messageId);
      if (el) renderTickState(el, tickStateFor(messageId, el.dataset.read === 'true'));
    }

    async function refreshTicks(messages) {
      if (stopped || tickEls.size === 0) return;
      const receipts = await services.threads.getReadReceipts(spaceId, threadId, memberPubs.filter((p) => p !== myActorPub));
      if (stopped) return;
      const readUpTo = Math.max(0, ...Object.values(receipts));
      for (const message of messages) {
        const el = tickEls.get(message.id);
        if (!el || message.author !== myActorPub) continue;
        const isRead = readUpTo >= message.ts;
        el.dataset.read = String(isRead);
        renderTickState(el, tickStateFor(message.id, isRead));
      }
    }

    function renderPinnedBar(messages, pinnedIds) {
      pinnedBar.dataset.visible = String(pinnedIds.length > 0);
      pinnedBar.textContent = '';
      if (pinnedIds.length === 0) return;
      const topId = pinnedIds[pinnedIds.length - 1];
      const topMessage = messages.find((m) => m.id === topId);
      const jump = document.createElement('button');
      jump.type = 'button';
      jump.className = 'qu-chat-pinned-jump';
      const icon = document.createElement('span');
      icon.textContent = '📌';
      const textWrap = document.createElement('span');
      textWrap.className = 'qu-chat-pinned-jump-text';
      textWrap.textContent = topMessage ? (topMessage.body?.slice(0, 60) || attachmentPreviewLabel(topMessage.attachment)) : t('pinnedMessage');
      jump.append(icon, textWrap);
      jump.addEventListener('click', () => scrollToMessage(topId));
      pinnedBar.appendChild(jump);

      if (pinnedIds.length > 1) {
        const countBtn = document.createElement('button');
        countBtn.type = 'button';
        countBtn.className = 'qu-chat-pinned-count';
        countBtn.textContent = String(pinnedIds.length);
        countBtn.addEventListener('click', (e) => { e.stopPropagation(); openPinListPopup(messages, pinnedIds, countBtn); });
        pinnedBar.appendChild(countBtn);
      }
    }

    function openPinListPopup(messages, pinnedIds, anchorEl) {
      pinListPopupEl.textContent = '';
      for (const id of [...pinnedIds].reverse()) {
        const message = messages.find((m) => m.id === id);
        const row = document.createElement('div');
        row.className = 'qu-chat-pin-list-row';
        const text = document.createElement('span');
        text.className = 'qu-chat-pin-list-text';
        text.textContent = message ? (message.body?.slice(0, 60) || attachmentPreviewLabel(message.attachment)) : id;
        text.addEventListener('click', () => { closePopups(); scrollToMessage(id); });
        const unpinBtn = document.createElement('button');
        unpinBtn.type = 'button';
        unpinBtn.className = 'qu-chat-pin-list-unpin';
        unpinBtn.textContent = '✕';
        unpinBtn.title = t('unpin');
        unpinBtn.addEventListener('click', async () => { closePopups(); await services.threads.setPinned(spaceId, threadId, id, false); await reload(); });
        row.append(text, unpinBtn);
        pinListPopupEl.appendChild(row);
      }
      pinListPopupEl.hidden = false;
      positionPopup(pinListPopupEl, anchorEl.getBoundingClientRect());
    }

    /**
     * @param {string} messageId
     * @param {boolean} [isRetryable] - a permalink may target a message that
     *   hasn't synced to this device yet at the moment reload() first ran
     *   (see the `currentAnchorMessageId` branch above) - retry once after
     *   the backfill/sync has had a chance to land, instead of silently
     *   giving up.
     */
    function scrollToMessage(messageId, isRetryable, flash = true) {
      const row = listEl.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`);
      if (!row) {
        if (isRetryable) setTimeout(() => scrollToMessage(messageId, false, flash), 800);
        return;
      }
      // Jumping to a specific (possibly not-latest) message is exactly the
      // "not sticking to the bottom" case - without this, whatever caused
      // `stickingToBottom` to still read true (its default, if the user
      // never manually wheel/touch-scrolled this session) survives the
      // jump, and the NEXT reload() for any reason at all (someone else's
      // reaction on a totally different message, a new message, a pin
      // change - all of which call reload() via watch(), see
      // watchReactions() above) would call scrollToVeryBottom() and yank
      // the view straight back down, undoing the very navigation the user
      // just asked for - this was the reported "jumps back and forth,
      // can't stay on the message I clicked" bug.
      stickingToBottom = false;
      row.scrollIntoView({ block: 'center', behavior: 'smooth' });
      // `flash` is only true for a genuinely NEW navigation (a fresh
      // click/permalink visit - see its callers) - reload() re-invokes
      // this on every incidental re-render while the SAME anchor is still
      // active (the fix for the bug above), which for an already-in-view
      // row is a no-op scroll, not a real animation. Suppressing tracking
      // ONLY for the real, first jump - not for every one of those
      // incidental repeats too - matters because each call re-arms the
      // window from now: if reload() keeps firing in that window (which
      // it does routinely - read receipts, presence, someone else's
      // reactions), the window can get pushed out indefinitely and a
      // REAL "user scrolled to the bottom" event happening to land during
      // it would be silently ignored, leaving the anchor stuck in the URL
      // forever despite the view genuinely being at the bottom.
      if (flash) {
        suppressScrollTracking = true;
        setTimeout(() => {
          suppressScrollTracking = false;
          // The smooth-scroll animation this suppression window exists
          // for can easily SETTLE (fire its last 'scroll' event) before
          // the window itself closes - if so, there is no LATER scroll
          // event left to ever notice "actually, we ended up near the
          // bottom" once suppression lifts, and the anchor would stay
          // stuck in the URL forever despite the view genuinely being at
          // the bottom already. Checking once, right here, closes that
          // gap without needing another real scroll event to happen.
          if (isNearBottom()) { stickingToBottom = true; clearAnchor(); }
        }, 700);
        row.dataset.anchored = 'true';
        setTimeout(() => { row.dataset.anchored = 'false'; }, 1600);
      }
    }

    /** @returns {HTMLElement|null} A location-preview block if `body` is a recognized map URL, else null. */
    function locationBlock(body) {
      const loc = parseLocationFromUrl(body);
      if (!loc) return null;
      const a = document.createElement('a');
      a.className = 'qu-chat-location';
      a.href = body;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      const img = document.createElement('img');
      img.src = staticMapTileUrl(loc.lat, loc.lng);
      img.alt = '';
      img.addEventListener('error', () => img.remove());
      a.appendChild(img);
      const info = document.createElement('div');
      const label = document.createElement('div');
      label.textContent = t('location');
      const coords = document.createElement('div');
      coords.className = 'qu-chat-location-coords';
      coords.textContent = `${loc.lat.toFixed(5)}, ${loc.lng.toFixed(5)}`;
      info.append(label, coords);
      a.appendChild(info);
      return a;
    }

    async function messageRow(message, allMessages, isPinned) {
      const mine = message.author === myActorPub;
      const row = document.createElement('li');
      row.className = 'qu-chat-msg-row';
      row.dataset.mine = String(mine);
      row.dataset.messageId = message.id;

      // Two-tier bubble: `outer` is the loosely-tinted wrapper holding an
      // OPTIONAL header (alias - only needed to tell participants apart in
      // a group, or in 1:1 if the user opts in via Chat settings) and the
      // footer (reactions/time/read-tick/menu - everything that would
      // otherwise look lonely floating without a header); `bubble` is the
      // visually distinct inner message content itself.
      const outer = document.createElement('div');
      outer.className = 'qu-chat-msg-outer';

      if (isGroup || getChatSettings().showAliasIn1to1) {
        const headerRow = document.createElement('div');
        headerRow.className = 'qu-chat-msg-header';
        const authorEl = document.createElement('span');
        authorEl.className = 'qu-chat-msg-author';
        authorEl.textContent = mine ? t('you') : await nameFor(message.author);
        headerRow.appendChild(authorEl);
        outer.appendChild(headerRow);
      }

      const bubble = document.createElement('div');
      bubble.className = 'qu-chat-message';

      if (message.forwardedFrom) {
        const note = document.createElement('div');
        note.className = 'qu-chat-forward-note';
        const author = document.createElement('div');
        author.className = 'qu-chat-quote-author';
        author.textContent = t('forwardedFrom', { name: await nameFor(message.forwardedFrom.author) });
        note.appendChild(author);
        if (message.forwardedFrom.body) note.appendChild(document.createTextNode(message.forwardedFrom.body.slice(0, 100)));
        bubble.appendChild(note);
      }
      if (message.replyTo) {
        const quoted = allMessages.find((m) => m.id === message.replyTo);
        if (quoted) {
          const quote = document.createElement('div');
          quote.className = 'qu-chat-reply-quote';
          const author = document.createElement('div');
          author.className = 'qu-chat-quote-author';
          author.textContent = await nameFor(quoted.author);
          quote.appendChild(author);
          quote.appendChild(document.createTextNode(quoted.body?.slice(0, 80) || attachmentPreviewLabel(quoted.attachment)));
          quote.addEventListener('click', () => scrollToMessage(quoted.id));
          bubble.appendChild(quote);
        }
      }

      const locBlock = message.body ? locationBlock(message.body) : null;
      if (locBlock) {
        bubble.appendChild(locBlock);
      } else if (message.body) {
        const body = document.createElement('div');
        body.className = 'qu-chat-body';
        renderLinkedText(body, message.body);
        bubble.appendChild(body);
        const preview = buildLinkPreview(message.body);
        if (preview) bubble.appendChild(preview);
      }

      if (message.attachment) {
        const attEl = document.createElement('div');
        attEl.className = 'qu-chat-attachment';
        const isVoice = isVoiceMessageFilename(message.attachment.name);
        if (isVoice || message.attachment.mime?.startsWith('audio/')) {
          if (isVoice) { const label = document.createElement('div'); label.className = 'qu-chat-voice-label'; label.textContent = t('voiceMessage'); attEl.appendChild(label); }
          const audio = document.createElement('audio');
          audio.controls = true;
          services.assets.download(spaceId, message.attachment.assetId).then((asset) => {
            if (stopped || !asset) return;
            audio.src = URL.createObjectURL(new Blob([asset.data], { type: asset.meta.mime }));
          });
          attEl.appendChild(audio);
        } else if (message.attachment.mime?.startsWith('image/')) {
          const img = document.createElement('img');
          services.assets.download(spaceId, message.attachment.assetId).then((asset) => {
            if (stopped || !asset) return;
            const url = URL.createObjectURL(new Blob([asset.data], { type: asset.meta.mime }));
            img.src = url;
            img.addEventListener('click', () => openLightbox(url));
          });
          attEl.appendChild(img);
        } else if (message.attachment.mime?.startsWith('video/')) {
          const video = document.createElement('video');
          video.controls = true;
          services.assets.download(spaceId, message.attachment.assetId).then((asset) => {
            if (stopped || !asset) return;
            video.src = URL.createObjectURL(new Blob([asset.data], { type: asset.meta.mime }));
          });
          attEl.appendChild(video);
        } else {
          const link = document.createElement('a');
          link.textContent = `📎 ${message.attachment.name} (${fmtSize(message.attachment.size)})`;
          link.href = '#';
          link.addEventListener('click', async (e) => {
            e.preventDefault();
            const asset = await services.assets.download(spaceId, message.attachment.assetId);
            if (!asset) return;
            const url = URL.createObjectURL(new Blob([asset.data], { type: asset.meta.mime }));
            const a = document.createElement('a');
            a.href = url;
            a.download = asset.meta.name;
            a.click();
            URL.revokeObjectURL(url);
          });
          attEl.appendChild(link);
        }
        bubble.appendChild(attEl);
      }

      outer.appendChild(bubble);

      // Footer: reactions bottom-left, everything else (pin badge, edited
      // marker, permalink time, read tick, ⋮ menu) bottom-right - kept
      // OUTSIDE the header so it's always present even when the header
      // (alias) itself is hidden, per the "menu looks lonely without an
      // alias above it" feedback.
      const footer = document.createElement('div');
      footer.className = 'qu-chat-msg-footer';

      const reactions = await services.threads.getReactions(spaceId, threadId, message.id);
      const reactionEntries = Object.entries(reactions).filter(([, pubs]) => pubs.length > 0);
      const reactionsRow = document.createElement('div');
      reactionsRow.className = 'qu-chat-reactions';
      for (const [emoji, reactorPubs] of reactionEntries) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'qu-chat-reaction-chip';
        const mineReaction = reactorPubs.includes(myActorPub);
        chip.dataset.mine = String(mineReaction);
        chip.textContent = `${emoji} ${reactorPubs.length}`;
        chip.addEventListener('click', async () => {
          await services.threads.setReaction(spaceId, threadId, message.id, mineReaction ? null : emoji);
          await reload();
        });
        reactionsRow.appendChild(chip);
      }
      footer.appendChild(reactionsRow);

      const meta = document.createElement('div');
      meta.className = 'qu-chat-msg-meta';
      if (isPinned) {
        const pinBadge = document.createElement('span');
        pinBadge.className = 'qu-chat-msg-pin-badge';
        pinBadge.textContent = '📌';
        meta.appendChild(pinBadge);
      }
      if (message.editedAt) {
        const edited = document.createElement('span');
        edited.textContent = '✏️';
        meta.appendChild(edited);
      }
      const time = document.createElement('button');
      time.type = 'button';
      time.className = 'qu-chat-msg-time';
      time.textContent = fmtTime(message.ts);
      time.title = t('permalink');
      // "Klick auf die Zeit setzt den entsprechenden Anker" - clicking a
      // message's own timestamp turns it into this room's shareable
      // permalink (URL updated via history.replaceState, not
      // location.hash - see setAnchor()'s own doc comment above for why).
      time.addEventListener('click', (e) => { e.stopPropagation(); setAnchor(message.id); scrollToMessage(message.id); });
      meta.appendChild(time);
      if (mine) {
        const tick = document.createElement('span');
        tick.className = 'qu-chat-tick';
        tickEls.set(message.id, tick);
        renderTickState(tick, tickStateFor(message.id, false));
        meta.appendChild(tick);
      }
      // Always-visible "add a reaction" affordance, separate from the ⋮
      // menu's own "React" item - a dedicated one-tap icon instead of
      // menu → React being the only way in, matching the common
      // messenger pattern of a quick-react button living right next to
      // the existing reactions themselves.
      const quickReactBtn = document.createElement('button');
      quickReactBtn.type = 'button';
      quickReactBtn.className = 'qu-chat-msg-quick-react-btn';
      quickReactBtn.textContent = '🙂';
      quickReactBtn.title = t('react');
      quickReactBtn.addEventListener('click', (e) => { e.stopPropagation(); openReactionPopup(message, quickReactBtn); });
      meta.appendChild(quickReactBtn);

      const actionsBtn = document.createElement('button');
      actionsBtn.type = 'button';
      actionsBtn.className = 'qu-chat-msg-actions-btn';
      actionsBtn.textContent = '⋮';
      actionsBtn.title = t('more');
      actionsBtn.addEventListener('click', (e) => { e.stopPropagation(); openActionsMenu(message, allMessages, isPinned, actionsBtn); });
      meta.appendChild(actionsBtn);
      footer.appendChild(meta);

      outer.appendChild(footer);
      row.appendChild(outer);
      return row;
    }

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const body = input.value.trim();
      if (!body && !pendingFile) return;
      input.value = '';

      if (editTarget) {
        const editingId = editTarget.id;
        editTarget = null;
        renderComposerBanner();
        await services.threads.editMessage(spaceId, threadId, editingId, { body });
        await reload();
        return;
      }

      const extra = {};
      if (replyTo) extra.replyTo = replyTo.id; // also passed as the top-level param below - kept in sync, never diverging
      if (pendingFile) {
        // Encrypted for the SAME reader list as the message body sitting
        // next to it (readerPubsForEncryption === config.readers, or null
        // for a public/`*` thread) - see AssetService.upload()'s own doc
        // comment for how this closes the "attachment is the one
        // unencrypted part of an E2E thread" gap.
        const assetId = crypto.randomUUID();
        const meta = await services.assets.upload(spaceId, assetId, pendingFile, { readerPubs: readerPubsForEncryption });
        extra.attachment = { assetId, name: meta.name, mime: meta.mime, size: meta.size };
      }

      const replyToId = replyTo?.id ?? null;
      pendingFile = null;
      fileInput.value = '';
      pendingAttachmentEl.hidden = true;
      replyTo = null;
      renderComposerBanner();

      const posted = await services.threads.postMessage(spaceId, threadId, { body, replyTo: replyToId, extra });
      pendingSyncIds.add(posted.id);
      await reload({ forceScrollBottom: true });
      confirmSync(posted.id, paths.threadMessagePath(spaceId, threadId, posted.id));
    });

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        form.requestSubmit();
      }
    });

    await reload();
    unwatch = watch(qu, paths.collectionPath(spaceId, paths.threadMessagesCollectionId(threadId)), reload, { initial: false });
    unwatchPins = watch(qu, paths.collectionPath(spaceId, paths.threadPinsCollectionId(threadId)), reload, { initial: false });
    readReceiptTimer = setInterval(() => {
      services.threads.listMessages(spaceId, threadId).then((messages) => { if (!stopped) refreshTicks(messages); }).catch(() => {});
    }, READ_RECEIPT_POLL_MS);

    stopHeartbeat = services.threads.startHeartbeat(spaceId, threadId, { intervalMs: PRESENCE_HEARTBEAT_MS });
    async function refreshPresence() {
      if (stopped) return;
      const presence = await services.threads.getPresence(spaceId, threadId, memberPubs, { staleAfterMs: PRESENCE_STALE_MS });
      presenceEl.textContent = '';
      if (isGroup) {
        const onlineCount = memberPubs.filter((p) => p !== myActorPub && presence[p]?.online).length;
        membersToggle.textContent = t('membersOnline', { count: memberPubs.length, online: onlineCount });
        return;
      }
      const theirs = presence[target.peerActorPub];
      const dot = document.createElement('span');
      dot.className = 'qu-chat-presence-dot';
      dot.dataset.online = String(!!theirs?.online);
      const label = document.createElement('span');
      if (theirs?.online) label.textContent = t('online');
      else if (theirs?.lastSeen) label.textContent = t('lastSeen', { time: fmtTime(theirs.lastSeen) });
      else label.textContent = t('offline');
      presenceEl.append(dot, label);
    }
    await refreshPresence();
    presenceTimer = setInterval(refreshPresence, 5000);
  }

  return () => {
    stopped = true;
    unwatch?.();
    unwatchPins?.();
    for (const unwatchOne of reactionUnwatches.values()) unwatchOne();
    reactionUnwatches.clear();
    stopHeartbeat?.();
    if (presenceTimer) clearInterval(presenceTimer);
    if (readReceiptTimer) clearInterval(readReceiptTimer);
    for (const cleanup of roomCleanups) cleanup();
  };
}
