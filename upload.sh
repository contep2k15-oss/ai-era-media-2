#!/bin/bash
cd "$(dirname "$0")"

echo "[1/4] Kiem tra git..."
if [ ! -d ".git" ]; then
  git init
  git remote add origin https://github.com/contep2k15-oss/ai-era-media-2.git
else
  git remote set-url origin https://github.com/contep2k15-oss/ai-era-media-2.git
fi

echo "[2/4] Commit..."
git add -A
git commit -m "fix: Vertex AI global endpoint v1.1.0" 2>/dev/null || echo "(Khong co gi thay doi, skip commit)"

echo "[3/4] Push main..."
git branch -M main
git push -f origin main

echo "[4/4] Tag v1.1.0..."
git tag -fa v1.1.0 -m "v1.1.0 - Vertex AI global endpoint fix" 2>/dev/null
git push origin v1.1.0 --force

echo ""
echo "==== XONG ===="
echo "Build: https://github.com/contep2k15-oss/ai-era-media-2/actions"
echo ".exe:  https://github.com/contep2k15-oss/ai-era-media-2/releases/tag/v1.1.0"
