#!/bin/bash
# Run this AFTER completing the Tailscale login link. Binds the tailnet's private
# HTTPS to the local Agent Deck server and prints your permanent private URL.
# Tailnet-only (Tailscale Serve): reachable solely from your own devices.
export PATH="/home/tris/.local/bin:/home/tris/.nvm/versions/node/v20.20.2/bin:/usr/bin:/bin:$PATH"
SOCK=/home/tris/.tailscale/tailscaled.sock
TS="tailscale --socket=$SOCK"

state=$($TS status --json 2>/dev/null | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d).BackendState)}catch{console.log("ERR")}})')
if [ "$state" != "Running" ]; then
  echo "Tailscale is not logged in yet (state=$state)."
  $TS status 2>&1 | grep -i 'log in' || true
  exit 1
fi

# make sure the app server is up
/home/tris/agent-deck/run.sh
sleep 1

# bind tailnet HTTPS (443) -> local server; config persists in the daemon state
$TS serve --bg http://127.0.0.1:8787 2>/tmp/ts-serve.err || {
  echo "serve failed — likely HTTPS certs not enabled. Detail:"; cat /tmp/ts-serve.err
  echo ">> Enable MagicDNS + HTTPS Certificates in the Tailscale admin console (DNS page), then re-run this script."
  exit 1
}

NAME=$($TS status --json 2>/dev/null | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log((JSON.parse(d).Self.DNSName||"").replace(/\.$/,""))}catch{console.log("")}})')
echo "======================================================"
echo " PRIVATE URL:  https://$NAME"
echo "======================================================"
$TS serve status 2>&1 || true
