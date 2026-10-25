#!/usr/bin/env bash
# Keeps one provider attempt's output at REVIEW_OUTPUT_FILE whenever the
# provider wrote one. Error result messages are needed for diagnosis.
set -euo pipefail

case "$PROVIDER" in
  claude) source="$CLAUDE_FILE" ;;
  codex) source="$CODEX_FILE" ;;
  *) echo "Unknown review provider: $PROVIDER" >&2; exit 1 ;;
esac

rm -f "$REVIEW_OUTPUT_FILE"
if [ -z "$source" ] || [ ! -f "$source" ]; then
  exit 0
fi
mv "$source" "$REVIEW_OUTPUT_FILE"
