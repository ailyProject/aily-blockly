#!/usr/bin/env bash

set -eu

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LEX_DIR="$ROOT_DIR/child/aily-lex"
SEEN_PATHS=""

echo "[clean_lex_cache] remove Angular cache"
rm -rf "$ROOT_DIR/.angular/cache"

for CANDIDATE in \
  "$ROOT_DIR/child/aily-lex" \
  "$ROOT_DIR/../aily-lex" \
  "$ROOT_DIR/node_modules/aily-lex"
do
  if [ ! -d "$CANDIDATE" ]; then
    echo "[clean_lex_cache] skip missing: $CANDIDATE"
    continue
  fi

  REAL_PATH="$(cd "$CANDIDATE" && pwd -P)"
  case " $SEEN_PATHS " in
    *" $REAL_PATH "*) 
      echo "[clean_lex_cache] skip duplicate: $CANDIDATE -> $REAL_PATH"
      continue
      ;;
  esac

  SEEN_PATHS="$SEEN_PATHS $REAL_PATH"
  echo "[clean_lex_cache] remove lex build cache: $REAL_PATH"
  rm -rf "$REAL_PATH/dist" "$REAL_PATH/tsconfig.tsbuildinfo"
done

echo "[clean_lex_cache] rebuild aily-lex"
cd "$LEX_DIR"
npm run build
