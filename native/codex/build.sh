#!/usr/bin/env bash
# Builds an isolated receiver. Does not install, restart, or update CodexNest.
set -euo pipefail
package_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
proxy_file=${CODEXNEST_PROXY_ENV_FILE:-$HOME/.config/codex/app-server.env}
if [[ -f "$proxy_file" ]]; then
  set -a
  # Do not enable shell tracing: this file can contain proxy credentials.
  . "$proxy_file"
  set +a
fi
readarray -t pin < <(python3 - "$package_dir/upstream.json" <<'PY'
import json, sys
pin = json.load(open(sys.argv[1]))
print(pin['repository'])
print(pin['revision'])
print(pin['rust'])
PY
)
patch_id=$(cat "$package_dir/upstream.json" "$package_dir"/patches/*.patch | sha256sum | cut -d ' ' -f 1)
build_root=${CODEXNEST_NATIVE_BUILD_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/codexnest/native/$patch_id}
source_dir=$build_root/source
mkdir -p "$build_root"
if [[ ! -d "$source_dir/.git" ]]; then
  git clone --filter=blob:none --no-checkout "${pin[0]}" "$source_dir"
  git -C "$source_dir" checkout --detach "${pin[1]}"
fi
[[ $(git -C "$source_dir" rev-parse HEAD) == "${pin[1]}" ]] || {
  echo 'Build checkout has the wrong upstream revision' >&2; exit 1;
}
if [[ ! -f "$build_root/applied-tree" ]]; then
  [[ -z $(git -C "$source_dir" status --porcelain) ]] || {
    echo 'Build checkout contains unrelated changes' >&2; exit 1;
  }
  git -C "$source_dir" apply --index "$package_dir"/patches/*.patch
  git -C "$source_dir" write-tree > "$build_root/applied-tree"
  printf '%s\n' "$patch_id" > "$build_root/applied-patches"
fi
[[ -f "$build_root/applied-patches" && $(cat "$build_root/applied-patches") == "$patch_id" ]] || {
  echo 'This build directory contains a different patch set; use a new build directory' >&2; exit 1;
}
[[ $(git -C "$source_dir" write-tree) == $(cat "$build_root/applied-tree") ]] || {
  echo 'Applied native patch changed since preparation' >&2; exit 1;
}
git -C "$source_dir" diff --exit-code --quiet
[[ -z $(git -C "$source_dir" ls-files --others --exclude-standard) ]] || {
  echo 'Build checkout contains untracked files' >&2; exit 1;
}
export CARGO_TARGET_DIR=${CARGO_TARGET_DIR:-$build_root/target}
export RUSTUP_TOOLCHAIN=${pin[2]}
profile=${CODEXNEST_NATIVE_PROFILE:-release}
(cd "$source_dir/codex-rs" && cargo build --locked --profile "$profile" -p codex-cli --bin codex)
artifact_profile=$profile
[[ "$profile" != dev ]] || artifact_profile=debug
binary=$CARGO_TARGET_DIR/$artifact_profile/codex
"$binary" --version
sha256sum "$binary"
printf '%s\n' "$binary"
