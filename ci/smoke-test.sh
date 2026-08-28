#!/usr/bin/env bash
# Boot a real GNOME Shell, load the extension into it, and see what happens.
#
# Everything the headless suite cannot ask: does it load at all, is the icon actually drawn
# rather than the blank square GNOME substitutes for one it cannot rasterise, does the menu
# hold the rooms, does clicking one really reach the desktop's default handler for https,
# and does disabling it five times leave anything attached to the main loop.
#
#   ci/smoke-test.sh              run it
#   ci/smoke-test.sh --shots DIR  and write screenshots there
#
# By default it runs the working tree's src/. Set MEET_INSTALL_ZIP to a packed
# .shell-extension.zip and it runs that instead — which is how a *published release* gets
# checked in a real shell rather than merely downloaded:
#
#   MEET_INSTALL_ZIP=/path/to/meet@meet-gs.patxi.shell-extension.zip ci/smoke-test.sh
#
# The shell is headless (no window appears) and runs against a throwaway HOME of its own, so
# this touches neither your session nor your dconf. That isolation is not a nicety: the
# obvious version of this script installs into ~/.local/share/gnome-shell/extensions, rewrites
# org.gnome.shell enabled-extensions and — worse here than in a sibling idea — registers a
# stub program as your default browser. Run outside a throwaway HOME it would maul the
# session you are sitting in.
set -euo pipefail

UUID="meet@meet-gs.patxi"
DRIVER="meet-driver@test.meet-gs"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
shots=""
[ "${1:-}" = "--shots" ] && { mkdir -p "$2"; shots="$(cd "$2" && pwd)"; }

for tool in gnome-shell dbus-run-session glib-compile-schemas python3; do
  command -v "$tool" >/dev/null || { echo "$tool not found" >&2; exit 1; }
done

work="$here/.nested"
rm -rf "$work"
mkdir -p "$work"
export HOME="$work/home"
export XDG_DATA_HOME="$HOME/.local/share"
export XDG_CONFIG_HOME="$HOME/.config"
export XDG_CACHE_HOME="$HOME/.cache"
export XDG_STATE_HOME="$HOME/.local/state"
mkdir -p "$XDG_DATA_HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_STATE_HOME"
# The distro's own extensions load in this shell too, and the desktop-icons one fills the
# log with criticals about a home directory that has no Desktop in it.
mkdir -p "$HOME/Desktop"

# A wayland socket path has 108 bytes to live in, and this checkout is nested deep enough to
# blow that on its own. /run/user is short; a TMPDIR is the fallback for CI images without
# a logind runtime directory.
if [ -d "/run/user/$(id -u)" ] && [ -w "/run/user/$(id -u)" ]; then
  runtime="$(mktemp -d "/run/user/$(id -u)/meetXXXXXX")"
else
  runtime="$(mktemp -d "${TMPDIR:-/tmp}/meetXXXXXX")"
fi
export XDG_RUNTIME_DIR="$runtime"
chmod 700 "$runtime"
cleanup() { rm -rf "$runtime"; }
trap cleanup EXIT

extensions="$XDG_DATA_HOME/gnome-shell/extensions"
mkdir -p "$extensions/$UUID" "$extensions/$DRIVER"
# Laid out the way the packed zip lays it out — sources at the root, schemas compiled
# beside their XML — because that is what a user installs and what the extension's own
# paths assume. Installing the checkout's src/ directly would hide a file left out of the
# package.
if [ -n "${MEET_INSTALL_ZIP:-}" ]; then
  # A published release, run in a real shell rather than merely downloaded. This is the
  # only check that can catch a file left out of the package: everything else in this
  # script reads the checkout, where the file is still there.
  command -v unzip >/dev/null || { echo "unzip not found" >&2; exit 1; }
  echo "installing from $MEET_INSTALL_ZIP"
  unzip -q -o "$MEET_INSTALL_ZIP" -d "$extensions/$UUID"
else
  cp -r "$here/src/." "$extensions/$UUID/"
fi
cp -r "$here/ci/driver/." "$extensions/$DRIVER/"
glib-compile-schemas "$extensions/$UUID/schemas"

