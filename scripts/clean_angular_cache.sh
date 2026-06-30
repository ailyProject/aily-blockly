#!/usr/bin/env bash

set -eu

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CACHE_DIR="$ROOT_DIR/.angular/cache"

if [ -d "$CACHE_DIR" ]; then
  echo "[clean_angular_cache] remove Angular cache: $CACHE_DIR"
  rm -rf "$CACHE_DIR"
else
  echo "[clean_angular_cache] skip missing cache: $CACHE_DIR"
fi

echo "[clean_angular_cache] done"
