#!/usr/bin/env bash
set -euo pipefail

if [[ $# != 1 ]]; then
  echo "usage: $0 OUTPUT_DIRECTORY" >&2
  exit 2
fi

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"
version="$(node -p "JSON.parse(require('node:fs').readFileSync('package.json', 'utf8')).version")"
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "package version must be stable semver" >&2
  exit 1
fi
for package in doppelclaude pi-doppelclaude http-doppelclaude; do
  if [[ ! -d "packages/$package/dist" ]]; then
    echo "missing packages/$package/dist; run mise run build first" >&2
    exit 1
  fi
done

mkdir -p -- "$1"
output_dir="$(cd -- "$1" && pwd)"
staging="$(mktemp -d "${TMPDIR:-/tmp}/doppelclaude-release.XXXXXX")"
trap 'rm -rf -- "$staging"' EXIT
release_name="pi-doppelclaude-$version"
release_root="$staging/$release_name"
mkdir -p -- "$release_root"

# Copy tracked source from the working tree so tag-stamped manifests and lockfile
# are included. Keep all workspaces together: the Pi package needs this fork's core.
git ls-files -z | tar --null --files-from=- --create --file=- |
  tar --extract --file=- --directory="$release_root"
for package in doppelclaude pi-doppelclaude http-doppelclaude; do
  cp -R "packages/$package/dist" "$release_root/packages/$package/"
done
git rev-parse HEAD > "$release_root/SOURCE_REVISION"
archive="$output_dir/$release_name.tar.gz"
tar --create --gzip --file="$archive" --directory="$staging" "$release_name"
printf '%s\n' "$archive"
