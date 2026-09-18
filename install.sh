#!/bin/sh
# This file is a release template. scripts/build-release.py replaces the markers below.
set -eu

RELEASE_VERSION='@AI_PERSONA_RELEASE_VERSION@'
PACKAGE_VERSION=${RELEASE_VERSION#v}
ARCHIVE_NAME='@AI_PERSONA_ARCHIVE_NAME@'
ARCHIVE_SHA256='@AI_PERSONA_ARCHIVE_SHA256@'
RADAR_ARCHIVE_NAME='@PAPER_RADAR_ARCHIVE_NAME@'
RADAR_ARCHIVE_SHA256='@PAPER_RADAR_ARCHIVE_SHA256@'
# Official Node.js LTS archives; only downloaded for the optional Radar component.
NODE_VERSION='v24.21.0'
REPOSITORY='rainshed/PersonaStudio'
MANAGED_MARKER='# Managed by the PersonaStudio installer.'

fail() {
    printf '%s\n' "PersonaStudio installation failed: $*" >&2
    exit 1
}

say() {
    printf '%s\n' "$*"
}

usage() {
    printf '%s\n' 'Usage: install.sh [--with-paper-radar | --without-paper-radar] [--dry-run] [--no-restart]' \
        'By default, a new installation includes AI Persona only; updates keep your installed components.' \
        '--without-paper-radar removes the application from the active installation, keeping research data.'
}

DRY_RUN=0
RESTART=1
RADAR=auto
while [ "$#" -gt 0 ]; do
    case "$1" in
        --dry-run) DRY_RUN=1 ;;
        --no-restart) RESTART=0 ;;
        --with-paper-radar) [ "$RADAR" != 0 ] || fail 'conflicting component options'; RADAR=1 ;;
        --without-paper-radar) [ "$RADAR" != 1 ] || fail 'conflicting component options'; RADAR=0 ;;
        -h|--help) usage; exit 0 ;;
        *) usage >&2; fail "unknown option: $1" ;;
    esac
    shift
done

case "$RELEASE_VERSION" in
    @*)
        fail 'this template must be downloaded from a published GitHub Release'
        ;;
esac

