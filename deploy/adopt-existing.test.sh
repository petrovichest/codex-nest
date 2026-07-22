#!/usr/bin/env bash

set -Eeuo pipefail

[[ "$(uname -s)" == "Linux" ]] || { printf '%s\n' 'Linux test host required'; exit 0; }

trap 'printf "::error::adoption test failed at line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR

test_script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
test_root="$(mktemp -d)"
trap 'rm -rf -- "$test_root"' EXIT

prepare_case() {
  local name="$1"
  case_home="$test_root/$name/home"
  case_repo="$test_root/$name/repo"
  case_node="$test_root/$name/node-v24"
  case_fake_bin="$test_root/$name/bin"
  mkdir -p "$case_home/.config/codexnest" "$case_home/.config/systemd/user/codexnest.service.d" \
    "$case_home/.local/state/codexnest" "$case_repo/deploy/systemd" "$case_fake_bin" \
    "$case_node/bin"

  printf '%s\n' '{' '  "name": "fixture",' '  "version": "0.1.0"' '}' \
    > "$case_repo/package.json"
  cp "$test_script_dir/codexnest" "$case_repo/deploy/codexnest"
  cp "$test_script_dir/systemd/codexnest-managed.service" \
    "$case_repo/deploy/systemd/codexnest-managed.service"
  cp "$test_script_dir/systemd/codexnest-update.service" \
    "$case_repo/deploy/systemd/codexnest-update.service"
  chmod 0755 "$case_repo/deploy/codexnest"
  git -C "$case_repo" init -q -b codex/mvp
  git -C "$case_repo" config user.name CodexNest
  git -C "$case_repo" config user.email 0+codexnest@users.noreply.github.com
  git -C "$case_repo" add .
  git -C "$case_repo" commit -q -m fixture
  git -C "$case_repo" tag v0.1.0
  git -C "$case_repo" remote add origin "$case_repo"

  printf 'CUSTOM_SETTING=keep\nCODEXNEST_STATE_PATH=%s\n' \
    "$case_home/.local/state/codexnest/state.json" \
    > "$case_home/.config/codexnest/server.env"
  printf '%s\n' '[Unit]' 'Description=Existing CodexNest' '' '[Service]' \
    'ExecStart=/old/node /old/server.js' \
    > "$case_home/.config/systemd/user/codexnest.service"
  printf '%s\n' '[Service]' 'Environment=PRESERVED_DROP_IN=true' \
    > "$case_home/.config/systemd/user/codexnest.service.d/preserved.conf"
  printf '{"auth":{"tokenSha256":"%064d"}}\n' 0 \
    > "$case_home/.local/state/codexnest/state.json"

  case_real_node="$(command -v node)"
  cat > "$case_node/bin/node" <<EOF
#!/usr/bin/env bash
if [[ "\${1:-}" == "--version" ]]; then
  printf '%s\\n' 'v24.18.0'
  exit 0
fi
exec "$case_real_node" "\$@"
EOF
  cat > "$case_node/bin/npm" <<'EOF'
#!/usr/bin/env bash
set -e
if [[ "${1:-}" == "ci" ]]; then exit 0; fi
if [[ "${1:-}" == "run" && "${2:-}" == "build" ]]; then
  mkdir -p apps/server/dist apps/client/dist
  : > apps/server/dist/index.js
  : > apps/client/dist/index.html
  exit 0
fi
exit 2
EOF
  chmod 0755 "$case_node/bin/node" "$case_node/bin/npm"

  cat > "$case_fake_bin/systemctl" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
  cat > "$case_fake_bin/curl" <<'EOF'
#!/usr/bin/env bash
if [[ "$*" == *api.github.com* ]]; then
  printf '%s\n' '{"tag_name":"v0.1.0","draft":false,"prerelease":false}'
  exit 0
fi
if [[ -f "$HOME/fail-health" ]]; then exit 22; fi
printf '%s\n' '{"status":"ok","serverVersion":"0.1.0"}'
EOF
  chmod 0755 "$case_fake_bin/systemctl" "$case_fake_bin/curl"
}

run_adoption() {
  HOME="$case_home" \
  XDG_CONFIG_HOME="$case_home/.config" \
  XDG_STATE_HOME="$case_home/.local/state" \
  CODEXNEST_ROOT="$case_home/.local/share/codexnest" \
  PATH="$case_fake_bin:/usr/bin:/bin" \
  CODEXNEST_HEALTH_ATTEMPTS=1 \
  CODEXNEST_HEALTH_DELAY_SECONDS=0 \
    "$test_script_dir/adopt-existing.sh" --repo "$case_repo" --node "$case_node" "$@"
}

prepare_case success
run_adoption --dry-run >/dev/null
run_adoption >/dev/null
run_adoption >/dev/null
grep -q '^CUSTOM_SETTING=keep$' "$case_home/.config/codexnest/server.env"
grep -q '^CODEXNEST_MANAGED_INSTALL=true$' "$case_home/.config/codexnest/server.env"
grep -q 'Environment=PRESERVED_DROP_IN=true' \
  "$case_home/.config/systemd/user/codexnest.service.d/preserved.conf"
test -x "$case_home/.local/bin/codexnest"
test -f "$case_home/.config/systemd/user/codexnest-update.service"
test "$(basename "$(readlink -f "$case_home/.local/share/codexnest/current")")" = v0.1.0
test -z "$(find "$case_home/.local/state/codexnest" -maxdepth 1 -name 'adoption-backup.*' -print -quit)"

prepare_case rollback
cp "$case_home/.config/codexnest/server.env" "$test_root/rollback-env"
cp "$case_home/.config/systemd/user/codexnest.service" "$test_root/rollback-service"
touch "$case_home/fail-health"
if run_adoption >/dev/null 2>&1; then
  printf '%s\n' 'Expected adoption health failure' >&2
  exit 1
fi
cmp "$test_root/rollback-env" "$case_home/.config/codexnest/server.env"
cmp "$test_root/rollback-service" "$case_home/.config/systemd/user/codexnest.service"
grep -q '"tokenSha256":"0000000000000000000000000000000000000000000000000000000000000000"' \
  "$case_home/.local/state/codexnest/state.json"

printf '%s\n' 'CodexNest adoption tests passed.'
