#!/usr/bin/env bash
set -euo pipefail

source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/claude-auth-check" && pwd)
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
export PATH="$HOME/.local/bin:$PATH"
for command in claude jq systemctl; do
  command -v "$command" >/dev/null || { printf 'Missing command: %s\n' "$command" >&2; exit 1; }
done
systemctl --user show-environment >/dev/null
install -d "$unit_dir" "$HOME/.local/libexec"
install -m 700 "$source_dir/check.sh" "$HOME/.local/libexec/claude-auth-check"
install -m 644 "$source_dir/claude-auth-check.service" "$source_dir/claude-auth-check.timer" "$unit_dir/"
systemctl --user daemon-reload
# Check immediately before enabling recurring runs.
systemctl --user start claude-auth-check.service
systemctl --user enable --now claude-auth-check.timer
systemctl --user list-timers claude-auth-check.timer --all --no-pager
