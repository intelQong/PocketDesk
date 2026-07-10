# PocketDesk 📱⌘

**Your Oracle Cloud VM, fitted to your iPhone like a native app.**

If you've ever tried using an Oracle free-tier VM from an iPhone through the
Windows App (Microsoft's RDP client), you know the pain: the desktop renders
at some arbitrary resolution and gets letterboxed or scaled into a blurry
mess, "touch mode" barely works, and you end up nudging a mouse pointer
around with your thumb like it's 2009.

PocketDesk fixes the problem at the root instead of fighting the client:

> **The remote session is created at your iPhone's exact native resolution
> and DPI.** There is nothing to scale. The desktop simply *is* your screen —
> edge to edge, pixel-perfect, with finger-sized touch targets.

You use it from Safari (or better, as a home-screen app — no App Store
needed), and it feels like the VM is running *on* the phone.

## What you get

| Pain with the Windows App | PocketDesk |
|---|---|
| Blurry scaling / letterboxing | Session created at your phone's native resolution — perfect fit, crisp text |
| Rotating the phone breaks the layout | The remote desktop itself re-sizes live on rotation (RDP display-update) |
| Touch mode barely works | Two real touch modes: **Direct** (tap = click, long-press = right-click) and **Touchpad** (whole screen is a trackpad with two-finger scroll) |
| No sane keyboard | iOS keyboard bridge + a key strip with Esc/Tab/Ctrl/Alt/arrows/Ctrl-Alt-Del and sticky modifiers for shortcuts like Ctrl+C |
| It's a heavy native app | A ~70 KB web client you "install" via *Add to Home Screen* |
| One-size resolution | Pick text size (Crisp / Comfy / Big) and quality (Sharp / Balanced / Data saver) per session |

Plus: clipboard sync in both directions, pinch-free zoom controls with
3-finger pan, screen wake-lock, auto-reconnect, and a PIN-protected,
rate-limited, HTTPS front door.

## How it works

```
 iPhone Safari / Home-screen app
        │  HTTPS + WebSocket (Guacamole protocol)
        ▼
 ┌────────────── your Oracle VM ──────────────┐
 │  Caddy (TLS) ──► PocketDesk (Node)         │
 │                      │ guacamole-lite      │
 │                      ▼                     │
 │                  guacd (Apache Guacamole)  │
 │                      │ RDP, localhost      │
 │                      ▼                     │
 │                  xrdp + XFCE desktop       │
 └────────────────────────────────────────────┘
```

When you tap **Connect**, the client measures your screen
(`window.innerWidth × devicePixelRatio`), the server mints an encrypted
one-time token describing an RDP session at *exactly* those dimensions, and
guacd opens it. Your phone's pixels and the VM's pixels map 1:1 (or 1.5:1 in
"Comfy" mode, which is the sweet spot for reading).

## Quick start

On the VM (Ubuntu or Oracle Linux), as a user with sudo:

```bash
git clone https://github.com/intelQong/RDP-IOS-Scaling-issue.git pocketdesk
cd pocketdesk

# Already have xrdp working? (you do, since you used the Windows App)
sudo bash setup.sh

# Fresh VM with no desktop yet?
sudo bash setup.sh --with-desktop
```

The script installs Docker if needed, generates secrets, opens the local
firewall, builds and starts everything, then prints your URL and PIN.

**One manual step (Oracle Cloud only):** open TCP **443** in the cloud
firewall — OCI Console → Networking → your VCN → Security Lists → **Add
Ingress Rule** (source `0.0.0.0/0`, destination port `443`). This is the same
thing you once did for port 3389. In fact, once PocketDesk works you can
*close* 3389 to the internet entirely — guacd talks to xrdp over localhost,
which is a real security upgrade.

### On the iPhone

1. Open `https://<your-vm-ip>` in Safari.
2. Accept the self-signed certificate (*Show Details → visit this website*).
   Want a green padlock instead? Point a free domain at the VM and set
   `SITE_ADDRESS=yourdomain.com` + `CADDY_TLS=you@email.com` in `.env`.
3. **Share → Add to Home Screen.** This is the magic step: PocketDesk now
   launches full-screen with no browser chrome, like a real app.
4. Tap the icon, enter your PIN (and VM password), Connect.

## Using it

| Gesture / control | Action |
|---|---|
| **Tap** | Left click (at your finger in Direct 👆 mode, at the cursor in Touchpad 🖱️ mode) |
| **Swipe one finger** | Scroll — content follows your finger like native iOS (Touchpad mode: moves the cursor) |
| **Long-press** | Right click |
| **Double-tap** | Double click |
| **Double-tap & hold** | Drag (keep holding and move) |
| **Pinch two fingers** | Zoom in/out |
| **Two-finger drag** | Scroll (trackpad style) |
| **Three-finger drag** | Pan around while zoomed in |
| ⌨️ | Summon the iOS keyboard (with the special-keys strip above it) |
| `ctrl` `alt` `shift` `⌘` keys | Sticky: tap `ctrl`, then tap `c` → sends Ctrl+C |
| ＋ / − | Zoom (then pan with **3 fingers**); zoom out to 100% snaps back to perfect fit |
| 📋 | Two-way clipboard: send text to the VM, or pull the VM's clipboard |
| Rotate the phone | The session itself re-sizes to the new dimensions after ~half a second |
| ⌘ bubble (top-right) | Re-open the toolbar when it's collapsed |

## Configuration

Everything lives in `.env` (see `.env.example`). Highlights:

- `RDP_PASSWORD` — leave empty (default) to type the VM password on the
  phone each session; it's then never stored on disk.
- `RDP_HOST` — defaults to the VM itself; point it at any other machine on
  the VCN to use PocketDesk as a jump box for a whole fleet.
- `RDP_SECURITY=nla` — if you ever target a real Windows machine instead of
  xrdp.
- `RDP_AUDIO=true` — pipe VM audio to the phone (costs bandwidth).

Apply changes with `docker compose up -d --build`.

## Troubleshooting

- **`ERR_SSL_PROTOCOL_ERROR` / "can't provide a secure connection"** →
  `SITE_ADDRESS` in `.env` must be your VM's **public IP** (or a domain),
  never a bare `:443` — with no name to issue a certificate for, Caddy
  aborts every TLS handshake. Fix:
  ```bash
  cd ~/pocketdesk && git pull
  sudo bash setup.sh        # auto-repairs SITE_ADDRESS/DEFAULT_SNI in .env
  ```
  or by hand: set `SITE_ADDRESS=<your-public-ip>` and
  `DEFAULT_SNI=<your-public-ip>` in `.env`, then
  `sudo docker compose up -d --force-recreate caddy`.
- **"Login failed" immediately** → wrong VM username/password, or the same
  user is logged in at the VM console (xrdp can't share a session — log out
  locally).
- **Black screen after login** → your `~/.xsession` should contain
  `startxfce4` (the `--with-desktop` installer sets this up).
- **Site never loads** → 99% of the time it's the OCI Security List ingress
  rule for port 443 (see Quick start). Check `docker compose ps` and
  `docker compose logs web caddy` on the VM.
- **Sluggish over mobile data** → pick **Data saver** + **Big** on the login
  screen; that quarters the pixels pushed over the network.
- **Keyboard quirks** → the key strip has Esc/Tab/arrows; sticky modifiers
  release automatically after the next key.

## Security notes

- Sessions require the PIN (rate-limited: 10 tries / 15 min / IP) and are
  carried over HTTPS/WSS only.
- Connection tokens are AES-256-CBC encrypted server-side secrets — the
  browser never sees RDP parameters, and tokens are minted per session.
- The web container runs as a non-root user; guacd and xrdp are never
  exposed to the internet.
- For belt-and-braces, run it over [Tailscale](https://tailscale.com) and
  bind `SITE_ADDRESS` to the tailnet IP — then nothing is public at all.

## Repo layout

```
├── docker-compose.yml     guacd + web + caddy
├── Caddyfile              HTTPS (self-signed by default, ACME optional)
├── setup.sh               one-command installer for the VM
├── .env.example           configuration template
└── server/
    ├── server.js          token minting, PIN auth, guacamole-lite tunnel
    ├── Dockerfile         builds the browser bundle + runs the server
    ├── vendor/            esbuild entry for guacamole-common-js
    └── public/            the touch-first client
        ├── index.html     login + viewer + toolbar + key strip
        ├── app.js         perfect-fit math, touch engine, keyboard bridge
        ├── style.css      iPhone-first UI (safe areas, 100dvh, dark)
        └── icons/         home-screen icons
```
