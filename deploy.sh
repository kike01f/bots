#!/bin/bash
# ARTURITO AI — Despliegue completo (hosting + reglas + Cloud Functions)
# Ejecutar desde esta carpeta: bash deploy.sh
# Requiere una vez: firebase login

set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

NODE_BIN=""
if command -v node >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
elif [ -x "$ROOT/.tools/node-v20.18.1-darwin-arm64/bin/node" ]; then
  NODE_BIN="$ROOT/.tools/node-v20.18.1-darwin-arm64/bin/node"
elif [ -x "$ROOT/.tools/node-v20.18.1-darwin-x64/bin/node" ]; then
  NODE_BIN="$ROOT/.tools/node-v20.18.1-darwin-x64/bin/node"
fi

if [ -z "$NODE_BIN" ]; then
  echo "❌ Instala Node.js: https://nodejs.org"
  exit 1
fi

export PATH="$(dirname "$NODE_BIN"):$PATH"

FB=""
if command -v firebase >/dev/null 2>&1; then
  FB="firebase"
elif [ -x "$ROOT/.tools/fb-cli/node_modules/.bin/firebase" ]; then
  FB="$ROOT/.tools/fb-cli/node_modules/.bin/firebase"
else
  echo "→ Instalando Firebase CLI local..."
  npm install firebase-tools@14.12.0 --prefix "$ROOT/.tools/fb-cli" --no-save
  FB="$ROOT/.tools/fb-cli/node_modules/.bin/firebase"
fi

if ! "$FB" login:list 2>&1 | grep -q '@'; then
  echo ""
  echo "⚠️  Sin sesión Firebase. Ejecuta una vez: $FB login"
  echo "   Luego: bash deploy.sh"
  echo ""
  exit 1
fi

echo "→ Proyecto: chatbots-hipodromo"
"$FB" use chatbots-hipodromo 2>/dev/null || "$FB" use --add

if [ -f functions/package.json ]; then
  echo "→ Dependencias Cloud Functions..."
  (cd functions && npm install --omit=dev)
fi

echo "→ Desplegando hosting (index.html), reglas, functions..."
"$FB" deploy --only firestore:rules,firestore:indexes,storage:rules,functions,hosting --project chatbots-hipodromo

echo ""
echo "✅ Listo. App monolítica: index.html (esta carpeta)"
