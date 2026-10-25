#!/usr/bin/env bash
# Keeps one provider attempt's output at REVIEW_OUTPUT_FILE only when the attempt
# succeeded. claude-code-action reuses one execution-file path for every attempt.
set -euo pipefail

case "$PROVIDER" in
  claude) outcome="$CLAUDE_OUTCOME" source="$CLAUDE_FILE" ;;
  codex) outcome="$CODEX_OUTCOME" source="$CODEX_FILE" ;;
  *) echo "Unknown review provider: $PROVIDER" >&2; exit 1 ;;
esac

rm -f "$REVIEW_OUTPUT_FILE"
if [ -z "$source" ] || [ ! -f "$source" ]; then
  exit 0
fi
if [ "$outcome" = "success" ]; then
  mv "$source" "$REVIEW_OUTPUT_FILE"
else
  rm -f "$source"
fi