[ -n "${HOME:-}" ] || fail 'HOME is not set'
umask 077
INSTALL_ROOT=${AI_PERSONA_INSTALL_ROOT:-${XDG_DATA_HOME:-$HOME/.local/share}/ai-persona}
BIN_DIR=${AI_PERSONA_BIN_DIR:-$HOME/.local/bin}
case "$INSTALL_ROOT" in /*) ;; *) fail 'the installation directory must be absolute' ;; esac
case "$BIN_DIR" in /*) ;; *) fail 'the command directory must be absolute' ;; esac
case "$INSTALL_ROOT" in /|"$HOME") fail 'refusing to use a broad installation directory' ;; esac

VERSION_DIR="$INSTALL_ROOT/versions/$RELEASE_VERSION"
CURRENT_LINK="$INSTALL_ROOT/current"
LOCK_DIR="$INSTALL_ROOT/.install.lock"
TMP_DIR=''
REMOVE_VERSION_ON_EXIT=0
OWNS_LOCK=0
WRAPPERS_CHANGED=0
INSTALL_SUCCESS=0
PROBE_RUNNING=0

cleanup() {
    if [ "$PROBE_RUNNING" -eq 1 ]; then probe_radar stop >/dev/null 2>&1 || true; fi
    if [ "$WRAPPERS_CHANGED" -eq 1 ] && [ "$INSTALL_SUCCESS" -eq 0 ]; then
        for entrypoint in ai-persona ai-persona-mcp personastudio paper-radar; do
            if [ -f "$TMP_DIR/wrappers/$entrypoint" ]; then
                cp -p "$TMP_DIR/wrappers/$entrypoint" "$BIN_DIR/$entrypoint"
            else
                rm -f "$BIN_DIR/$entrypoint"
            fi
        done
    fi
    if [ -n "$TMP_DIR" ] && [ -d "$TMP_DIR" ]; then
        rm -rf -- "$TMP_DIR"
    fi
    if [ "$REMOVE_VERSION_ON_EXIT" -eq 1 ] && [ -d "$VERSION_DIR" ]; then
        rm -rf -- "$VERSION_DIR"
    fi
    if [ "$OWNS_LOCK" -eq 1 ] && [ -d "$LOCK_DIR" ]; then
        rmdir "$LOCK_DIR" 2>/dev/null || true
    fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' HUP TERM

shell_quote() {
    printf "'"
    printf '%s' "$1" | sed "s/'/'\\\\''/g"
    printf "'"
}

write_wrapper() {
    destination=$1
    entrypoint=$2
    temporary=$(mktemp "$BIN_DIR/.${entrypoint}.XXXXXX")
    {
        printf '%s\n' '#!/bin/sh' "$MANAGED_MARKER" 'set -eu'
        printf 'AI_PERSONA_INSTALL_ROOT='; shell_quote "$INSTALL_ROOT"; printf '\n'
        printf 'AI_PERSONA_COMMAND='; shell_quote "$BIN_DIR/ai-persona"; printf '\n'
        printf 'AI_PERSONA_MCP_COMMAND='; shell_quote "$BIN_DIR/ai-persona-mcp"; printf '\n'
        printf 'AI_PERSONA_BIN_DIR='; shell_quote "$BIN_DIR"; printf '\n'
        printf 'UV_BIN_DIR='; shell_quote "$(dirname "$(command -v uv)")"; printf '\n'
        printf '%s\n' 'export AI_PERSONA_INSTALL_ROOT AI_PERSONA_BIN_DIR AI_PERSONA_COMMAND AI_PERSONA_MCP_COMMAND' \
            'PATH="$AI_PERSONA_INSTALL_ROOT/current/runtime/node/bin:$UV_BIN_DIR:$PATH"' 'export PATH' 'unset PYTHONPATH'
        printf 'exec "$AI_PERSONA_INSTALL_ROOT/current/scripts/%s" "$@"\n' "$entrypoint"
    } > "$temporary"
    chmod 755 "$temporary"
    mv -f "$temporary" "$destination"
}

check_wrapper_destination() {
    destination=$1
    if [ -L "$destination" ]; then
        fail "refusing to replace a linked command: $destination"
    fi
    if [ -e "$destination" ] && [ "$(sed -n '2p' "$destination" 2>/dev/null || true)" != "$MANAGED_MARKER" ]; then
        fail "refusing to replace an unmanaged command: $destination"
    fi
}

checksum() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | awk '{print $1}'
    elif command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$1" | awk '{print $1}'
    else
        fail 'sha256sum or shasum is required'
    fi
}

ensure_uv() {
    if command -v uv >/dev/null 2>&1; then
        return
    fi
    say 'Installing uv…'
    command -v curl >/dev/null 2>&1 || fail 'curl is required to install uv'
    curl -LsSf https://astral.sh/uv/install.sh | sh
    for candidate in "$HOME/.local/bin/uv" "$HOME/.cargo/bin/uv"; do
        if [ -x "$candidate" ]; then
            PATH="$(dirname "$candidate"):$PATH"
            export PATH
            break
        fi
    done
    command -v uv >/dev/null 2>&1 || fail 'uv was installed but is not available; open a new terminal and run this command again'
}

download_archive() {
    destination=$1
    if [ -n "${AI_PERSONA_INSTALL_ARCHIVE:-}" ]; then
        [ -f "$AI_PERSONA_INSTALL_ARCHIVE" ] || fail 'the local release archive does not exist'
        cp "$AI_PERSONA_INSTALL_ARCHIVE" "$destination"
        return
    fi
    command -v curl >/dev/null 2>&1 || fail 'curl is required'
    base=${AI_PERSONA_RELEASE_BASE_URL:-https://github.com/$REPOSITORY/releases/download/$RELEASE_VERSION}
    say "Downloading AI Persona $RELEASE_VERSION…"
    curl -fL --retry 3 --retry-delay 1 "$base/$ARCHIVE_NAME" -o "$destination"
}

prepare_radar() {
    [ "$(uname -s)" = Darwin ] || fail 'Paper Radar releases currently support macOS only'
    case "$(uname -m)" in
        arm64) node_arch=arm64; node_hash=bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057 ;;
        x86_64) node_arch=x64; node_hash=1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097 ;;
        *) fail 'unsupported macOS architecture' ;;
    esac
    say 'Preparing Paper Radar and its private Node.js runtime…'
    radar_archive="$TMP_DIR/$RADAR_ARCHIVE_NAME"
    if [ -n "${PAPER_RADAR_INSTALL_ARCHIVE:-}" ]; then
        cp "$PAPER_RADAR_INSTALL_ARCHIVE" "$radar_archive"
    else
        base=${AI_PERSONA_RELEASE_BASE_URL:-https://github.com/$REPOSITORY/releases/download/$RELEASE_VERSION}
        curl -fL --retry 3 --retry-delay 1 "$base/$RADAR_ARCHIVE_NAME" -o "$radar_archive"
    fi
    [ "$(checksum "$radar_archive")" = "$RADAR_ARCHIVE_SHA256" ] || fail 'Paper Radar archive checksum mismatch'
    # Python's data filter rejects traversal and escaping links; the archive may
    # only add the Radar component and its launcher to this candidate version.
    "$VERSION_DIR/apps/ai-persona/.venv/bin/python" - "$radar_archive" "$VERSION_DIR" "$RELEASE_VERSION" <<'PY'
import sys, tarfile
from pathlib import PurePosixPath
with tarfile.open(sys.argv[1]) as archive:
    prefix = f"PersonaStudio-{sys.argv[3]}/"
    members = archive.getmembers()
    for member in members:
        if not member.name.startswith(prefix):
            raise SystemExit("Unexpected Paper Radar archive root")
        member.name = member.name[len(prefix):]
        path = PurePosixPath(member.name)
        if (not member.isfile() or path.is_absolute() or ".." in path.parts
                or not (member.name.startswith("apps/paper-radar/") or member.name == "scripts/paper-radar")):
            raise SystemExit("Unsafe Paper Radar archive entry")
    archive.extractall(sys.argv[2], members=members, filter="data")
PY
    node_name="node-$NODE_VERSION-darwin-$node_arch"
    node_archive="$TMP_DIR/node.tar.gz"
    if [ -n "${PERSONASTUDIO_NODE_ARCHIVE:-}" ]; then
        cp "$PERSONASTUDIO_NODE_ARCHIVE" "$node_archive"
    else
        curl -fL --retry 3 --retry-delay 1 "https://nodejs.org/dist/$NODE_VERSION/$node_name.tar.gz" -o "$node_archive"
    fi
    [ "$(checksum "$node_archive")" = "$node_hash" ] || fail 'Node.js archive checksum mismatch'
    mkdir -p "$VERSION_DIR/runtime"
    tar -xzf "$node_archive" -C "$VERSION_DIR/runtime"
    mv "$VERSION_DIR/runtime/$node_name" "$VERSION_DIR/runtime/node"
    PATH="$VERSION_DIR/runtime/node/bin:$PATH"
    export PATH
    [ "$(node --version)" = "$NODE_VERSION" ] || fail 'the managed Node.js runtime did not pass its version check'
    (cd "$VERSION_DIR/apps/paper-radar/web" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund)
    # Exercise the installed production server in disposable data, without models.
    PROBE_RUNNING=1
    if ! probe_radar start --port 0 --no-open >/dev/null; then
        tail -40 "$TMP_DIR/radar-check/data/.runtime/server.log" >&2 || true
        fail 'Paper Radar did not pass its isolated startup check'
    fi
    probe_radar stop >/dev/null
    PROBE_RUNNING=0
}

probe_radar() {
    PAPER_RADAR_HOME="$TMP_DIR/radar-check" \
    PAPER_RADAR_STORAGE_DIR="$TMP_DIR/radar-check/data" \
    PAPER_RADAR_DATA_DIR="$TMP_DIR/radar-check/models" \
    PAPER_RADAR_PERSONA_CONFIG="$TMP_DIR/radar-check/data/persona.json" \
    PAPER_RADAR_CODEX_BIN="$TMP_DIR/radar-check/no-model-binary" \
    AI_PERSONA_CONFIG="$TMP_DIR/radar-check/no-persona.toml" \
        "$VERSION_DIR/scripts/paper-radar" "$@"
}

current_target() {
    if [ -L "$CURRENT_LINK" ]; then
        readlink "$CURRENT_LINK"
    fi
}

json_running() {
    field=$1
    uv run --quiet --no-project --python 3.12 python -c '
import json, sys
try:
    value = json.load(sys.stdin)
    if sys.argv[1] == "worker":
        value = value.get("worker", {})
    field = "process_alive" if sys.argv[1] == "process_alive" else "running"
    raise SystemExit(0 if value.get(field) is True else 1)
except (AttributeError, TypeError, ValueError):
    raise SystemExit(1)
' "$field"
}

restart_studio() {
    launcher=$1
    if [ -n "$STUDIO_PORT" ]; then
        "$launcher" start --port "$STUDIO_PORT" --no-open
    else
        "$launcher" start --no-open
    fi
}

switch_current() {
    target=$1
    link="$INSTALL_ROOT/.current.$$"
    ln -s "$target" "$link"
    # The release environment has Python after the candidate smoke test. os.replace
    # gives identical atomic behavior on macOS and Linux, including directory symlinks.
    python="$VERSION_DIR/apps/ai-persona/.venv/bin/python"
    [ -x "$python" ] || fail 'the prepared application Python is unavailable'
    "$python" -c \
        'import os,sys; os.replace(sys.argv[1], sys.argv[2])' "$link" "$CURRENT_LINK"
}

mkdir -p "$INSTALL_ROOT/versions" "$BIN_DIR"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    fail 'another installation or update is already running'
fi
OWNS_LOCK=1

if [ -e "$CURRENT_LINK" ] && [ ! -L "$CURRENT_LINK" ]; then
    fail "refusing to replace an unmanaged current path: $CURRENT_LINK"
fi
OLD_TARGET=$(current_target || true)
case "$OLD_TARGET" in
    ""|"$INSTALL_ROOT"/versions/v*) ;;
    *) fail "the current version pointer is not managed by this installation: $OLD_TARGET" ;;
esac
if [ "$RADAR" = auto ]; then
    RADAR=0
    if [ -n "$OLD_TARGET" ] && [ -f "$OLD_TARGET/apps/paper-radar/scripts/launcher.mjs" ]; then RADAR=1; fi
fi
if [ "$RADAR" -eq 1 ]; then VERSION_DIR="$VERSION_DIR-radar"; fi
COMPONENTS='AI Persona'
if [ "$RADAR" -eq 1 ]; then COMPONENTS='AI Persona + Paper Radar'; fi
if [ "$DRY_RUN" -eq 1 ]; then
    if [ "$OLD_TARGET" = "$VERSION_DIR" ]; then
        say "$COMPONENTS $RELEASE_VERSION is already installed."
    else
        say "Would install $COMPONENTS $RELEASE_VERSION into $VERSION_DIR"
    fi
    exit 0
fi

ensure_uv
TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/personastudio-install.XXXXXX")
check_wrapper_destination "$BIN_DIR/ai-persona"
check_wrapper_destination "$BIN_DIR/ai-persona-mcp"
check_wrapper_destination "$BIN_DIR/personastudio"
if [ "$RADAR" -eq 1 ] || [ -e "$BIN_DIR/paper-radar" ] || [ -L "$BIN_DIR/paper-radar" ]; then check_wrapper_destination "$BIN_DIR/paper-radar"; fi

if [ -L "$VERSION_DIR" ]; then
    fail "refusing to use a linked version directory: $VERSION_DIR"
elif [ -d "$VERSION_DIR" ]; then
    [ -x "$VERSION_DIR/scripts/ai-persona" ] || fail "an incomplete version directory already exists: $VERSION_DIR"
    installed=$("$VERSION_DIR/scripts/ai-persona" --version 2>/dev/null || true)
    case "$installed" in *" $PACKAGE_VERSION "*|*" $PACKAGE_VERSION") ;; *) fail "the existing version directory did not pass its version check" ;; esac
    if [ "$RADAR" -eq 1 ]; then
        [ -f "$VERSION_DIR/installation.json" ] && [ -x "$VERSION_DIR/runtime/node/bin/node" ] \
            && [ -f "$VERSION_DIR/apps/paper-radar/web/dist/client/index.html" ] \
            || fail 'the existing Paper Radar installation is incomplete'
    fi
else
    archive="$TMP_DIR/$ARCHIVE_NAME"
    download_archive "$archive"
    actual=$(checksum "$archive")
    [ "$actual" = "$ARCHIVE_SHA256" ] || fail "archive checksum mismatch"
    tar -tzf "$archive" | awk -v root="PersonaStudio-$RELEASE_VERSION/" '
        index($0, root) != 1 || $0 ~ /(^|\/)\.\.($|\/)/ || $0 ~ /^\// { bad=1 }
        END { exit bad }
    ' || fail 'release archive contains an unsafe path'
    mkdir "$TMP_DIR/unpacked"
    tar -xzf "$archive" -C "$TMP_DIR/unpacked"
    candidate="$TMP_DIR/unpacked/PersonaStudio-$RELEASE_VERSION"
    [ -x "$candidate/scripts/ai-persona" ] || fail 'release archive is missing the application launcher'
    [ -x "$candidate/scripts/ai-persona-mcp" ] || fail 'release archive is missing the MCP launcher'
    [ -f "$candidate/apps/ai-persona/uv.lock" ] || fail 'release archive is missing the dependency lockfile'
    mv "$candidate" "$VERSION_DIR"
    REMOVE_VERSION_ON_EXIT=1
    say 'Preparing the locked application environment…'
    installed=$("$VERSION_DIR/scripts/ai-persona" --version)
    case "$installed" in *" $PACKAGE_VERSION "*|*" $PACKAGE_VERSION") ;; *) fail 'the downloaded version did not pass its version check' ;; esac
    if [ "$RADAR" -eq 1 ]; then prepare_radar; fi
    REMOVE_VERSION_ON_EXIT=0
fi

# The selected version is the source of truth, so rollback also restores the component choice.
"$VERSION_DIR/apps/ai-persona/.venv/bin/python" - "$VERSION_DIR/installation.json" "$RELEASE_VERSION" "$RADAR" <<'PY'
import json, pathlib, sys
pathlib.Path(sys.argv[1]).write_text(json.dumps({
    "schema": "personastudio.installation/v1", "tag": sys.argv[2],
    "components": ["ai-persona"] + (["paper-radar"] if sys.argv[3] == "1" else []),
}) + "\n")
PY
mkdir "$TMP_DIR/wrappers"
for entrypoint in ai-persona ai-persona-mcp personastudio paper-radar; do
    if [ -f "$BIN_DIR/$entrypoint" ]; then cp -p "$BIN_DIR/$entrypoint" "$TMP_DIR/wrappers/$entrypoint"; fi
done
WRAPPERS_CHANGED=1
write_wrapper "$BIN_DIR/ai-persona" ai-persona
write_wrapper "$BIN_DIR/ai-persona-mcp" ai-persona-mcp
write_wrapper "$BIN_DIR/personastudio" personastudio
if [ "$RADAR" -eq 1 ]; then write_wrapper "$BIN_DIR/paper-radar" paper-radar; fi

if [ "$OLD_TARGET" = "$VERSION_DIR" ]; then
    INSTALL_SUCCESS=1
    say "$COMPONENTS $RELEASE_VERSION is already installed."
    exit 0
fi

WAS_RUNNING=0
STUDIO_PORT=''
LEARNING_WAS_RUNNING=0
REMOTE_WAS_RUNNING=0
RADAR_WAS_RUNNING=0
if [ -n "$OLD_TARGET" ] && [ -x "$OLD_TARGET/scripts/paper-radar" ]; then
    radar_status=$("$OLD_TARGET/scripts/paper-radar" status)
    if printf '%s' "$radar_status" | json_running process_alive; then
        fail 'Paper Radar has an unresponsive process; check its logs and stop it before updating'
    fi
    if printf '%s' "$radar_status" | json_running top; then
        RADAR_WAS_RUNNING=1
        say 'Stopping Paper Radar before changing the installation…'
        "$OLD_TARGET/scripts/paper-radar" stop --for-update >/dev/null
    fi
fi
OLD_LAUNCHER=''
CONTROL_LAUNCHER="$VERSION_DIR/scripts/ai-persona"
if [ -n "$OLD_TARGET" ] && [ -x "$OLD_TARGET/scripts/ai-persona" ]; then
    OLD_LAUNCHER="$OLD_TARGET/scripts/ai-persona"
    CONTROL_LAUNCHER="$OLD_LAUNCHER"
fi
if [ -x "$CONTROL_LAUNCHER" ]; then
    status=$("$CONTROL_LAUNCHER" status 2>/dev/null || true)
    if printf '%s' "$status" | json_running top 2>/dev/null; then
        WAS_RUNNING=1
        # Keep an automatically selected or explicitly configured port on both
        # upgrade and rollback; another service may occupy the default port.
        STUDIO_PORT=$(printf '%s' "$status" | uv run --quiet --no-project --python 3.12 python -c '
import json, sys
from urllib.parse import urlsplit
value = json.load(sys.stdin).get("url")
port = urlsplit(value).port if isinstance(value, str) else None
print(port if port is not None else "")
')
    fi
    learning_status=$("$CONTROL_LAUNCHER" learning status 2>/dev/null || true)
    if printf '%s' "$learning_status" | json_running worker 2>/dev/null; then
        LEARNING_WAS_RUNNING=1
    fi
    remote_status=$("$CONTROL_LAUNCHER" remote status 2>/dev/null || true)
    if printf '%s' "$remote_status" | json_running top 2>/dev/null; then
        REMOTE_WAS_RUNNING=1
    fi
    if [ "$LEARNING_WAS_RUNNING" -eq 1 ]; then
        say 'Stopping the background learning worker after its current work…'
        "$CONTROL_LAUNCHER" learning stop-worker >/dev/null
        attempts=0
        while [ "$attempts" -lt 540 ]; do
            learning_status=$("$CONTROL_LAUNCHER" learning status 2>/dev/null || true)
            if ! printf '%s' "$learning_status" | json_running worker 2>/dev/null; then
                break
            fi
            attempts=$((attempts + 1))
            sleep 1
        done
        [ "$attempts" -lt 540 ] || fail 'the learning worker did not stop; finish active AI work and run the installer again'
    fi
    if [ "$REMOTE_WAS_RUNNING" -eq 1 ]; then
        say 'Stopping the remote gateway…'
        "$CONTROL_LAUNCHER" remote stop >/dev/null
    fi
    if [ "$WAS_RUNNING" -eq 1 ]; then
        say 'Stopping the running Studio…'
        "$CONTROL_LAUNCHER" stop >/dev/null
    fi
    "$CONTROL_LAUNCHER" models-stop >/dev/null 2>&1 || true
fi

switch_current "$VERSION_DIR"

if [ "$RESTART" -eq 1 ]; then
    restart_failed=0
    if [ "$RADAR_WAS_RUNNING" -eq 1 ] && [ "$RADAR" -eq 1 ] && ! "$BIN_DIR/paper-radar" start --no-open >/dev/null; then
        restart_failed=1
    fi
    if [ "$WAS_RUNNING" -eq 1 ] && ! restart_studio "$BIN_DIR/ai-persona" >/dev/null; then
        restart_failed=1
    fi
    if [ "$LEARNING_WAS_RUNNING" -eq 1 ] && ! "$BIN_DIR/ai-persona" learning start-worker >/dev/null; then
        restart_failed=1
    fi
    if [ "$REMOTE_WAS_RUNNING" -eq 1 ]; then
        remote_status=$("$BIN_DIR/ai-persona" remote start 2>/dev/null || true)
        if ! printf '%s' "$remote_status" | json_running top 2>/dev/null; then
            restart_failed=1
        fi
    fi
    if [ "$restart_failed" -eq 1 ]; then
        say 'The new version did not restart successfully; restoring the previous version.' >&2
        if [ -n "$OLD_TARGET" ]; then
            if [ "$RADAR" -eq 1 ]; then "$VERSION_DIR/scripts/paper-radar" stop >/dev/null 2>&1 || true; fi
            "$BIN_DIR/ai-persona" stop >/dev/null 2>&1 || true
            "$BIN_DIR/ai-persona" learning stop-worker >/dev/null 2>&1 || true
            "$BIN_DIR/ai-persona" remote stop >/dev/null 2>&1 || true
            switch_current "$OLD_TARGET"
            if [ "$RADAR_WAS_RUNNING" -eq 1 ]; then "$OLD_TARGET/scripts/paper-radar" start --no-open >/dev/null 2>&1 || true; fi
            if [ "$WAS_RUNNING" -eq 1 ]; then
                restart_studio "$OLD_LAUNCHER" >/dev/null 2>&1 || true
            fi
            if [ "$LEARNING_WAS_RUNNING" -eq 1 ]; then
                "$OLD_LAUNCHER" learning start-worker >/dev/null 2>&1 || true
            fi
            if [ "$REMOTE_WAS_RUNNING" -eq 1 ]; then
                "$OLD_LAUNCHER" remote start >/dev/null 2>&1 || true
            fi
        fi
        if [ -n "$OLD_TARGET" ]; then
            fail 'the previous version remains selected'
        fi
        fail 'the release was installed, but the previously running unmanaged Studio could not be restored; run ai-persona doctor'
    fi
fi

if [ "$RADAR" -eq 0 ] && [ -f "$BIN_DIR/paper-radar" ]; then rm "$BIN_DIR/paper-radar"; fi
INSTALL_SUCCESS=1

if [ -z "$OLD_TARGET" ]; then
    say "$COMPONENTS $RELEASE_VERSION was installed successfully."
else
    say "$COMPONENTS was updated to $RELEASE_VERSION. The previous version was kept at $OLD_TARGET"
fi
case ":$PATH:" in
    *":$BIN_DIR:"*) say 'Run: ai-persona setup' ;;
    *) say "Open a new terminal, or run: $BIN_DIR/ai-persona setup" ;;
esac
if [ "$RADAR" -eq 1 ]; then say 'Run: paper-radar start'; fi
say 'Later: personastudio install paper-radar | personastudio update | personastudio remove paper-radar'
