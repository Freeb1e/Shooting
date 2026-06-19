#!/usr/bin/env bash
set -Eeuo pipefail

APP_NAME="${APP_NAME:-shooting}"
PORT="${PORT:-3000}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "==> Deploying $APP_NAME from $SCRIPT_DIR"
echo "==> Port: $PORT"

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: node is not installed. Please install Node.js first."
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "ERROR: npm is not installed. Please install npm first."
  exit 1
fi

echo "==> Node: $(node -v)"
echo "==> npm: $(npm -v)"

echo "==> Installing production dependencies"
if [ -f package-lock.json ]; then
  npm ci --omit=dev
else
  npm install --omit=dev
fi

if ! command -v pm2 >/dev/null 2>&1; then
  echo "==> pm2 is not installed. Installing pm2 globally"
  if ! npm install -g pm2; then
    echo "==> Retrying pm2 install with sudo"
    sudo npm install -g pm2
  fi
fi

echo "==> Starting or restarting pm2 app: $APP_NAME"
if pm2 describe "$APP_NAME" >/dev/null 2>&1; then
  PORT="$PORT" pm2 restart "$APP_NAME" --update-env
else
  PORT="$PORT" pm2 start npm --name "$APP_NAME" -- start
fi

pm2 save

echo
echo "==> Deploy finished"
pm2 status "$APP_NAME"
echo
echo "Useful commands:"
echo "  pm2 logs $APP_NAME"
echo "  pm2 restart $APP_NAME --update-env"
echo "  PORT=$PORT APP_NAME=$APP_NAME bash deploy.sh"
