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
    buttons.forEach((b) => {
      const active = b.dataset.value === value;
      b.classList.toggle('active', active);
      b.setAttribute('aria-checked', String(active));
    });
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
  toast(touchMode === 'touch'
    ? 'Tap = click · swipe = scroll · hold = right-click · double-tap-hold = drag'
    : 'Touchpad: swipe moves cursor · tap = click · 2 fingers = scroll');
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

  // First time we know the real desktop size, park the pointer mid-screen.
  if (!cur.init && d.getWidth()) {
    cur.x = d.getWidth() / 2;
    cur.y = d.getHeight() / 2;
    cur.init = true;
  }

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
/*
 * One unified gesture engine instead of stacking Guacamole's Touchscreen +
 * Touchpad emulators (which fight over the same events). iPhone-native
 * semantics:
 *
 *   tap                  → left click        (at finger in direct mode,
 *                                             at cursor in touchpad mode)
 *   swipe (1 finger)     → scroll, content follows the finger
 *                          (in touchpad mode: moves the cursor instead)
 *   long-press           → right click
 *   double-tap (+hold)   → double click / hold & move = drag
 *   pinch (2 fingers)    → zoom in/out
 *   2-finger drag        → scroll (touchpad-style)
 *   3-finger drag        → pan the view while zoomed
 */

const GESTURE = {
  tapSlop: 12,        // css px a tap may wander before it becomes a swipe
  doubleTapMs: 300,
  doubleTapSlop: 40,
  longPressMs: 500,
  wheelStepPx: 30,    // css px of swipe per scroll-wheel tick
  pinchThreshold: 40, // css px of spread change before 2 fingers = pinch
  padSpeed: 1.4,      // touchpad cursor acceleration
};

const buttons = { left: false, middle: false, right: false };
const cur = { x: 0, y: 0, init: false };  // pointer position, remote px
let gesture = null;
let longPressTimer = null;
let lastTap = { time: 0, x: 0, y: 0 };

function remoteDims() {
  const d = client && client.getDisplay();
  if (!d || !d.getWidth()) return null;
  return { w: d.getWidth(), h: d.getHeight() };
}

// Map viewport (css) coordinates to remote-desktop pixels.
function toRemote(cssX, cssY) {
  const r = remoteDims();
  if (!r) return { x: 0, y: 0 };
  const rect = displayWrap.getBoundingClientRect();
  const sx = rect.width / r.w, sy = rect.height / r.h;
  return {
    x: Math.min(r.w - 1, Math.max(0, (cssX - rect.left) / (sx || 1))),
    y: Math.min(r.h - 1, Math.max(0, (cssY - rect.top) / (sy || 1))),
  };
}

function sendPointer() {
  if (!client || !connected) return;
  client.sendMouseState(new Guacamole.Mouse.State(
    cur.x, cur.y, buttons.left, buttons.middle, buttons.right, false, false));
}

function clickAt(which) {
  buttons[which] = true; sendPointer();
  buttons[which] = false; sendPointer();
}

function sendWheel(down) {
  if (!client || !connected) return;
  client.sendMouseState(new Guacamole.Mouse.State(
    cur.x, cur.y, buttons.left, buttons.middle, buttons.right, !down, down));
  sendPointer();
}

function releaseButtons() {
  if (buttons.left || buttons.middle || buttons.right) {
    buttons.left = buttons.middle = buttons.right = false;
    sendPointer();
  }
}

function pointAt(cssX, cssY) {
  // Direct mode: the pointer is wherever the finger is.
  // Touchpad mode: the pointer only moves via moveCursorBy().
  if (touchMode === 'touch') {
    const p = toRemote(cssX, cssY);
    cur.x = p.x; cur.y = p.y;
  }
}

function moveCursorBy(dx, dy) {
  const r = remoteDims();
  if (!r) return;
  const speed = (r.w / window.innerWidth) * GESTURE.padSpeed;
  cur.x = Math.min(r.w - 1, Math.max(0, cur.x + dx * speed));
  cur.y = Math.min(r.h - 1, Math.max(0, cur.y + dy * speed));
}

// Turn accumulated swipe distance into wheel ticks. Natural scrolling:
// finger up = wheel down (content follows the finger, like iOS).
function flushScroll(g) {
  while (g.scrollAccum <= -GESTURE.wheelStepPx) { sendWheel(true); g.scrollAccum += GESTURE.wheelStepPx; }
  while (g.scrollAccum >= GESTURE.wheelStepPx) { sendWheel(false); g.scrollAccum -= GESTURE.wheelStepPx; }
}

function pinchZoom(factor, centerX, centerY) {
  const nz = Math.min(8, Math.max(1, userZoom * factor));
  if (nz === userZoom) return;
  const f = nz / userZoom;
  panX = centerX - (centerX - panX) * f;
  panY = centerY - (centerY - panY) * f;
  userZoom = nz;
  applyTransform();
}

const dist2 = (t) => Math.hypot(t[1].clientX - t[0].clientX, t[1].clientY - t[0].clientY);
const mid2 = (t) => ({ x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 });

