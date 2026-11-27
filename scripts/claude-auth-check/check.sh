#!/usr/bin/env bash
set -euo pipefail
# The user service may not inherit the interactive shell's PATH.
export PATH="$HOME/.local/bin:$PATH"
# Never log account identity or credentials. Claude Code owns renewal and storage.
claude auth status --json | jq -e 'if .loggedIn == true then {loggedIn, loginExpiresAt} else error("Claude Code sign-in required") end'
