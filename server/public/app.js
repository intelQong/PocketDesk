'use strict';

/*
 * PocketDesk client.
 *
 * The core idea: instead of scaling a desktop-sized RDP session down to a
 * phone (the thing that makes the Windows App miserable), we create the RDP
 * session AT the phone's exact native resolution and matching DPI. The
 * desktop then fits the screen perfectly, text is crisp, and touch targets
 * are finger-sized.
 */

/* ── DOM ────────────────────────────────────────────────────────────── */

const $ = (id) => document.getElementById(id);

const loginScreen = $('login');
const viewerScreen = $('viewer');
const loginForm = $('login-form');
const loginError = $('login-error');
const fitInfo = $('fit-info');
const credFields = $('cred-fields');
const displayContainer = $('display-container');
const displayWrap = $('display-wrap');
const kbdEl = $('kbd-capture');
const statusOverlay = $('status-overlay');
const statusText = $('status-text');
const statusSpinner = $('status-spinner');
const statusAction = $('status-action');
const statusExit = $('status-exit');
const toolbar = $('toolbar');
const toolbarHandle = $('toolbar-handle');
const keysbar = $('keysbar');
const clipSheet = $('clip-sheet');
const toastEl = $('toast');

/* ── State ──────────────────────────────────────────────────────────── */

let client = null;          // Guacamole.Client
let tunnel = null;          // Guacamole.WebSocketTunnel
let connected = false;
let intentionalDisconnect = false;
let autoRetriesLeft = 0;
let lastCreds = null;       // kept in memory only, never persisted
let lastError = null;

let touchMode = localStorage.getItem('pd.touchMode') || 'touch'; // 'touch' | 'touchpad'
let userZoom = 1;
let panX = 0, panY = 0;
let remoteClipboard = '';
let wakeLock = null;

const prefs = {
  quality: localStorage.getItem('pd.quality') || 'balanced',
  rescale: localStorage.getItem('pd.rescale') || 'mid',
  username: localStorage.getItem('pd.username') || '',
};

/* ── Resolution: the "perfect fit" math ─────────────────────────────── */

// How many remote pixels per CSS pixel. "native" = iPhone-crisp (2x on an
// iPhone 11), "big" = larger UI, "mid" = the sweet spot.
function resolutionScale() {
  const dpr = window.devicePixelRatio || 1;
  switch (prefs.rescale) {
    case 'native': return dpr;
    case 'big': return 1;
    default: return Math.min(dpr, 1.5);
  }
}

function sessionSize() {
  const s = resolutionScale();
  return {
    width: Math.round(window.innerWidth * s),
    height: Math.round(window.innerHeight * s),
    dpi: Math.round(96 * s),
  };
}

function updateFitInfo() {
  const { width, height } = sessionSize();
  fitInfo.textContent = `${window.innerWidth}×${window.innerHeight} → ${width}×${height}`;
}

/* ── Small UI helpers ───────────────────────────────────────────────── */

let toastTimer = null;
function toast(msg, ms = 2200) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, ms);
}

function showStatus(text, { spinner = true, action = null } = {}) {
  statusText.textContent = text;
  statusSpinner.style.display = spinner ? '' : 'none';
  statusAction.hidden = !action;
  if (action) statusAction.textContent = action;
  statusOverlay.hidden = false;
}

function hideStatus() { statusOverlay.hidden = true; }

function setupSegmented(id, initial, onChange) {
  const group = $(id);
  const buttons = Array.from(group.querySelectorAll('button'));
  const select = (value) => {
    buttons.forEach((b) => b.classList.toggle('active', b.dataset.value === value));
    onChange(value);
  };
  buttons.forEach((b) => b.addEventListener('click', () => select(b.dataset.value)));
  select(initial);
}

/* ── Login ──────────────────────────────────────────────────────────── */

setupSegmented('quality', prefs.quality, (v) => {
  prefs.quality = v; localStorage.setItem('pd.quality', v);
});
setupSegmented('rescale', prefs.rescale, (v) => {
  prefs.rescale = v; localStorage.setItem('pd.rescale', v); updateFitInfo();
});
updateFitInfo();
window.addEventListener('resize', updateFitInfo);

if (navigator.standalone) $('pwa-hint').hidden = true;
$('rdp-user').value = prefs.username;

