#!/usr/bin/env bash
# Builds canvas-readonly-mcp-<version>.mcpb, a one-click Claude Desktop extension.
# Stages only what the extension needs (compiled dist/, production dependencies, manifest, icon)
# so src/, tests and dev dependencies stay out of the bundle.
#
# Usage: npm run build && scripts/build-mcpb.sh [output-dir]   (default: current directory)
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
out_dir="$(mkdir -p "${1:-.}" && cd "${1:-.}" && pwd)"
version="$(node -p "require('$root/package.json').version")"
out="$out_dir/canvas-readonly-mcp-$version.mcpb"

[[ -f "$root/dist/cli.js" ]] || { echo "dist/ is missing; run npm run build first" >&2; exit 1; }

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

cp -R "$root/dist" "$stage/dist"
cp "$root/package.json" "$root/package-lock.json" "$root/LICENSE" "$root/README.md" "$root/mcpb/icon.png" "$stage/"
# The manifest version always follows package.json.
node -e '
  const fs = require("fs");
  const [src, dest, version] = process.argv.slice(1);
  const m = JSON.parse(fs.readFileSync(src, "utf8"));
  m.version = version;
  fs.writeFileSync(dest, JSON.stringify(m, null, 2) + "\n");
' "$root/mcpb/manifest.json" "$stage/manifest.json" "$version"

(cd "$stage" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error)
rm "$stage/package-lock.json"

npx -y @anthropic-ai/mcpb@2.1.2 validate "$stage/manifest.json"
npx -y @anthropic-ai/mcpb@2.1.2 pack "$stage" "$out"
echo "Built $out"
