#!/usr/bin/env bash
#
# PocketDesk installer for an Oracle Cloud (or any) Linux VM.
#
#   sudo bash setup.sh                 # install PocketDesk
#   sudo bash setup.sh --with-desktop  # also install XFCE + xrdp first
#                                      # (for a fresh VM with no desktop yet)
#
set -euo pipefail

C_INFO='\033[1;36m'; C_OK='\033[1;32m'; C_WARN='\033[1;33m'; C_END='\033[0m'
info() { echo -e "${C_INFO}==>${C_END} $*"; }
ok()   { echo -e "${C_OK} ✔ ${C_END} $*"; }
warn() { echo -e "${C_WARN} ! ${C_END} $*"; }

[ "$(id -u)" -eq 0 ] || { echo "Run with sudo: sudo bash setup.sh"; exit 1; }
cd "$(dirname "$0")"

WITH_DESKTOP=false
[ "${1:-}" = "--with-desktop" ] && WITH_DESKTOP=true

# ── Package manager detection (Ubuntu vs Oracle Linux) ──────────────────
if command -v apt-get >/dev/null 2>&1; then PKG=apt
elif command -v dnf >/dev/null 2>&1; then PKG=dnf
else PKG=none; fi

# ── Optional: desktop + xrdp for a fresh VM ─────────────────────────────
if $WITH_DESKTOP; then
  info "Installing XFCE desktop + xrdp (this takes a few minutes)…"
  if [ "$PKG" = apt ]; then
    DEBIAN_FRONTEND=noninteractive apt-get update -y
    DEBIAN_FRONTEND=noninteractive apt-get install -y xfce4 xfce4-goodies xrdp
    # Make xrdp sessions start XFCE for every user
    echo "startxfce4" > /etc/skel/.xsession
    for home in /home/*; do
      [ -d "$home" ] && echo "startxfce4" > "$home/.xsession" && chown "$(basename "$home")": "$home/.xsession" || true
    done
  elif [ "$PKG" = dnf ]; then
    dnf -y groupinstall "Server with GUI" || dnf -y groupinstall "Xfce" || true
    dnf -y install xrdp
  fi
  systemctl enable --now xrdp
  ok "xrdp is running on port 3389 (localhost only is fine — guacd connects locally)"
fi

# ── Docker ───────────────────────────────────────────────────────────────
if ! command -v docker >/dev/null 2>&1; then
  info "Installing Docker…"
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
fi
docker compose version >/dev/null 2>&1 || { warn "docker compose plugin missing — trying package install"; \
  { [ "$PKG" = apt ] && apt-get install -y docker-compose-plugin; } || { [ "$PKG" = dnf ] && dnf -y install docker-compose-plugin; } || true; }
ok "Docker ready"

# ── Public IP (needed so Caddy issues its certificate for the right name) ─
PUBLIC_IP=$(curl -fsS -m 5 https://checkip.amazonaws.com 2>/dev/null | tr -d '[:space:]' || true)
[ -z "$PUBLIC_IP" ] && PUBLIC_IP=$(hostname -I | awk '{print $1}')
ok "Public IP: $PUBLIC_IP"

# ── .env generation ──────────────────────────────────────────────────────
if [ ! -f .env ]; then
  info "Creating .env…"
  SECRET_KEY=$(openssl rand -hex 16)
  DEFAULT_PIN=$(shuf -i 100000-999999 -n 1 2>/dev/null || openssl rand -hex 3)

  read -rp "Choose a web PIN (what you'll type on the phone) [$DEFAULT_PIN]: " WEB_PIN
  WEB_PIN=${WEB_PIN:-$DEFAULT_PIN}

  DETECTED_USER=$(logname 2>/dev/null || echo ubuntu)
  read -rp "VM username for RDP login [$DETECTED_USER]: " RDP_USERNAME
  RDP_USERNAME=${RDP_USERNAME:-$DETECTED_USER}

  sed -e "s|^SECRET_KEY=.*|SECRET_KEY=$SECRET_KEY|" \
      -e "s|^WEB_PIN=.*|WEB_PIN=$WEB_PIN|" \
      -e "s|^RDP_USERNAME=.*|RDP_USERNAME=$RDP_USERNAME|" \
      -e "s|^SITE_ADDRESS=.*|SITE_ADDRESS=$PUBLIC_IP|" \
      -e "s|^DEFAULT_SNI=.*|DEFAULT_SNI=$PUBLIC_IP|" \
      .env.example > .env
  chmod 600 .env
  ok ".env written (VM password is NOT stored — you type it on the phone)"
else
  ok ".env already exists — keeping it"
  # Repair configs from before SITE_ADDRESS/DEFAULT_SNI were auto-filled:
  # a bare ":443" (or missing value) breaks TLS with ERR_SSL_PROTOCOL_ERROR.
  if grep -Eq '^SITE_ADDRESS=(:443)?$|^SITE_ADDRESS=YOUR_PUBLIC_IP$' .env; then
    sed -i "s|^SITE_ADDRESS=.*|SITE_ADDRESS=$PUBLIC_IP|" .env
    warn "SITE_ADDRESS was ':443' — updated to $PUBLIC_IP so TLS works"
  fi
  if ! grep -q '^DEFAULT_SNI=' .env; then
    echo "DEFAULT_SNI=$PUBLIC_IP" >> .env
  elif grep -Eq '^DEFAULT_SNI=$|^DEFAULT_SNI=YOUR_PUBLIC_IP$' .env; then
    sed -i "s|^DEFAULT_SNI=.*|DEFAULT_SNI=$PUBLIC_IP|" .env
  fi
fi

# ── Local firewall (Oracle images ship restrictive rules) ───────────────
info "Opening ports 80/443 on the local firewall…"
if command -v firewall-cmd >/dev/null 2>&1 && systemctl is-active --quiet firewalld; then
  firewall-cmd --permanent --add-service=http --add-service=https >/dev/null
  firewall-cmd --reload >/dev/null
  ok "firewalld updated"
elif command -v iptables >/dev/null 2>&1; then
  for port in 80 443; do
    iptables -C INPUT -p tcp --dport "$port" -j ACCEPT 2>/dev/null || \
      iptables -I INPUT 5 -p tcp --dport "$port" -m state --state NEW -j ACCEPT 2>/dev/null || \
      iptables -I INPUT -p tcp --dport "$port" -m state --state NEW -j ACCEPT
  done
  command -v netfilter-persistent >/dev/null 2>&1 && netfilter-persistent save >/dev/null 2>&1 || \
    warn "Could not persist iptables rules — they may reset on reboot (install iptables-persistent)"
  ok "iptables updated"
fi

# ── Build & start ────────────────────────────────────────────────────────
info "Building and starting PocketDesk (first build downloads images)…"
docker compose up -d --build

WEB_PIN_SHOW=$(grep '^WEB_PIN=' .env | cut -d= -f2)

echo
echo -e "${C_OK}────────────────────────────────────────────────────────────${C_END}"
echo -e "${C_OK} PocketDesk is up! ${C_END}"
echo
echo -e "   On your iPhone, open:  ${C_INFO}https://${PUBLIC_IP}${C_END}"
echo -e "   Web PIN:               ${C_INFO}${WEB_PIN_SHOW}${C_END}"
echo
echo -e "   1. Safari will warn about the self-signed certificate —"
echo -e "      tap 'Show Details' → 'visit this website'."
echo -e "   2. Then Share → ${C_INFO}Add to Home Screen${C_END} for the full-screen app."
echo
echo -e "${C_WARN}   IMPORTANT (Oracle Cloud):${C_END} also open TCP 443 (and 80) in the"
echo -e "   cloud firewall: OCI Console → Networking → your VCN → Security"
echo -e "   Lists → Add Ingress Rule (source 0.0.0.0/0, dest port 443)."
echo -e "${C_OK}────────────────────────────────────────────────────────────${C_END}"