fetch('/api/config')
  .then((r) => r.json())
  .then((cfg) => {
    // Only ask for VM credentials if the server doesn't already know them.
    if (!cfg.usernameConfigured || !cfg.passwordConfigured) credFields.hidden = false;
  })
  .catch(() => { credFields.hidden = false; });

loginForm.addEventListener('submit', (e) => {
  e.preventDefault();
  loginError.hidden = true;
  const creds = {
    pin: $('pin').value,
    username: $('rdp-user').value.trim(),
    password: $('rdp-pass').value,
  };
  localStorage.setItem('pd.username', creds.username);
  connect(creds);
});

/* ── Connection lifecycle ───────────────────────────────────────────── */

async function connect(creds) {
  lastCreds = creds;
  lastError = null;
  intentionalDisconnect = false;

  loginScreen.hidden = true;
  viewerScreen.hidden = false;
  showStatus('Connecting…');

  const size = sessionSize();
  let token;
  try {
    const res = await fetch('/api/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...creds, ...size, quality: prefs.quality }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Server error (${res.status})`);
    token = body.token;
  } catch (err) {
    return failToLogin(err.message || 'Could not reach the server.');
  }

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  tunnel = new Guacamole.WebSocketTunnel(`${proto}://${location.host}/ws`);
  client = new Guacamole.Client(tunnel);

  displayWrap.innerHTML = '';
  displayWrap.appendChild(client.getDisplay().getElement());

  client.onstatechange = (state) => {
    switch (state) {
      case 3: onConnected(); break;         // CONNECTED
      case 5: onDisconnected(); break;      // DISCONNECTED
    }
  };
  client.onerror = (status) => { lastError = status; };
  tunnel.onerror = (status) => { lastError = status; };
  client.onclipboard = readRemoteClipboard;
  client.getDisplay().onresize = applyTransform;

  attachInput();
  client.connect('token=' + encodeURIComponent(token));
}

function onConnected() {
  connected = true;
  autoRetriesLeft = 2;
  userZoom = 1; panX = 0; panY = 0;
  hideStatus();
  applyTransform();
  applyTouchMode();
  requestWakeLock();
  toast(touchMode === 'touch' ? 'Direct touch — tap = click, hold = right-click' : 'Touchpad mode');
}

function onDisconnected() {
  const wasConnected = connected;
  connected = false;
  releaseWakeLock();

  if (intentionalDisconnect) return backToLogin();

  const detail = describeError(lastError);
  if (wasConnected && autoRetriesLeft > 0 && document.visibilityState === 'visible') {
    autoRetriesLeft -= 1;
    showStatus('Connection dropped — reconnecting…');
    setTimeout(() => { if (!connected && !intentionalDisconnect) connect(lastCreds); }, 1500);
  } else {
    showStatus(detail, { spinner: false, action: 'Reconnect' });
  }
}

function describeError(status) {
  if (!status) return 'Disconnected.';
  const code = status.code;
  const hints = {
    0x0201: 'The VM refused the connection — is xrdp running?',
    0x0301: 'Login failed — check the VM username and password.',
    0x0303: 'The VM denied access — check the VM username and password.',
    0x0308: 'Connection timed out.',
  };
  const base = hints[code] || status.message || 'Connection error.';
  return code ? `${base} (code 0x${code.toString(16)})` : base;
}

function failToLogin(message) {
  viewerScreen.hidden = true;
  loginScreen.hidden = false;
  loginError.textContent = message;
  loginError.hidden = false;
}

function disconnect() {
  intentionalDisconnect = true;
  try { if (client) client.disconnect(); } catch (e) { /* already down */ }
  backToLogin();
}

function backToLogin() {
  releaseWakeLock();
  hideKeyboard();
  clipSheet.hidden = true;
  toolbar.hidden = true;
  viewerScreen.hidden = true;
  loginScreen.hidden = false;
  displayWrap.innerHTML = '';
  client = null; tunnel = null; connected = false;
  $('pin').focus();
}

statusAction.addEventListener('click', () => { if (lastCreds) connect(lastCreds); });
statusExit.addEventListener('click', disconnect);

/* ── Display scaling, zoom & pan ────────────────────────────────────── */

function fitScale() {
  const d = client.getDisplay();
  if (!d.getWidth() || !d.getHeight()) return 1;
  return Math.min(window.innerWidth / d.getWidth(), window.innerHeight / d.getHeight());
}

function applyTransform() {
  if (!client) return;
  const d = client.getDisplay();
  const scale = fitScale() * userZoom;
  d.scale(scale);

  const w = d.getWidth() * scale;
  const h = d.getHeight() * scale;
  displayWrap.style.width = w + 'px';
  displayWrap.style.height = h + 'px';

  // Center when it fits; clamp panning when zoomed in.
  const vw = window.innerWidth, vh = window.innerHeight;
  panX = w <= vw ? (vw - w) / 2 : Math.min(0, Math.max(vw - w, panX));
  panY = h <= vh ? (vh - h) / 2 : Math.min(0, Math.max(vh - h, panY));
  displayWrap.style.transform = `translate(${panX}px, ${panY}px)`;
}

function zoom(factor) {
  userZoom = Math.min(8, Math.max(1, userZoom * factor));
  if (userZoom === 1) { panX = 0; panY = 0; }
  applyTransform();
  toast(userZoom === 1 ? 'Fit to screen' : `Zoom ${Math.round(userZoom * 100)}% — pan with 3 fingers`);
}

// Rotating the phone re-sizes the actual remote session (via the RDP
// display-update channel), so the desktop always fits — portrait or
// landscape.
let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (!client || !connected) return;
    const { width, height } = sessionSize();
    try { client.sendSize(width, height); } catch (e) { /* not supported */ }
    applyTransform();
  }, 400);
});