function onTouchStart(e) {
  e.preventDefault();
  clearTimeout(longPressTimer);
  const t = e.touches;

  if (t.length === 1) {
    const cssX = t[0].clientX, cssY = t[0].clientY;
    const now = performance.now();
    const isDouble = now - lastTap.time < GESTURE.doubleTapMs &&
      Math.hypot(cssX - lastTap.x, cssY - lastTap.y) < GESTURE.doubleTapSlop;
    gesture = { kind: isDouble ? 'drag' : 'pending', startX: cssX, startY: cssY, lastX: cssX, lastY: cssY, scrollAccum: 0 };
    if (isDouble) {
      // Double-tap: press immediately. A quick release = double click,
      // holding and moving = drag.
      pointAt(cssX, cssY);
      buttons.left = true;
      sendPointer();
      lastTap.time = 0;
    } else {
      longPressTimer = setTimeout(() => {
        if (gesture && gesture.kind === 'pending') {
          pointAt(cssX, cssY);
          clickAt('right');
          gesture.kind = 'done';
        }
      }, GESTURE.longPressMs);
    }
  } else if (t.length === 2) {
    releaseButtons();
    gesture = { kind: 'two', mode: null, d0: dist2(t), c0: mid2(t), lastD: dist2(t), lastC: mid2(t), scrollAccum: 0 };
  } else if (t.length >= 3) {
    releaseButtons();
    gesture = { kind: 'pan', offX: t[0].clientX - panX, offY: t[0].clientY - panY };
  }
}

function onTouchMove(e) {
  e.preventDefault();
  const g = gesture;
  if (!g) return;
  const t = e.touches;

  if (g.kind === 'pan' && t.length >= 3) {
    panX = t[0].clientX - g.offX;
    panY = t[0].clientY - g.offY;
    applyTransform();
    return;
  }

  if (g.kind === 'two' && t.length >= 2) {
    const d = dist2(t), c = mid2(t);
    if (!g.mode) {
      if (Math.abs(d - g.d0) > GESTURE.pinchThreshold) g.mode = 'pinch';
      else if (Math.hypot(c.x - g.c0.x, c.y - g.c0.y) > GESTURE.tapSlop) g.mode = 'scroll';
    }
    if (g.mode === 'pinch' && g.lastD > 0) {
      pinchZoom(d / g.lastD, c.x, c.y);
    } else if (g.mode === 'scroll') {
      pointAt(g.c0.x, g.c0.y);
      g.scrollAccum += c.y - g.lastC.y;
      flushScroll(g);
    }
    g.lastD = d; g.lastC = c;
    return;
  }

  if (t.length !== 1 || g.kind === 'done') return;
  const cssX = t[0].clientX, cssY = t[0].clientY;
  const dx = cssX - g.lastX, dy = cssY - g.lastY;
  g.lastX = cssX; g.lastY = cssY;

  if (g.kind === 'pending' &&
      Math.hypot(cssX - g.startX, cssY - g.startY) > GESTURE.tapSlop) {
    clearTimeout(longPressTimer);
    if (touchMode === 'touch') {
      g.kind = 'scroll1';
      pointAt(g.startX, g.startY);
    } else {
      g.kind = 'move';
    }
  }

  if (g.kind === 'drag') {
    if (touchMode === 'touch') pointAt(cssX, cssY);
    else moveCursorBy(dx, dy);
    sendPointer();
  } else if (g.kind === 'move') {
    moveCursorBy(dx, dy);
    sendPointer();
  } else if (g.kind === 'scroll1') {
    g.scrollAccum += dy;
    flushScroll(g);
  }
}

function onTouchEnd(e) {
  e.preventDefault();
  const g = gesture;
  if (e.touches.length > 0) {
    // A finger lifted but others remain — retire the gesture quietly.
    if (g && g.kind !== 'two' && g.kind !== 'pan') g.kind = 'done';
    return;
  }
  clearTimeout(longPressTimer);
  gesture = null;
  if (!g) return;

  if (g.kind === 'drag') {
    releaseButtons();
  } else if (g.kind === 'pending') {
    pointAt(g.startX, g.startY);
    clickAt('left');
    lastTap = { time: performance.now(), x: g.startX, y: g.startY };
  }
}

function onTouchCancel() {
  clearTimeout(longPressTimer);
  gesture = null;
  releaseButtons();
}

let touchAttached = false;
function attachInput() {
  cur.init = false;

  // The container persists across reconnects — attach touch handlers once.
  if (!touchAttached) {
    touchAttached = true;
    displayContainer.addEventListener('touchstart', onTouchStart, { passive: false });
    displayContainer.addEventListener('touchmove', onTouchMove, { passive: false });
    displayContainer.addEventListener('touchend', onTouchEnd, { passive: false });
    displayContainer.addEventListener('touchcancel', onTouchCancel, { passive: false });
  }

  // Desktop browsers / iPad trackpads get a normal mouse (the display
  // element is recreated per connection, so this attaches per-connect).
  // Touch never reaches it: our touchstart handlers call preventDefault,
  // which suppresses the browser's emulated-mouse compatibility events.
  const el = client.getDisplay().getElement();
  const mouse = new Guacamole.Mouse(el);
  mouse.onmousedown = mouse.onmousemove = mouse.onmouseup = (state) => {
    if (!client || !connected) return;
    const scale = client.getDisplay().getScale() || 1;
    cur.x = state.x / scale; cur.y = state.y / scale;
    client.sendMouseState(new Guacamole.Mouse.State(
      cur.x, cur.y, state.left, state.middle, state.right, state.up, state.down));
  };
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
    ? 'Direct: tap = click · swipe = scroll · hold = right-click'
    : 'Touchpad: swipe moves cursor · tap = click · 2 fingers = scroll');
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
