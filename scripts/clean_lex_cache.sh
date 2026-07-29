#!/usr/bin/env bash

set -eu

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "[clean_lex_cache] remove Angular cache"
rm -rf "$ROOT_DIR/.angular/cache"

# aily-lex 已改为 npm 包依赖；仅清理本地残留目录与已安装包缓存
for CANDIDATE in \
  "$ROOT_DIR/child/aily-lex" \
  "$ROOT_DIR/../aily-lex" \
  "$ROOT_DIR/node_modules/aily-lex"
do
  if [ ! -d "$CANDIDATE" ]; then
    echo "[clean_lex_cache] skip missing: $CANDIDATE"
    continue
  fi

  if [ "$CANDIDATE" = "$ROOT_DIR/node_modules/aily-lex" ]; then
    echo "[clean_lex_cache] remove installed package: $CANDIDATE"
    rm -rf "$CANDIDATE"
    continue
  fi

  echo "[clean_lex_cache] remove leftover local lex dir: $CANDIDATE"
  rm -rf "$CANDIDATE"
done

echo "[clean_lex_cache] reinstall aily-lex from npm"
cd "$ROOT_DIR"
npm install aily-lex --no-audit --no-fund