/* ── Touch input ────────────────────────────────────────────────────── */

let touchscreen = null;
let touchpad = null;

function sendScaledMouseState(state) {
  if (!client || !connected) return;
  const scale = client.getDisplay().getScale() || 1;
  client.sendMouseState(new Guacamole.Mouse.State(
    (state.x - 0) / scale, (state.y - 0) / scale,
    state.left, state.middle, state.right, state.up, state.down
  ));
}

function attachInput() {
  const el = client.getDisplay().getElement();

  // Direct mode: the screen is a touchscreen. Tap = left click where you
  // tap, long-press = right click, drag after a press = drag.
  touchscreen = new Guacamole.Mouse.Touchscreen(el);
  touchscreen.onmousedown = touchscreen.onmousemove = touchscreen.onmouseup = (s) => {
    if (touchMode === 'touch') sendScaledMouseState(s);
  };

  // Touchpad mode: the whole screen is a laptop trackpad with acceleration,
  // tap-to-click and two-finger scroll. Great for tiny desktop UI.
  touchpad = new Guacamole.Mouse.Touchpad(el);
  touchpad.onmousedown = touchpad.onmousemove = touchpad.onmouseup = (s) => {
    if (touchMode === 'touchpad') sendScaledMouseState(s);
  };

  // Three-finger pan while zoomed in (capture phase so it wins over the
  // mouse emulators).
  let panStart = null;
  displayContainer.addEventListener('touchstart', (e) => {
    if (e.touches.length === 3) {
      panStart = { x: e.touches[0].clientX - panX, y: e.touches[0].clientY - panY };
      e.preventDefault(); e.stopPropagation();
    }
  }, { capture: true, passive: false });
  displayContainer.addEventListener('touchmove', (e) => {
    if (panStart && e.touches.length === 3) {
      panX = e.touches[0].clientX - panStart.x;
      panY = e.touches[0].clientY - panStart.y;
      applyTransform();
      e.preventDefault(); e.stopPropagation();
    }
  }, { capture: true, passive: false });
  displayContainer.addEventListener('touchend', () => { panStart = null; }, true);

  // Desktop browsers / iPad trackpads get a normal mouse too.
  const mouse = new Guacamole.Mouse(el);
  mouse.onmousedown = mouse.onmousemove = mouse.onmouseup = sendScaledMouseState;
}

function applyTouchMode() {
  const tbMode = $('tb-mode');
  tbMode.textContent = touchMode === 'touch' ? '👆' : '🖱️';
  try { client.getDisplay().showCursor(touchMode === 'touchpad'); } catch (e) { /* ok */ }
  localStorage.setItem('pd.touchMode', touchMode);
}

/* ── Keyboard bridge ────────────────────────────────────────────────── */

