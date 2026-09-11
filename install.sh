#!/bin/sh
# This file is a release template. scripts/build-release.py replaces the markers below.
set -eu

RELEASE_VERSION='@AI_PERSONA_RELEASE_VERSION@'
PACKAGE_VERSION=${RELEASE_VERSION#v}
ARCHIVE_NAME='@AI_PERSONA_ARCHIVE_NAME@'
ARCHIVE_SHA256='@AI_PERSONA_ARCHIVE_SHA256@'
REPOSITORY='rainshed/PersonaStudio'
MANAGED_MARKER='# Managed by the PersonaStudio installer.'

fail() {
    printf '%s\n' "AI Persona installation failed: $*" >&2
    exit 1
}

say() {
    printf '%s\n' "$*"
}

usage() {
    printf '%s\n' 'Usage: install.sh [--dry-run] [--no-restart]'
}

DRY_RUN=0
RESTART=1
while [ "$#" -gt 0 ]; do
    case "$1" in
        --dry-run) DRY_RUN=1 ;;
        --no-restart) RESTART=0 ;;
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

cleanup() {
    if [ -n "$TMP_DIR" ] && [ -d "$TMP_DIR" ]; then
        rm -rf -- "$TMP_DIR"
    fi
    if [ "$REMOVE_VERSION_ON_EXIT" -eq 1 ] && [ -d "$VERSION_DIR" ]; then
        rm -rf -- "$VERSION_DIR"
    fi
    if [ -d "$LOCK_DIR" ]; then
        rmdir "$LOCK_DIR" 2>/dev/null || true
    fi
}
trap cleanup EXIT HUP INT TERM

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
        printf '%s\n' 'export AI_PERSONA_COMMAND AI_PERSONA_MCP_COMMAND' 'unset PYTHONPATH'
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
    raise SystemExit(0 if value.get("running") is True else 1)
except (AttributeError, TypeError, ValueError):
    raise SystemExit(1)
' "$field"
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

if [ -e "$CURRENT_LINK" ] && [ ! -L "$CURRENT_LINK" ]; then
    fail "refusing to replace an unmanaged current path: $CURRENT_LINK"
fi
OLD_TARGET=$(current_target || true)
case "$OLD_TARGET" in
    ""|"$INSTALL_ROOT"/versions/v*) ;;
    *) fail "the current version pointer is not managed by this installation: $OLD_TARGET" ;;
esac
if [ "$DRY_RUN" -eq 1 ]; then
    if [ "$OLD_TARGET" = "$VERSION_DIR" ]; then
        say "AI Persona $RELEASE_VERSION is already installed."
    else
        say "Would install AI Persona $RELEASE_VERSION into $VERSION_DIR"
    fi
    exit 0
fi

ensure_uv

if [ -L "$VERSION_DIR" ]; then
    fail "refusing to use a linked version directory: $VERSION_DIR"
elif [ -d "$VERSION_DIR" ]; then
    [ -x "$VERSION_DIR/scripts/ai-persona" ] || fail "an incomplete version directory already exists: $VERSION_DIR"
    installed=$("$VERSION_DIR/scripts/ai-persona" --version 2>/dev/null || true)
    case "$installed" in *" $PACKAGE_VERSION "*|*" $PACKAGE_VERSION") ;; *) fail "the existing version directory did not pass its version check" ;; esac
else
    TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/ai-persona-install.XXXXXX")
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
    REMOVE_VERSION_ON_EXIT=0
fi

check_wrapper_destination "$BIN_DIR/ai-persona"
check_wrapper_destination "$BIN_DIR/ai-persona-mcp"
write_wrapper "$BIN_DIR/ai-persona" ai-persona
write_wrapper "$BIN_DIR/ai-persona-mcp" ai-persona-mcp

if [ "$OLD_TARGET" = "$VERSION_DIR" ]; then
    say "AI Persona $RELEASE_VERSION is already installed."
    exit 0
fi

WAS_RUNNING=0
LEARNING_WAS_RUNNING=0
REMOTE_WAS_RUNNING=0
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
    if [ "$WAS_RUNNING" -eq 1 ] && ! "$BIN_DIR/ai-persona" start --no-open >/dev/null; then
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
            "$BIN_DIR/ai-persona" stop >/dev/null 2>&1 || true
            "$BIN_DIR/ai-persona" learning stop-worker >/dev/null 2>&1 || true
            "$BIN_DIR/ai-persona" remote stop >/dev/null 2>&1 || true
            switch_current "$OLD_TARGET"
            if [ "$WAS_RUNNING" -eq 1 ]; then
                "$OLD_LAUNCHER" start --no-open >/dev/null 2>&1 || true
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

if [ -z "$OLD_TARGET" ]; then
    say "AI Persona $RELEASE_VERSION was installed successfully."
else
    say "AI Persona was updated to $RELEASE_VERSION. The previous version was kept at $OLD_TARGET"
fi
case ":$PATH:" in
    *":$BIN_DIR:"*) say 'Run: ai-persona setup' ;;
    *) say "Open a new terminal, or run: $BIN_DIR/ai-persona setup" ;;
esac