# ---------------------------------------------------------------------------------------
# A stub browser.
#
# The whole point of the extension is that it hands a URI to whatever the desktop opens web
# links with, so the test has to have one — and has to be able to see what it was handed.
# This registers a shell script as the default application for x-scheme-handler/https; it
# writes each URI it is given to a file the driver reads.
#
# Registered through mimeapps.list rather than by MimeType= alone: an explicit default is
# what g_app_info_get_default_for_uri_scheme consults first, and it does not depend on the
# desktop database cache having been rebuilt.
# ---------------------------------------------------------------------------------------
opened="$work/opened.txt"
: > "$opened"
mkdir -p "$work/bin" "$XDG_DATA_HOME/applications"
cat > "$work/bin/stub-browser" <<EOF
#!/bin/sh
# Records what it was asked to open, and does nothing else.
printf '%s\n' "\$1" >> "$opened"
EOF
chmod +x "$work/bin/stub-browser"
cat > "$XDG_DATA_HOME/applications/meet-stub-browser.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Stub Browser
Exec=$work/bin/stub-browser %u
NoDisplay=true
MimeType=x-scheme-handler/https;x-scheme-handler/http;
EOF
cat > "$XDG_CONFIG_HOME/mimeapps.list" <<'EOF'
[Default Applications]
x-scheme-handler/https=meet-stub-browser.desktop
x-scheme-handler/http=meet-stub-browser.desktop
EOF
command -v update-desktop-database >/dev/null &&
  update-desktop-database "$XDG_DATA_HOME/applications" 2>/dev/null || true

result="$work/result.json"
export MEET_DRIVER_RESULT="$result"
export MEET_DRIVER_OPENED="$opened"
[ -n "$shots" ] && export MEET_DRIVER_SHOTS="$shots"

# dconf is per-user, not per-bus, so these writes land in the throwaway HOME above and
# nowhere else.
dbus-run-session -- sh -c "
  gsettings set org.gnome.shell disable-user-extensions false
  gsettings set org.gnome.shell enabled-extensions \"['$DRIVER', '$UUID']\"
"

log="$work/shell.log"
echo "booting a headless shell (log: $log)"
set +e
timeout 180 dbus-run-session -- \
  gnome-shell --headless --virtual-monitor 1280x1024 --wayland --no-x11 \
  >"$log" 2>&1
shell_status=$?
set -e

echo
if [ ! -f "$result" ]; then
  echo "the driver never wrote a result (shell exited $shell_status)" >&2
  tail -40 "$log" >&2
  exit 1
fi

python3 - "$result" "$log" "$shots" <<'PY'
import json, os, re, sys

results = json.load(open(sys.argv[1]))
log = open(sys.argv[2], errors="replace").read()
shots = sys.argv[3] if len(sys.argv) > 3 else ""

for check in results["checks"]:
    if check["name"].startswith("screenshot") and not shots:
        continue
    print(f"  {'ok  ' if check['ok'] else 'FAIL'} {check['name']}"
          + (f"\n       {check['detail']}" if check.get("detail") else ""))

failures = [f for f in results["failures"] if not f.startswith("screenshot ")]

# A screenshot that did not happen is only a failure when one was asked for.
if shots:
    for name in ("panel.png", "menu.png", "preferences.png"):
        if not os.path.exists(os.path.join(shots, name)):
            failures.append(f"no screenshot was written to {shots}/{name}")

# The shell logs what an extension gets wrong instead of raising it, so a run that passed
# every check and filled the journal with criticals has not passed.
for line in log.splitlines():
    if (re.search(r"(JS ERROR|Gjs-CRITICAL|has been already disposed)", line)
            and re.search(r"(meet@meet-gs\.patxi|meet-driver@)", line)):
        failures.append(f"the shell logged: {line.strip()}")
    # The preferences window is a process of its own, and its failures are logged by that
    # process — with no uuid in the line for the rule above to match on. This is how a
    # prefs.js that throws while building its page is caught: the window still appears, and
    # the driver still sees a window, but what is in it is GNOME's error page. Measuring
    # the window's pixels does *not* catch it — an error page is denser than the real one,
    # so it scores higher on any "did it draw anything" test.
    if "Failed to open preferences" in line:
        failures.append(f"the preferences window failed to build: {line.strip()}")

print()
ink = results.get("iconInk")
print(f"panel: {results.get('panel')!r}, menu: {results.get('menu')}, "
      f"icon ink: {ink if ink is None else format(ink, '.1%')}, "
      f"opened: {results.get('opened')}, enable/disable rounds: {results.get('cycles')}")
if failures:
    print()
    for failure in failures:
        print(f"FAILED: {failure}")
    sys.exit(1)
print("smoke test passed")
PY