const KEYSYM = {
  esc: 0xFF1B, tab: 0xFF09, enter: 0xFF0D, backspace: 0xFF08, del: 0xFFFF,
  left: 0xFF51, up: 0xFF52, right: 0xFF53, down: 0xFF54,
  home: 0xFF50, end: 0xFF57, pgup: 0xFF55, pgdn: 0xFF56,
  ctrl: 0xFFE3, shift: 0xFFE1, alt: 0xFFE9, super: 0xFFEB,
};

const latchedMods = new Set();

function sendKey(pressed, keysym) {
  if (client && connected) client.sendKeyEvent(pressed ? 1 : 0, keysym);
}

function pressKey(keysym) {
  sendKey(1, keysym);
  sendKey(0, keysym);
  releaseOneShotMods();
}

function toggleMod(name) {
  const keysym = KEYSYM[name];
  if (latchedMods.has(name)) {
    latchedMods.delete(name);
    sendKey(0, keysym);
  } else {
    latchedMods.add(name);
    sendKey(1, keysym);
  }
  updateModUI();
}

function releaseOneShotMods() {
  for (const name of latchedMods) sendKey(0, KEYSYM[name]);
  latchedMods.clear();
  updateModUI();
}

function updateModUI() {
  keysbar.querySelectorAll('button[data-mod]').forEach((b) => {
    b.classList.toggle('latched', latchedMods.has(b.dataset.mod));
  });
}

function charKeysym(codepoint) {
  // X11 keysym rules: Latin-1 maps directly, everything else is
  // 0x01000000 | codepoint.
  return codepoint < 0x100 ? codepoint : 0x01000000 | codepoint;
}

function typeString(str) {
  for (const ch of str) {
    if (ch === '\n' || ch === '\r') { pressKey(KEYSYM.enter); continue; }
    const keysym = charKeysym(ch.codePointAt(0));
    sendKey(1, keysym);
    sendKey(0, keysym);
  }
  releaseOneShotMods();
}

// iOS software keyboards don't produce reliable keydown events, but they do
// produce `beforeinput`. We intercept it, forward the intent to the VM, and
// keep the hidden textarea permanently empty.
kbdEl.addEventListener('beforeinput', (e) => {
  e.preventDefault();
  switch (e.inputType) {
    case 'insertText':
    case 'insertFromPaste':
    case 'insertCompositionText':
      if (e.data) typeString(e.data);
      break;
    case 'insertLineBreak':
    case 'insertParagraph':
      pressKey(KEYSYM.enter);
      break;
    case 'deleteContentBackward':
      pressKey(KEYSYM.backspace);
      break;
    case 'deleteContentForward':
      pressKey(KEYSYM.del);
      break;
  }
});
kbdEl.addEventListener('input', () => { kbdEl.value = ''; });

// If iOS dismisses the keyboard on its own (its hide button), keep our
// toggle state in sync so the next ⌨️ tap re-opens it instead of no-op'ing.
kbdEl.addEventListener('blur', () => { keyboardOpen = false; });

// Hardware (Bluetooth) keyboards send real key events — handle everything
// non-printable here and let printable characters flow through beforeinput.
const hwKeyboard = new Guacamole.Keyboard(kbdEl);
const hwHandled = new Set();

function keysymPrintable(keysym) {
  return (keysym >= 0x20 && keysym <= 0xFF) || (keysym & 0xFFFF0000) === 0x01000000;
}

// NOTE on return values: Guacamole.Keyboard's onkeydown returns true to
// let the event THROUGH to the browser, false to CONSUME it.
hwKeyboard.onkeydown = (keysym) => {
  // Plain printable keys: allow the browser default so the character lands
  // in the textarea and the beforeinput handler above forwards it (this
  // also keeps iOS autocorrect/dictation working).
  if (keysymPrintable(keysym) && latchedMods.size === 0) return true;
  // Special keys and modifier combos: send directly and consume the event
  // so the browser doesn't also act on it.
  sendKey(1, keysym);
  hwHandled.add(keysym);
  if (keysymPrintable(keysym)) releaseOneShotMods();
  return false;
};
hwKeyboard.onkeyup = (keysym) => {
  if (hwHandled.delete(keysym)) sendKey(0, keysym);
};

/* Keyboard show/hide + keeping the keys bar glued above the iOS keyboard */

let keyboardOpen = false;

