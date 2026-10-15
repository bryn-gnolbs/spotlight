#!/bin/bash
# End-to-end smoke test in a throwaway headless GNOME Shell.
#
# Everything is isolated from your desktop session: a private D-Bus (so the
# real genolabs agent is never reached; the driver plays a fake one), in-memory
# settings, and temporary data, config, cache and runtime directories. Nothing
# is installed into your real ~/.local/share and your running shell is never touched.
#
# Usage: tests/smoke/run.sh   (or `make smoke`). Needs the zip from `make pack`.
set -euo pipefail

PROJECT="$(cd "$(dirname "$0")/../.." && pwd)"
UUID="spotlight@genolabs.net"
ZIP="$PROJECT/build/$UUID.shell-extension.zip"
OUT="$(mktemp -d -t spotlight-smoke-XXXXXX)"
[ -f "$ZIP" ] || { echo "Missing $ZIP - run 'make pack' first" >&2; exit 2; }

export XDG_DATA_HOME="$OUT/data" XDG_CONFIG_HOME="$OUT/config" XDG_CACHE_HOME="$OUT/cache"
# Own runtime dir too: GNOME Shell keeps crash-protection state there, which
# must never leak into the real session's /run/user/$UID.
# Kept short on purpose: Wayland socket paths are limited to 108 bytes.
XDG_RUNTIME_DIR="$(mktemp -d /tmp/spl-rt-XXXXXX)"
export XDG_RUNTIME_DIR
trap 'rm -rf "$XDG_RUNTIME_DIR"' EXIT
export GSETTINGS_BACKEND=memory SPOTLIGHT_SMOKE_OUT="$OUT"
EXT_DIR="$XDG_DATA_HOME/gnome-shell/extensions"
DRIVER_DIR="$EXT_DIR/spotlight-smoke-driver@test"
mkdir -p "$EXT_DIR/$UUID" "$DRIVER_DIR"
unzip -q "$ZIP" -d "$EXT_DIR/$UUID"
cp "$PROJECT"/tests/smoke/driver/* "$PROJECT"/tests/fakeAgent.js "$DRIVER_DIR/"
unset WAYLAND_DISPLAY DISPLAY

timeout 150 dbus-run-session -- bash -c '
    gnome-shell --headless --wayland --no-x11 --virtual-monitor 1600x900 >"$SPOTLIGHT_SMOKE_OUT/shell.log" 2>&1 &
    shell=$!
    for _ in $(seq 60); do
        gdbus introspect --session --dest org.gnome.Shell --object-path /org/gnome/Shell >/dev/null 2>&1 && break
        sleep 0.5
    done
    gnome-extensions enable spotlight@genolabs.net
    gnome-extensions enable spotlight-smoke-driver@test
    for _ in $(seq 200); do grep -q "SMOKE done" "$SPOTLIGHT_SMOKE_OUT/shell.log" && break; sleep 0.5; done
    kill $shell; wait $shell 2>/dev/null || true
' 2>"$OUT/session.log" || true

grep -E "SMOKE (PASS|FAIL|INFO)" "$OUT/shell.log" | sed -E 's/.*SMOKE //' || true
# Anything Spotlight itself complained about.
grep -E "Spotlight:|spotlight@genolabs.net" "$OUT/shell.log" | grep -v "SMOKE" || true
echo "Log and screenshots: $OUT"
if grep -q "SMOKE FAIL" "$OUT/shell.log" || ! grep -q "SMOKE PASS" "$OUT/shell.log"; then
    exit 1
fi
