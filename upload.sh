#!/bin/bash
cd "$(dirname "$0")"

echo "[1/4] Git init + remote..."
git init
git remote add origin https://github.com/contep2k15-oss/ai-era-media-2.git

echo "[2/4] Commit..."
git add -A
git commit -m "fix: Vertex AI global endpoint v1.1.0

- Global endpoint cho Gemini 3.1 (Agent Platform)
- MODEL_TEXT:  gemini-3.1-flash-lite  (global)
- MODEL_IMAGE: gemini-3.1-flash-image (global)
- MODEL_TTS:   gemini-3.1-flash-tts   (global)
- Fix igCallGeminiImage VERTEX_MODEL undefined
- PROJECT: gen-lang-client-0682538223"

echo "[3/4] Push + tag..."
git branch -M main
git push -f origin main
git tag -fa v1.1.0 -m "v1.1.0 - Vertex AI global endpoint fix"
git push origin v1.1.0 --force

echo ""
echo "==== XONG ===="
echo "Build: https://github.com/contep2k15-oss/ai-era-media-2/actions"
echo ".exe:  https://github.com/contep2k15-oss/ai-era-media-2/releases/tag/v1.1.0"
