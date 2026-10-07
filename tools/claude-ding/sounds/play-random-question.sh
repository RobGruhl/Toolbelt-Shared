#!/bin/bash
# Question sound — AskUserQuestion / ExitPlanMode / PermissionRequest hooks.
# Sounds resolve relative to this script, so the same file works from
# ~/.claude/sounds (a symlink into the belt) or from the tool dir directly.
# CLAUDE_DING_VOLUME overrides the afplay volume (default 0.1);
# CLAUDE_DING_MUTE=1 prints the chosen file and plays nothing.
dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
sounds=("$dir"/claude-question{1,2,3,4}.wav)
pick=${sounds[$RANDOM % ${#sounds[@]}]}
if [ -n "${CLAUDE_DING_MUTE:-}" ]; then echo "muted: $pick"; exit 0; fi
exec afplay -v "${CLAUDE_DING_VOLUME:-0.1}" "$pick"
