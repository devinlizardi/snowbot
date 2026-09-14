#!/usr/bin/env bash
#
# One-time droplet setup. Run as root on a fresh Ubuntu 24.04 box:
#
#   curl -fsSL https://raw.githubusercontent.com/<owner>/snowbot/main/deploy/bootstrap.sh \
#     | sudo SNOWBOT_REPO=https://github.com/<owner>/snowbot.git bash
#
# Idempotent: every step checks before it acts, so re-running after a partial
# failure is safe. It deliberately stops short of anything secret — .env, the
# GCP key and the deploy public key are placed by hand afterwards (see the
# printed checklist and deploy/README.md).
set -euo pipefail

APP_DIR=/opt/snowbot
DEPLOY_USER=deploy

if [[ $EUID -ne 0 ]]; then
  echo "run me as root (sudo)" >&2
  exit 1
fi
if [[ -z "${SNOWBOT_REPO:-}" && ! -d "$APP_DIR/.git" ]]; then
  echo "set SNOWBOT_REPO=https://github.com/<owner>/snowbot.git (the public clone URL)" >&2
  exit 1
fi

say() { printf '\n==> %s\n' "$*"; }

export DEBIAN_FRONTEND=noninteractive

# ----------------------------------------------------------- base packages
say "apt: base packages"
apt-get update -qq
apt-get install -y -qq ca-certificates curl git gnupg ufw unattended-upgrades

# ---------------------------------------------------------------- docker
if ! command -v docker >/dev/null 2>&1; then
  say "docker: installing engine + compose plugin from download.docker.com"
  install -m 0755 -d /etc/apt/keyrings
  if [[ ! -f /etc/apt/keyrings/docker.asc ]]; then
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc
  fi
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
    >/etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin
else
  say "docker: already installed ($(docker --version))"
fi
systemctl enable --now docker >/dev/null

# Journald keeps container logs; cap them so a chatty week can't fill the disk.
if [[ ! -f /etc/docker/daemon.json ]]; then
  cat >/etc/docker/daemon.json <<'JSON'
{ "log-driver": "json-file", "log-opts": { "max-size": "20m", "max-file": "5" } }
JSON
  systemctl restart docker
fi

# ----------------------------------------------------------- deploy user
if ! id -u "$DEPLOY_USER" >/dev/null 2>&1; then
  say "user: creating $DEPLOY_USER"
  adduser --disabled-password --gecos 'snowbot deploy' "$DEPLOY_USER"
else
  say "user: $DEPLOY_USER exists"
fi
usermod -aG docker "$DEPLOY_USER"
install -d -m 0700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "/home/$DEPLOY_USER/.ssh"
touch "/home/$DEPLOY_USER/.ssh/authorized_keys"
chmod 0600 "/home/$DEPLOY_USER/.ssh/authorized_keys"
chown "$DEPLOY_USER:$DEPLOY_USER" "/home/$DEPLOY_USER/.ssh/authorized_keys"

# --------------------------------------------------------------- firewall
# Only SSH is reachable from outside. The healthz port is bound to 127.0.0.1
# by docker-compose, and this rule makes sure a future compose edit that
# drops the loopback prefix still doesn't expose it.
say "ufw: ssh only"
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow OpenSSH >/dev/null
ufw allow from 127.0.0.1 to any port 8080 proto tcp >/dev/null
ufw deny 8080/tcp >/dev/null
ufw --force enable >/dev/null
ufw status | sed 's/^/    /'

# -------------------------------------------------------- unattended-upgrades
say "unattended-upgrades: security updates on, reboots at 05:00 if needed"
cat >/etc/apt/apt.conf.d/20auto-upgrades <<'CONF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
CONF
cat >/etc/apt/apt.conf.d/52snowbot-unattended <<'CONF'
Unattended-Upgrade::Remove-Unused-Dependencies "true";
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "05:00";
CONF
systemctl enable --now unattended-upgrades >/dev/null

# ----------------------------------------------------------------- repo
if [[ ! -d "$APP_DIR/.git" ]]; then
  say "repo: cloning $SNOWBOT_REPO → $APP_DIR"
  git clone "$SNOWBOT_REPO" "$APP_DIR"
else
  say "repo: $APP_DIR already cloned"
fi
# The deploy workflow runs `git pull` as the deploy user, so the checkout is his.
chown -R "$DEPLOY_USER:$DEPLOY_USER" "$APP_DIR"

# data/ is written by uid 10001 inside the container (see Dockerfile); secrets/
# is read-only-mounted, so it only needs to be readable by root and deploy.
install -d -m 0700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$APP_DIR/secrets"
install -d -m 0755 -o 10001 -g "$DEPLOY_USER" "$APP_DIR/data"

# ------------------------------------------------------------- next steps
cat <<EOF

bootstrap done. Remaining steps are manual on purpose — they all involve secrets:

  1. Add the *fresh* deploy public key (not your personal snowbot key) so
     GitHub Actions — and you, below — can SSH in as $DEPLOY_USER
     (the account is created with an empty authorized_keys):
       cat snowbot-deploy.pub >> /home/$DEPLOY_USER/.ssh/authorized_keys
     Then put the private half in the repo's DROPLET_SSH_KEY secret, the
     droplet's IP in DROPLET_IP, and "$DEPLOY_USER" in DROPLET_USER.

  2. Copy the filled-in .env (as $DEPLOY_USER with that key, or as root then chown to $DEPLOY_USER):
       scp .env $DEPLOY_USER@<droplet>:$APP_DIR/.env
       chmod 0600 $APP_DIR/.env
     Set SNOWBOT_CHANNEL=real in it only once the test channel has been quiet
     for a full week.

  3. Place the GCP service-account key:
       scp gcp.json $DEPLOY_USER@<droplet>:$APP_DIR/secrets/gcp.json
       chmod 0400 $APP_DIR/secrets/gcp.json
     Nothing else goes in secrets/.

  4. First run, as $DEPLOY_USER:
       cd $APP_DIR && docker compose build
       docker compose run --rm snowbot job=noop --dry-run
       docker compose up -d && curl -s localhost:8080/healthz

The full runbook is in $APP_DIR/deploy/README.md.
EOF
