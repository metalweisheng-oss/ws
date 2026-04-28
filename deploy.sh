#!/bin/bash
set -e

echo "🚀 開始部署..."

# 1. 推送程式碼到 GitHub
echo "📦 推送程式碼到 GitHub..."
git add -A
git commit -m "Update $(date '+%Y-%m-%d %H:%M')" 2>/dev/null || echo "（沒有新的程式碼變更）"
git push origin main

# 2. 部署後端到 Railway
echo "🖥️  部署後端到 Railway..."
cd backend
railway up --detach --service pleasing-exploration
cd ..

# 3. Build 前端
echo "🔨 Build 前端..."
cd frontend
npm run build

# 4. 複製 404.html（SPA 路由用）
cp dist/index.html dist/404.html

# 5. 推送前端到 GitHub Pages
echo "🌐 部署前端到 GitHub Pages..."
cd /tmp && rm -rf gh-pages-deploy && mkdir gh-pages-deploy
cp -r /Users/linweisheng/projects/my-app/frontend/dist/. gh-pages-deploy/
cd gh-pages-deploy
git init && git checkout -b gh-pages
git add -A
git commit -m "Deploy $(date '+%Y-%m-%d %H:%M')"
REMOTE=$(git -C /Users/linweisheng/projects/my-app remote get-url origin)
git remote add origin "$REMOTE"
git push -f origin gh-pages

cd /Users/linweisheng/projects/my-app

echo ""
echo "✅ 部署完成！"
echo "   網頁：https://metalweisheng-oss.github.io/ws/"
echo "   後端：https://pleasing-exploration-production-c3c1.up.railway.app"