function showKeyboard() {
  keysbar.hidden = false;
  // iOS only raises the software keyboard when focus() runs synchronously
  // inside the user gesture, with no options object and on a real, visible,
  // editable element (see #kbd-capture styling). Don't pass preventScroll.
  kbdEl.value = '';
  kbdEl.focus();
  keyboardOpen = true;
  positionKeysbar();
}

function hideKeyboard() {
  keysbar.hidden = true;
  kbdEl.blur();
  keyboardOpen = false;
}

function positionKeysbar() {
  const vv = window.visualViewport;
  if (!vv) return;
  const covered = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
  keysbar.style.bottom = covered + 'px';
}
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', positionKeysbar);
  window.visualViewport.addEventListener('scroll', positionKeysbar);
}

// Keys-bar buttons must not steal focus from the hidden textarea, or the
// iOS keyboard would close on every tap.
keysbar.addEventListener('pointerdown', (e) => e.preventDefault());
keysbar.addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  if (btn.dataset.mod) return toggleMod(btn.dataset.mod);
  const key = btn.dataset.key;
  if (key === 'cad') {
    sendKey(1, KEYSYM.ctrl); sendKey(1, KEYSYM.alt); sendKey(1, KEYSYM.del);
    sendKey(0, KEYSYM.del); sendKey(0, KEYSYM.alt); sendKey(0, KEYSYM.ctrl);
    return;
  }
  if (KEYSYM[key]) pressKey(KEYSYM[key]);
});

/* ── Clipboard ──────────────────────────────────────────────────────── */

function readRemoteClipboard(stream, mimetype) {
  if (!/^text\//.test(mimetype)) { stream.sendAck('Only text supported', 0x0100); return; }
  const reader = new Guacamole.StringReader(stream);
  let data = '';
  reader.ontext = (text) => { data += text; };
  reader.onend = () => { remoteClipboard = data; };
}

function sendClipboardText(text) {
  if (!client || !connected) return;
  const stream = client.createClipboardStream('text/plain');
  const writer = new Guacamole.StringWriter(stream);
  writer.sendText(text);
  writer.sendEnd();
}

$('clip-send').addEventListener('click', () => {
  const text = $('clip-text').value;
  if (text) { sendClipboardText(text); toast('Sent to VM clipboard — paste over there'); }
  clipSheet.hidden = true;
});
$('clip-fetch').addEventListener('click', async () => {
  $('clip-text').value = remoteClipboard;
  if (remoteClipboard && navigator.clipboard && navigator.clipboard.writeText) {
    try { await navigator.clipboard.writeText(remoteClipboard); toast('Copied to iPhone clipboard'); }
    catch (e) { toast('Shown below — copy manually'); }
  } else if (!remoteClipboard) {
    toast('VM clipboard is empty (copy something there first)');
  }
});
$('clip-close').addEventListener('click', () => { clipSheet.hidden = true; });

/* ── Toolbar ────────────────────────────────────────────────────────── */

toolbarHandle.addEventListener('click', () => {
  toolbar.hidden = false;
  toolbarHandle.hidden = true;
});
$('tb-collapse').addEventListener('click', () => {
  toolbar.hidden = true;
  toolbarHandle.hidden = false;
});
$('tb-keyboard').addEventListener('click', () => {
  if (keyboardOpen) hideKeyboard(); else showKeyboard();
});
$('tb-mode').addEventListener('click', () => {
  touchMode = touchMode === 'touch' ? 'touchpad' : 'touch';
  applyTouchMode();
  toast(touchMode === 'touch'
    ? 'Direct touch: tap = click, hold = right-click'
    : 'Touchpad: swipe to move, tap to click, 2 fingers to scroll');
});
$('tb-keys').addEventListener('click', () => { keysbar.hidden = !keysbar.hidden; positionKeysbar(); });
$('tb-zoom-in').addEventListener('click', () => zoom(1.25));
$('tb-zoom-out').addEventListener('click', () => zoom(0.8));
$('tb-clip').addEventListener('click', () => { clipSheet.hidden = false; });
$('tb-disconnect').addEventListener('click', disconnect);

/* ── Screen wake lock (keep the phone awake while connected) ────────── */

async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
  } catch (e) { /* fine without it */ }
}
function releaseWakeLock() {
  try { if (wakeLock) { wakeLock.release(); wakeLock = null; } } catch (e) { /* ok */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && connected) requestWakeLock();
});
