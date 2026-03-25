#!/bin/bash
set -e

echo "=== RLFactor Deploy Script ==="

# ── Config ────────────────────────────────────────────────
APP_DIR="/home/ec2-user/RLFactor"
FRONTEND_DIR="$APP_DIR/frontend"
BACKEND_DIR="$APP_DIR/backend"
NGINX_ROOT="/usr/share/nginx/html"
# ──────────────────────────────────────────────────────────

# 1. Install system deps (safe to re-run)
echo "[1/7] Installing Node.js and nginx..."
if ! command -v node &> /dev/null; then
  curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
  sudo yum install -y nodejs
fi
if ! command -v nginx &> /dev/null; then
  sudo yum install -y nginx
fi
if ! command -v pm2 &> /dev/null; then
  sudo npm install -g pm2
fi

# 2. Pull latest code
echo "[2/7] Pulling latest code..."
if [ -d "$APP_DIR" ]; then
  cd "$APP_DIR" && git pull
else
  git clone https://github.com/YOUR_ORG/BuffetClearersNUSFinTech.git "$APP_DIR"
fi

# 3. Backend — install deps
echo "[3/7] Installing backend dependencies..."
cd "$BACKEND_DIR"
npm install

# 4. Backend — copy .env if not present
if [ ! -f "$BACKEND_DIR/.env" ]; then
  echo "⚠️  No .env found in backend! Copy your .env manually to $BACKEND_DIR/.env"
  exit 1
fi

# 5. Frontend — install deps + build
echo "[4/7] Installing frontend dependencies..."
cd "$FRONTEND_DIR"
npm install

echo "[5/7] Building frontend..."
# .env.production must exist with correct VITE_API_URL
if [ ! -f "$FRONTEND_DIR/.env.production" ]; then
  echo "⚠️  No .env.production found in frontend! Create it with VITE_API_URL=http://<your-ec2-ip>"
  exit 1
fi
npm run build

# 6. Copy frontend build to nginx
echo "[6/7] Deploying frontend to nginx..."
sudo rm -rf "$NGINX_ROOT"/*
sudo cp -r "$FRONTEND_DIR/dist/." "$NGINX_ROOT/"

# Configure nginx if not already done
NGINX_CONF="/etc/nginx/conf.d/rlfactor.conf"
if [ ! -f "$NGINX_CONF" ]; then
  sudo tee "$NGINX_CONF" > /dev/null <<'EOF'
server {
    listen 80;

    root /usr/share/nginx/html;
    index index.html;

    # Serve React app — fallback to index.html for client-side routing
    location / {
        try_files $uri $uri/ /index.html;
    }

    # Proxy API requests to backend
    location /api/ {
        proxy_pass http://localhost:6767/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
EOF
  sudo nginx -t && sudo systemctl enable nginx && sudo systemctl restart nginx
else
  sudo systemctl reload nginx
fi

# 7. Start/restart backend with PM2
echo "[7/7] Starting backend with PM2..."
cd "$BACKEND_DIR"
pm2 describe rlfactor-backend > /dev/null 2>&1 \
  && pm2 restart rlfactor-backend \
  || pm2 start src/index.js --name rlfactor-backend
pm2 save
sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u ec2-user --hp /home/ec2-user 2>/dev/null || true

echo ""
echo "✅ Deploy complete!"
echo "   Frontend: http://$(curl -s http://169.254.169.254/latest/meta-data/public-ipv4)"
echo "   Backend:  http://$(curl -s http://169.254.169.254/latest/meta-data/public-ipv4):6767"
echo ""
echo "   Logs: pm2 logs rlfactor-backend"
