'use strict';

/*
 * PocketDesk server.
 *
 * Serves the touch-first web client and exposes:
 *   POST /api/connect  — verifies the web PIN, then mints an encrypted
 *                        guacamole-lite token describing an RDP connection
 *                        sized to the phone's exact native resolution.
 *   ws   /ws           — guacamole-lite WebSocket tunnel to guacd.
 */

const http = require('http');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const GuacamoleLite = require('guacamole-lite');

// ── Configuration ────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || '8080', 10);
const SECRET_KEY = process.env.SECRET_KEY || '';
const WEB_PIN = process.env.WEB_PIN || '';

if (SECRET_KEY.length !== 32) {
  console.error('SECRET_KEY must be exactly 32 characters (openssl rand -hex 16). Refusing to start.');
  process.exit(1);
}
if (WEB_PIN.length < 4) {
  console.error('WEB_PIN must be set (4+ characters). Refusing to start.');
  process.exit(1);
}

const RDP_DEFAULTS = {
  hostname: process.env.RDP_HOST || 'host.docker.internal',
  port: process.env.RDP_PORT || '3389',
  username: process.env.RDP_USERNAME || '',
  password: process.env.RDP_PASSWORD || '',
  security: process.env.RDP_SECURITY || 'any',
  audio: /^true$/i.test(process.env.RDP_AUDIO || 'false'),
};

const GUACD = {
  host: process.env.GUACD_HOST || '127.0.0.1',
  port: parseInt(process.env.GUACD_PORT || '4822', 10),
};

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error('PORT must be a valid TCP port. Refusing to start.');
  process.exit(1);
}
if (!Number.isInteger(GUACD.port) || GUACD.port < 1 || GUACD.port > 65535) {
  console.error('GUACD_PORT must be a valid TCP port. Refusing to start.');
  process.exit(1);
}

// ── Helpers ──────────────────────────────────────────────────────────────

function encryptToken(payload) {
  // guacamole-lite token format: base64(JSON{iv, value}) where value is the
  // AES-256-CBC encrypted JSON connection description.
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(SECRET_KEY, 'utf8'), iv);
  let value = cipher.update(JSON.stringify(payload), 'utf8', 'base64');
  value += cipher.final('base64');
  return Buffer.from(JSON.stringify({ iv: iv.toString('base64'), value })).toString('base64');
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function clampInt(value, min, max, fallback) {
  const n = typeof value === 'number'
    ? value
    : (typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN);
  if (!Number.isSafeInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function optionalString(value, fallback, maxLength = 256) {
  if (value === undefined || value === '') return fallback;
  if (typeof value !== 'string' || value.length > maxLength) return null;
  return value;
}

// Small in-memory brute-force guard for the PIN: 10 attempts / 15 min / IP.
const attempts = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const entry = attempts.get(ip);
  if (!entry || now > entry.resetAt) {
    attempts.set(ip, { count: 1, resetAt: now + 15 * 60 * 1000 });
    return false;
  }
  entry.count += 1;
  return entry.count > 10;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of attempts) if (now > entry.resetAt) attempts.delete(ip);
}, 60 * 1000).unref();

// Quality presets picked on the login screen.
const QUALITY = {
  sharp:    { 'color-depth': '24', 'enable-font-smoothing': 'true', 'enable-wallpaper': 'true'  },
  balanced: { 'color-depth': '16', 'enable-font-smoothing': 'true', 'enable-wallpaper': 'false' },
  data:     { 'color-depth': '16', 'enable-font-smoothing': 'false', 'enable-wallpaper': 'false' },
};

// ── HTTP app ─────────────────────────────────────────────────────────────

const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self' wss:",
    'Permissions-Policy': 'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  });
  next();
});
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/healthz', (req, res) => res.json({ ok: true }));

// Tells the client which fields it must ask the user for.
app.get('/api/config', (req, res) => {
  res.json({
    usernameConfigured: RDP_DEFAULTS.username !== '',
    passwordConfigured: RDP_DEFAULTS.password !== '',
  });
});

app.post('/api/connect', (req, res) => {
  const ip = req.socket.remoteAddress || 'unknown';
  if (rateLimited(ip)) {
    return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
  }

  const body = req.body;
  if (!isPlainObject(body) || typeof body.pin !== 'string' || body.pin.length === 0 || body.pin.length > 128) {
    return res.status(400).json({ error: 'Invalid connection request.' });
  }
  if (!safeEqual(body.pin, WEB_PIN)) {
    return res.status(401).json({ error: 'Wrong PIN.' });
  }

  const username = optionalString(body.username, RDP_DEFAULTS.username);
  const password = optionalString(body.password, RDP_DEFAULTS.password, 1024);
  if (username === null || password === null) {
    return res.status(400).json({ error: 'Invalid connection request.' });
  }
  attempts.delete(ip); // successful auth resets the counter

  // The whole point of PocketDesk: the session is created at the phone's
  // exact native pixel dimensions, so the desktop fits the screen perfectly.
  const width = clampInt(body.width, 320, 4096, 828);
  const height = clampInt(body.height, 320, 4096, 1792);
  const dpi = clampInt(body.dpi, 72, 300, 96);
  const quality = typeof body.quality === 'string' && QUALITY[body.quality]
    ? QUALITY[body.quality]
    : QUALITY.balanced;

  const settings = {
    hostname: RDP_DEFAULTS.hostname,
    port: RDP_DEFAULTS.port,
    username,
    password,
    security: RDP_DEFAULTS.security,
    'ignore-cert': 'true',
    width: String(width),
    height: String(height),
    dpi: String(dpi),
    // Ask the server to resize the session live (e.g. on phone rotation).
    'resize-method': 'display-update',
    'enable-touch': 'true',
    'disable-audio': RDP_DEFAULTS.audio ? 'false' : 'true',
    'enable-desktop-composition': 'false',
    'enable-full-window-drag': 'false',
    'enable-menu-animations': 'false',
    'enable-theming': 'true',
    ...quality,
  };

  const token = encryptToken({ connection: { type: 'rdp', settings } });
  res.json({ token });
});

app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ error: 'Invalid JSON body.' });
  }
  next(err);
});

// ── WebSocket tunnel ─────────────────────────────────────────────────────

const server = http.createServer(app);

const guacServer = new GuacamoleLite(
  { server, path: '/ws' },
  GUACD,
  {
    crypt: { cypher: 'AES-256-CBC', key: SECRET_KEY },
    log: { level: 'ERRORS' },
  }
);

guacServer.on('error', (clientConnection, error) => {
  console.error('guacamole-lite error:', error && (error.message || error));
});

server.listen(PORT, () => {
  console.log(`PocketDesk listening on :${PORT} (guacd at ${GUACD.host}:${GUACD.port}, RDP -> ${RDP_DEFAULTS.hostname}:${RDP_DEFAULTS.port})`);
});
