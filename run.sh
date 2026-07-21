#!/bin/bash
# Agent Deck — bring up (idempotent) the userspace Tailscale daemon + the app server.
# No root needed. Tailscale serve/funnel config persists in the daemon state, so it
# reapplies automatically once tailscaled is back. Run at boot via @reboot cron.
export PATH="/home/tris/.nvm/versions/node/v20.20.2/bin:/home/tris/.local/bin:/usr/bin:/bin:$PATH"
export ALLOWED_TG_USER=5964598698   # lock the API to Tris's Telegram user id only
SOCK=/home/tris/.tailscale/tailscaled.sock

# 1. userspace tailscaled
pgrep -f "tailscaled --tun=userspace-networking" >/dev/null 2>&1 || \
  nohup tailscaled --tun=userspace-networking \
    --statedir=/home/tris/.tailscale \
    --socket="$SOCK" >/tmp/tailscaled.log 2>&1 &

# 2. app server (Telegram-auth API + dashboard) on localhost
pgrep -f "node /home/tris/agent-deck/server.js" >/dev/null 2>&1 || \
  ( cd /home/tris/agent-deck && nohup node /home/tris/agent-deck/server.js >/tmp/agentdeck-server.log 2>&1 & )
