#!/usr/bin/env bash
# Installs, upgrades or removes Sabia on Linux or macOS for the current user.
#
#   curl -fsSL <url>/install.sh | bash
#   curl -fsSL <url>/install.sh | bash -s -- --port 3443
#
# Every option also has an environment variable, which is the only way to
# pass one through `curl | bash` without a local copy of the script — see
# --help. No sudo is used anywhere; a private copy of Node and the app live
# under the install directory, and the service (systemd --user on Linux,
# a LaunchAgent on macOS) runs as the current user.
#
# Written to run under bash 3.2 (macOS's shipped bash) as well as a modern
# bash on Linux: no associative arrays, no `${var,,}`, no `mapfile`.

RELEASE_BASE_URL_DEFAULT="https://github.com/oshogun/sabia/releases/download"
API_URL_DEFAULT="https://api.github.com/repos/oshogun/sabia/releases/latest"
NODE_DIST_URL_DEFAULT="https://nodejs.org/dist"
LATEST_RELEASE_PAGE="https://github.com/oshogun/sabia/releases/latest"
LAUNCHD_LABEL="br.com.sabiaflightdb.sabia"

APP_ENTRIES="dist client package.json package-lock.json airports.json airport-tiers.json VERSION LICENSE node_modules"

# Server env vars that must never leak from the installer's own shell into a
# node process it launches (the helper CLI, setPassword.js, npm) — an
# operator running the installer with e.g. FLIGHTS_DB_PATH already exported
# for something else must not have that value hijack the install.
STRIP_VARS="PORT BIND_HOST TLS_CERT_FILE TLS_KEY_FILE INGEST_TOKEN MCP_TOKEN SESSION_SECRET FLIGHTS_DB_PATH NAVDATA_DB_PATH ALLOW_PLAINTEXT_HTTP ALLOW_UNAUTHENTICATED_INGEST PUPPETEER_CACHE_DIR"

run_node() {
  local args v
  args=()
  for v in $STRIP_VARS; do args+=(-u "$v"); done
  env "${args[@]}" "$@"
}

log() { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'USAGE'
Usage: install.sh [options]

  --version X.Y.Z         install this version instead of the latest release
  --bundle PATH_OR_URL     install from this bundle instead of a release lookup
  --install-dir DIR        install root (default: an OS-specific per-user path)
  --port N                 server port, 1024-65535 (default: 3000, or existing)
  --bind-host HOST         address to bind (default: 0.0.0.0, or existing)
  --username NAME          operator username for a new install (default: operator)
  --password-file FILE     read the operator password from this file's first line
  --tls-san a,b,c          extra Subject Alternative Names for the certificate
  --renew-cert             regenerate the TLS certificate
  --no-chromium            skip the Chromium download (PDF export will not work)
  --no-service             install the files without registering a service
  --force                  reinstall/redo the app swap even if already current
  --uninstall              remove the service and app files, keep data
  --purge                  with --uninstall, also delete the install directory
  --yes                    assume yes for confirmation prompts
  --no-linger              (Linux) do not enable linger for autostart at boot
  --help                   show this help and exit

Every option above has an environment variable equivalent (SABIA_VERSION,
SABIA_BUNDLE, SABIA_INSTALL_DIR, SABIA_PORT, SABIA_BIND_HOST,
SABIA_OPERATOR_USERNAME, SABIA_OPERATOR_PASSWORD_FILE, SABIA_TLS_SAN,
SABIA_RENEW_CERT, SABIA_NO_CHROMIUM, SABIA_NO_SERVICE, SABIA_FORCE,
SABIA_UNINSTALL, SABIA_PURGE, SABIA_YES, SABIA_NO_LINGER), which is the only
way to pass options through `curl | bash`. A password can also be supplied
non-interactively via SABIA_OPERATOR_PASSWORD (never as a flag: it would be
visible in `ps` and in shell history).
USAGE
}

# ── portable helpers ─────────────────────────────────────────────────────────

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    die "need sha256sum or shasum to verify a download"
  fi
}

verify_sha256() {
  local file="$1" shafile="$2" expected actual
  if [ ! -f "$shafile" ]; then
    warn "no checksum available for $(basename "$file"); skipping verification"
    return 0
  fi
  expected="$(awk '{print $1}' "$shafile")"
  actual="$(sha256_of "$file")"
  [ "$expected" = "$actual" ] || die "checksum mismatch for $(basename "$file")"
}

fetch_to() {
  local url="$1" out="$2"
  mkdir -p "$(dirname "$out")"
  curl -fsSL --connect-timeout 15 --retry 3 -o "$out" "$url" || die "download failed: $url"
}

xml_escape() {
  # Not `${s//&/&amp;}`: bash 5.2 (Homebrew's default on macOS) turns on
  # patsub_replacement, where an unescaped `&` in the replacement means "the
  # matched text", turning `${s//</&lt;}` into the match itself followed by
  # "lt;" instead of a literal "&lt;". sed's replacement `&` has the same
  # meaning, so it is escaped explicitly here instead.
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

to_abs_path() {
  case "$1" in
    /*) printf '%s\n' "$1" ;;
    *) printf '%s\n' "$PWD/$1" ;;
  esac
}

require_cmd() {
  local c
  for c in "$@"; do
    command -v "$c" >/dev/null 2>&1 || die "required command not found: $c"
  done
}

# ── OS / arch detection ──────────────────────────────────────────────────────

detect_os() {
  case "$(uname -s)" in
    Linux) OS=linux ;;
    Darwin) OS=darwin ;;
    *) die "unsupported operating system: $(uname -s). Use install.ps1 on Windows." ;;
  esac
}

detect_arch() {
  local m
  m="$(uname -m)"
  case "$OS" in
    linux)
      case "$m" in
        x86_64) ARCH=x64 ;;
        aarch64|arm64) ARCH=arm64 ;;
        *) die "unsupported architecture: $m" ;;
      esac
      ;;
    darwin)
      case "$m" in
        arm64) ARCH=arm64 ;;
        x86_64)
          local translated
          translated="$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)"
          if [ "$translated" = "1" ]; then ARCH=arm64; else ARCH=x64; fi
          ;;
        *) die "unsupported architecture: $m" ;;
      esac
      ;;
  esac
}

check_not_musl() {
  [ "$OS" = "linux" ] || return 0
  if [ -f /lib/ld-musl-x86_64.so.1 ] || [ -f /lib/ld-musl-aarch64.so.1 ]; then
    die "musl-based Linux (e.g. Alpine) has no private Node build here; use the Docker image instead."
  fi
  if command -v ldd >/dev/null 2>&1 && ldd --version 2>&1 | grep -qi musl; then
    die "musl-based Linux (e.g. Alpine) has no private Node build here; use the Docker image instead."
  fi
}

check_not_sudo() {
  if [ "$(id -u)" = "0" ] && [ -n "${SUDO_USER:-}" ]; then
    die "run this as the user who will own Sabia, without sudo."
  fi
}

# ── install dir ──────────────────────────────────────────────────────────────

default_root() {
  case "$OS" in
    linux) printf '%s/sabia\n' "${XDG_DATA_HOME:-$HOME/.local/share}" ;;
    darwin) printf '%s/Library/Application Support/Sabia\n' "$HOME" ;;
  esac
}

validate_install_dir() {
  case "$ROOT" in
    /*) : ;;
    *) die "install dir must be an absolute path: $ROOT" ;;
  esac
  # shellcheck disable=SC1003 # the quoted backslash below is a literal one-character pattern, not an escape attempt
  case "$ROOT" in
    *'#'*|*'%'*|*'"'*|*$'\r'*|*$'\n'*|*'\'*|*'$'*|*'`'*)
      die "install dir contains a character that is not allowed (one of # % \" \\ \$ \` or a CR/LF): $ROOT" ;;
  esac
  if [ "$ROOT" = "/" ] || [ "$ROOT" = "$HOME" ]; then
    die "install dir must not be / or your home directory: $ROOT"
  fi
}

check_root_claimable() {
  if [ -d "$ROOT" ] && [ -n "$(ls -A "$ROOT" 2>/dev/null)" ] && [ ! -f "$ROOT/.sabia-install" ]; then
    die "install dir already exists, is not empty, and is not a previous Sabia install: $ROOT"
  fi
}

# ── marker file ──────────────────────────────────────────────────────────────

read_marker() {
  MARKER_VERSION=""
  MARKER_LINGER="0"
  MARKER_INSTALLED_AT=""
  MARKER_STATE=""
  [ -f "$ROOT/.sabia-install" ] || return 0
  MARKER_VERSION="$(grep '^version=' "$ROOT/.sabia-install" | head -n1 | cut -d= -f2- || true)"
  MARKER_STATE="$(grep '^state=' "$ROOT/.sabia-install" | head -n1 | cut -d= -f2- || true)"
  MARKER_LINGER="$(grep '^linger_enabled_by_installer=' "$ROOT/.sabia-install" | head -n1 | cut -d= -f2- || true)"
  MARKER_INSTALLED_AT="$(grep '^installed_at=' "$ROOT/.sabia-install" | head -n1 | cut -d= -f2- || true)"
  local layout
  layout="$(grep '^layout=' "$ROOT/.sabia-install" | head -n1 | cut -d= -f2- || true)"
  if [ -n "$layout" ]; then
    if [ "$layout" -gt 1 ] 2>/dev/null; then
      die "this install was created by a newer install-dir layout ($layout); get a newer install.sh."
    fi
  fi
}

write_installing_marker() {
  local now
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  cat > "$ROOT/.sabia-install" <<MARKER
# Sabia install marker - written by the installer, do not edit.
layout=1
version=
node=
os=$OS
arch=$ARCH
autostart=
linger_enabled_by_installer=0
firewall_rule=0
state=installing
installed_at=$now
updated_at=$now
MARKER
}

write_marker() {
  local state="$1" now node_version installed_at
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  installed_at="${MARKER_INSTALLED_AT:-$now}"
  node_version="$(run_node "$ROOT/node/bin/node" --version 2>/dev/null | sed 's/^v//')"
  cat > "$ROOT/.sabia-install" <<MARKER
# Sabia install marker - written by the installer, do not edit.
layout=1
version=$VERSION
node=$node_version
os=$OS
arch=$ARCH
autostart=$AUTOSTART
linger_enabled_by_installer=${LINGER_ENABLED_BY_INSTALLER:-0}
firewall_rule=0
state=$state
installed_at=$installed_at
updated_at=$now
MARKER
}

mark_uninstalled() {
  local now tmp
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  tmp="$ROOT/.sabia-install.tmp"
  awk -v now="$now" '
    /^state=/ { print "state=uninstalled"; next }
    /^updated_at=/ { print "updated_at=" now; next }
    { print }
  ' "$ROOT/.sabia-install" > "$tmp"
  mv "$tmp" "$ROOT/.sabia-install"
}

# ── Node ─────────────────────────────────────────────────────────────────────

ensure_node() {
  local dist_url="${SABIA_NODE_DIST_URL:-$NODE_DIST_URL_DEFAULT}"
  local shasums="$STAGING/dl/node-SHASUMS256.txt"
  fetch_to "$dist_url/latest-v24.x/SHASUMS256.txt" "$shasums"

  local line hash file target_version current_version
  line="$(grep -E "node-v24\.[0-9]+\.[0-9]+-${OS}-${ARCH}\.tar\.gz\$" "$shasums" | head -n1 || true)"
  [ -n "$line" ] || die "could not find a Node 24 build for ${OS}-${ARCH}"
  hash="$(printf '%s' "$line" | awk '{print $1}')"
  file="$(printf '%s' "$line" | awk '{print $2}')"
  target_version="$(printf '%s' "$file" | sed -E 's/^node-v(24\.[0-9]+\.[0-9]+)-.*/\1/')"

  current_version=""
  if [ -x "$ROOT/node/bin/node" ]; then
    current_version="$(run_node "$ROOT/node/bin/node" --version 2>/dev/null | sed 's/^v//')"
  fi

  if [ "$current_version" = "$target_version" ]; then
    STAGED_NODE=0
    NODE_DIR="$ROOT/node"
    return 0
  fi

  log "Downloading Node $target_version for $OS-$ARCH ..."
  fetch_to "$dist_url/v$target_version/$file" "$STAGING/dl/$file"
  local actual
  actual="$(sha256_of "$STAGING/dl/$file")"
  [ "$actual" = "$hash" ] || die "Node download checksum mismatch for $file"

  rm -rf "$STAGING/node-extract" "$STAGING/node"
  mkdir -p "$STAGING/node-extract"
  tar -xzf "$STAGING/dl/$file" -C "$STAGING/node-extract"
  local inner
  inner="$(find "$STAGING/node-extract" -mindepth 1 -maxdepth 1 -type d | head -n1)"
  [ -n "$inner" ] || die "unexpected Node tarball layout"
  mv "$inner" "$STAGING/node"
  rm -rf "$STAGING/node-extract" "$STAGING/dl/$file"

  STAGED_NODE=1
  NODE_DIR="$STAGING/node"
}

# ── version / bundle resolution ──────────────────────────────────────────────

resolve_version() {
  [ -z "$BUNDLE" ] || return 0
  if [ -n "$VERSION" ]; then
    VERSION="${VERSION#v}"
    return 0
  fi

  local api_url="${SABIA_API_URL:-$API_URL_DEFAULT}"
  local out="$STAGING/latest.json"
  if curl -fsSL --connect-timeout 15 -o "$out" "$api_url" 2>/dev/null; then
    VERSION="$(run_node "$NODE_DIR/bin/node" -e '
      const fs = require("fs");
      let d;
      try { d = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch (e) { process.exit(1); }
      if (!d.tag_name) process.exit(1);
      process.stdout.write(String(d.tag_name).replace(/^v/, ""));
    ' "$out")" || die "could not read the latest Sabia version from $api_url"
  else
    local redirect
    redirect="$(curl -fsSLI -o /dev/null -w '%{url_effective}' "$LATEST_RELEASE_PAGE" 2>/dev/null || true)"
    VERSION="$(printf '%s' "$redirect" | sed -E 's#.*/tag/v##')"
  fi
  [ -n "$VERSION" ] || die "could not resolve the latest Sabia version; pass --version X.Y.Z"
}

resolve_bundle() {
  local base_url="${SABIA_RELEASE_BASE_URL:-$RELEASE_BASE_URL_DEFAULT}"
  local tarball="$STAGING/dl/bundle.tar.gz"
  local shafile="$STAGING/dl/bundle.tar.gz.sha256"
  mkdir -p "$STAGING/dl"

  if [ -n "$BUNDLE" ]; then
    case "$BUNDLE" in
      http://*|https://*)
        fetch_to "$BUNDLE" "$tarball"
        curl -fsSL --connect-timeout 15 -o "$shafile" "$BUNDLE.sha256" 2>/dev/null || true
        ;;
      *)
        [ -f "$BUNDLE" ] || die "--bundle path not found: $BUNDLE"
        cp "$BUNDLE" "$tarball"
        [ -f "$BUNDLE.sha256" ] && cp "$BUNDLE.sha256" "$shafile"
        ;;
    esac
  else
    log "Downloading Sabia $VERSION ..."
    fetch_to "$base_url/v$VERSION/sabia-server-$VERSION.tar.gz" "$tarball"
    fetch_to "$base_url/v$VERSION/sabia-server-$VERSION.tar.gz.sha256" "$shafile"
  fi

  verify_sha256 "$tarball" "$shafile"

  rm -rf "$STAGING/app" "$STAGING/extract"
  mkdir -p "$STAGING/extract"
  tar -xzf "$tarball" -C "$STAGING/extract"
  local inner
  inner="$(find "$STAGING/extract" -mindepth 1 -maxdepth 1 -type d | head -n1)"
  [ -n "$inner" ] || die "unexpected bundle layout"
  mv "$inner" "$STAGING/app"
  rm -rf "$STAGING/extract" "$STAGING/dl"

  [ -f "$STAGING/app/VERSION" ] || die "bundle is missing VERSION"
  local bundle_version
  bundle_version="$(tr -d '[:space:]' < "$STAGING/app/VERSION")"
  if [ -n "$BUNDLE" ]; then
    VERSION="$bundle_version"
  elif [ "$bundle_version" != "$VERSION" ]; then
    die "downloaded bundle reports version $bundle_version, expected $VERSION"
  fi
}

npm_ci() {
  local prev_path="$PATH" status v env_args
  export PATH="$NODE_DIR/bin:$PATH"
  # Built as one array, never left empty, so its `"${env_args[@]}"` expansion
  # under `set -u` is safe on bash 3.2 too (an empty array's expansion is an
  # "unbound variable" there, unlike bash >= 4.4).
  env_args=()
  for v in $STRIP_VARS; do env_args+=(-u "$v"); done
  env_args+=(PUPPETEER_CACHE_DIR="$ROOT/chrome" PUPPETEER_CHROME_HEADLESS_SHELL_SKIP_DOWNLOAD=true)
  if [ "$NO_CHROMIUM" = 1 ]; then env_args+=(PUPPETEER_SKIP_DOWNLOAD=true); fi
  if (
    cd "$STAGING/app"
    env "${env_args[@]}" "$NODE_DIR/bin/npm" ci --omit=dev --no-audit --no-fund
  ); then
    status=0
  else
    status=$?
  fi
  export PATH="$prev_path"
  [ "$status" = 0 ] || die "npm ci failed while installing dependencies"
}

smoke_test() {
  (cd "$STAGING/app" && run_node "$NODE_DIR/bin/node" -e "new (require('better-sqlite3'))(':memory:').close()") \
    || die "smoke test failed: better-sqlite3 did not load in the staged build"
}

# ── config / cert ────────────────────────────────────────────────────────────

# What port/bind-host this run would end up using, and whether that's a
# change from what's already configured. An unchanged port is our own
# service's listener (still running at this point — nothing has stopped it
# yet) and must not be probed; only an actual change is checked, and checked
# before anything is stopped or written.
precheck_port_and_host() {
  if [ -f "$ROOT/sabia.env" ]; then
    CURRENT_PORT="$(grep '^PORT=' "$ROOT/sabia.env" | tail -n1 | cut -d= -f2- || true)"
    [ -n "$CURRENT_PORT" ] || CURRENT_PORT=3000
    CURRENT_BIND_HOST="$(grep '^BIND_HOST=' "$ROOT/sabia.env" | tail -n1 | cut -d= -f2- || true)"
    [ -n "$CURRENT_BIND_HOST" ] || CURRENT_BIND_HOST=0.0.0.0
  else
    CURRENT_PORT=3000
    CURRENT_BIND_HOST=0.0.0.0
  fi

  REQUESTED_PORT="$CURRENT_PORT"
  [ "$PORT_GIVEN" != 1 ] || REQUESTED_PORT="$PORT_ARG"
  REQUESTED_BIND_HOST="$CURRENT_BIND_HOST"
  [ "$BIND_HOST_GIVEN" != 1 ] || REQUESTED_BIND_HOST="$BIND_HOST_ARG"

  # An unchanged port is only "our own listener, expected to be busy" when
  # there really is a previous, still-installed instance to have opened it.
  # A fresh install, and a reinstall of a root that was `--uninstall`-ed
  # (marker kept, but state=uninstalled, not installed), both have nothing of
  # ours listening — a foreign server there must still be caught, even if it
  # happens to sit on the same port a previous instance once used.
  PORT_CHECK_NEEDED=1
  if [ "$PRE_EXISTING_APP" = 1 ] && [ "$MARKER_STATE" = "installed" ] \
     && [ "$REQUESTED_PORT" = "$CURRENT_PORT" ] && [ "$REQUESTED_BIND_HOST" = "$CURRENT_BIND_HOST" ]; then
    PORT_CHECK_NEEDED=0
  fi
}

# Writes the merged config to a *staged* copy, never to $ROOT/sabia.env
# directly — an existing install's real config file is not touched until
# commit_and_start, after every step that can fail has already succeeded.
env_merge_step() {
  rm -f "$STAGING/sabia.env"
  [ ! -f "$ROOT/sabia.env" ] || cp "$ROOT/sabia.env" "$STAGING/sabia.env"

  local args
  args=(env-merge --file "$STAGING/sabia.env" --root "$ROOT" --default-bind-host 0.0.0.0)
  if [ "$PORT_GIVEN" = 1 ]; then args+=(--port "$PORT_ARG"); fi
  if [ "$BIND_HOST_GIVEN" = 1 ]; then args+=(--bind-host "$BIND_HOST_ARG"); fi

  run_node "$NODE_DIR/bin/node" "$CLI_JS" "${args[@]}" > "$STAGING/env-merge.json" \
    || die "writing sabia.env failed"

  run_node "$NODE_DIR/bin/node" -e '
    const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const v = d.values;
    console.log(v.BIND_HOST);
    console.log(v.TLS_CERT_FILE);
    console.log(v.TLS_KEY_FILE);
  ' "$STAGING/env-merge.json" > "$STAGING/env-merge.fields"

  {
    read -r ENV_BIND_HOST
    read -r ENV_TLS_CERT
    read -r ENV_TLS_KEY
  } < "$STAGING/env-merge.fields"
}

# Generates into staged cert/key paths, never the real ones — same reasoning
# as env_merge_step. Sets CERT_STAGED so commit_and_start and a later
# rollback know whether there is a generated cert (and a backup of the old
# one) to move.
cert_step() {
  CERT_STAGED=0
  local default_cert="$ROOT/certs/sabia.crt" default_key="$ROOT/certs/sabia.key"
  local need=0
  if [ "$ENV_TLS_CERT" = "$default_cert" ] && [ "$ENV_TLS_KEY" = "$default_key" ]; then
    if [ ! -f "$ENV_TLS_CERT" ] || [ ! -f "$ENV_TLS_KEY" ] || [ "$RENEW_CERT" = 1 ]; then
      need=1
    fi
  fi
  [ "$need" = 1 ] || return 0

  rm -rf "$STAGING/certs"
  mkdir -p "$STAGING/certs"
  local staged_cert="$STAGING/certs/sabia.crt" staged_key="$STAGING/certs/sabia.key"
  local args
  args=(cert --cert "$staged_cert" --key "$staged_key" --bind-host "$ENV_BIND_HOST" --force)
  [ -z "$TLS_SAN" ] || args+=(--san "$TLS_SAN")
  run_node "$NODE_DIR/bin/node" "$CLI_JS" "${args[@]}" || die "generating the TLS certificate failed"
  CERT_STAGED=1
}

# ── service management ───────────────────────────────────────────────────────

decide_autostart() {
  if [ "$NO_SERVICE" = 1 ]; then AUTOSTART=none; return 0; fi
  case "$OS" in
    linux)
      local uid
      uid="$(id -u)"
      if [ -z "${XDG_RUNTIME_DIR:-}" ] && [ -d "/run/user/$uid" ]; then
        export XDG_RUNTIME_DIR="/run/user/$uid"
      fi
      if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
        AUTOSTART=systemd-user
      else
        AUTOSTART=none
      fi
      ;;
    darwin)
      if command -v launchctl >/dev/null 2>&1 && launchctl print "gui/$(id -u)" >/dev/null 2>&1; then
        AUTOSTART=launchd-agent
      else
        AUTOSTART=none
      fi
      ;;
  esac
}

service_stop() {
  case "$AUTOSTART" in
    systemd-user) systemctl --user stop sabia.service 2>/dev/null || true ;;
    launchd-agent) launchctl bootout "gui/$(id -u)/$LAUNCHD_LABEL" 2>/dev/null || true ;;
  esac
}

# A 200/404/whatever-under-500 from wait-healthy only proves *something*
# answered on the configured host/port — not that it was our own service.
# The port-free probe is the primary guard against a foreign listener, but it
# only runs when the port is actually changing (see precheck_port_and_host);
# this is the belt-and-suspenders check for the case it doesn't catch: our
# own unit failing to bind (e.g. EADDRINUSE against that same foreign
# listener) while something else on the port answers the health probe.
# Minimal on purpose: the unit must be active, with a MainPID whose own
# command line is recognisably ours.
verify_own_listener() {
  case "$AUTOSTART" in
    systemd-user)
      local active mainpid cmdline
      active="$(systemctl --user is-active sabia.service 2>/dev/null || true)"
      [ "$active" = "active" ] || return 1
      mainpid="$(systemctl --user show sabia.service -p MainPID --value 2>/dev/null || true)"
      [ -n "$mainpid" ] && [ "$mainpid" != "0" ] || return 1
      if [ -r "/proc/$mainpid/cmdline" ]; then
        cmdline="$(tr '\0' ' ' < "/proc/$mainpid/cmdline" 2>/dev/null || true)"
        case "$cmdline" in
          *"$ROOT/node/bin/node"*"dist/index.js"*) return 0 ;;
          *) return 1 ;;
        esac
      fi
      return 0
      ;;
    launchd-agent)
      launchctl print "gui/$(id -u)/$LAUNCHD_LABEL" 2>/dev/null | grep -q 'state = running'
      ;;
    *)
      return 0
      ;;
  esac
}

write_service_def() {
  case "$OS" in
    linux)
      local unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
      mkdir -p "$unit_dir"
      cat > "$unit_dir/sabia.service" <<UNIT
[Unit]
Description=Sabia flight logger server

[Service]
Type=simple
WorkingDirectory=$ROOT
ExecStart="$ROOT/node/bin/node" "--env-file=$ROOT/sabia.env" dist/index.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
UNIT
      ;;
    darwin)
      local plist_dir="$HOME/Library/LaunchAgents"
      local root_xml
      root_xml="$(xml_escape "$ROOT")"
      mkdir -p "$plist_dir" "$ROOT/logs"
      cat > "$plist_dir/$LAUNCHD_LABEL.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LAUNCHD_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$root_xml/node/bin/node</string>
    <string>--env-file=$root_xml/sabia.env</string>
    <string>dist/index.js</string>
  </array>
  <key>WorkingDirectory</key><string>$root_xml</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$root_xml/logs/sabia.log</string>
  <key>StandardErrorPath</key><string>$root_xml/logs/sabia.log</string>
</dict>
</plist>
PLIST
      ;;
  esac
}

maybe_enable_linger() {
  [ "$OS" = "linux" ] || return 0
  [ "$NO_LINGER" != 1 ] || return 0
  local user current
  user="$(id -un)"
  current="no"
  if command -v loginctl >/dev/null 2>&1; then
    current="$(loginctl show-user "$user" -p Linger 2>/dev/null | cut -d= -f2 || true)"
  fi
  [ "$current" = "yes" ] && return 0
  if loginctl enable-linger "$user" 2>/dev/null; then
    LINGER_ENABLED_BY_INSTALLER=1
  else
    warn "could not enable linger automatically; Sabia will only start at login. Run: sudo loginctl enable-linger $user"
  fi
}

enable_and_start_service() {
  case "$OS" in
    linux)
      systemctl --user daemon-reload
      systemctl --user enable sabia.service
      systemctl --user restart sabia.service
      maybe_enable_linger
      ;;
    darwin)
      launchctl bootout "gui/$(id -u)/$LAUNCHD_LABEL" 2>/dev/null || true
      launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/$LAUNCHD_LABEL.plist"
      ;;
  esac
}

log_command() {
  case "$OS" in
    linux) printf 'journalctl --user -u sabia -f' ;;
    darwin) printf 'tail -f "%s/logs/sabia.log"' "$ROOT" ;;
  esac
}

# ── operator password ────────────────────────────────────────────────────────

acquire_password() {
  if [ -n "$PASSWORD_FILE" ]; then
    [ -f "$PASSWORD_FILE" ] || die "--password-file not found: $PASSWORD_FILE"
    if head -n1 "$PASSWORD_FILE" | (cd "$ROOT" && run_node "$ROOT/node/bin/node" dist/setPassword.js --username "$OPERATOR_USERNAME"); then
      return 0
    fi
    return 1
  fi
  if [ -n "${SABIA_OPERATOR_PASSWORD:-}" ]; then
    if printf '%s\n' "$SABIA_OPERATOR_PASSWORD" | (cd "$ROOT" && run_node "$ROOT/node/bin/node" dist/setPassword.js --username "$OPERATOR_USERNAME"); then
      return 0
    fi
    return 1
  fi
  # Not `[ -r /dev/tty ]`: that is true even with no controlling terminal at
  # all (e.g. under `setsid`), so a later open of it for real fails with no
  # command printed. Actually opening it is the real test.
  if { : < /dev/tty; } 2>/dev/null; then
    if (cd "$ROOT" && run_node "$ROOT/node/bin/node" dist/setPassword.js --username "$OPERATOR_USERNAME" < /dev/tty); then
      return 0
    fi
    return 1
  fi
  warn "No terminal and no password source. Before the service can be used, set the operator password with:"
  warn "  cd \"$ROOT\" && ./node/bin/node --env-file=sabia.env dist/setPassword.js"
  return 1
}

operator_status_and_password() {
  local out status
  if out="$(cd "$ROOT" && run_node "$ROOT/node/bin/node" dist/install/cli.js operator-status)"; then
    status=0
  else
    status=$?
  fi
  case "$status" in
    0) return 0 ;;
    3) : ;;
    *) die "checking the operator account failed: $out" ;;
  esac
  acquire_password || die "the operator password was not set; the service was not registered. See the command above."
}

# ── commit / rollback ────────────────────────────────────────────────────────

# The only place the running install is actually touched. Everything that
# can fail — arg validation, download/verify, npm ci, the port check,
# env-merge and cert generation into staging — has already succeeded by the
# time this runs, and the caller has just stopped any running service. Backs
# up whatever it is about to replace into .staging/old first, so a failed
# wait-healthy can put it all back.
commit_and_start() {
  # A previous run that crashed after starting a commit can leave entries
  # under .staging/old; clear it first so this run's `mv` doesn't nest into
  # a stale directory of the same name instead of replacing it.
  rm -rf "$STAGING/old"
  mkdir -p "$STAGING/old"

  [ ! -f "$ROOT/sabia.env" ] || cp -p "$ROOT/sabia.env" "$STAGING/old/sabia.env"
  if [ "$CERT_STAGED" = 1 ]; then
    mkdir -p "$STAGING/old/certs"
    [ ! -f "$ENV_TLS_CERT" ] || cp -p "$ENV_TLS_CERT" "$STAGING/old/certs/cert"
    [ ! -f "$ENV_TLS_KEY" ] || cp -p "$ENV_TLS_KEY" "$STAGING/old/certs/key"
  fi

  mkdir -p "$(dirname "$ROOT/sabia.env")"
  cp "$STAGING/sabia.env" "$ROOT/sabia.env"
  chmod 0600 "$ROOT/sabia.env" 2>/dev/null || true

  if [ "$CERT_STAGED" = 1 ]; then
    mkdir -p "$(dirname "$ENV_TLS_CERT")"
    mv "$STAGING/certs/sabia.crt" "$ENV_TLS_CERT"
    mv "$STAGING/certs/sabia.key" "$ENV_TLS_KEY"
  fi

  if [ "$SKIP_BUNDLE" = 0 ]; then
    local name
    for name in $APP_ENTRIES; do
      [ ! -e "$ROOT/$name" ] || mv "$ROOT/$name" "$STAGING/old/$name"
      mv "$STAGING/app/$name" "$ROOT/$name"
    done
    if [ "$STAGED_NODE" = 1 ]; then
      [ ! -e "$ROOT/node" ] || mv "$ROOT/node" "$STAGING/old/node"
      mv "$STAGING/node" "$ROOT/node"
    fi
  fi
}

restart_current_service() {
  [ "$AUTOSTART" != none ] || return 0
  case "$OS" in
    linux) systemctl --user restart sabia.service 2>/dev/null || true ;;
    darwin)
      launchctl bootout "gui/$(id -u)/$LAUNCHD_LABEL" 2>/dev/null || true
      launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/$LAUNCHD_LABEL.plist" 2>/dev/null || true
      ;;
  esac
}

wait_healthy_or_rollback() {
  if (cd "$ROOT" && run_node "$ROOT/node/bin/node" dist/install/cli.js wait-healthy --env-file sabia.env --timeout 60); then
    if verify_own_listener; then
      return 0
    fi
    warn "Something other than Sabia's own service answered on the configured port."
  else
    warn "Sabia did not become healthy within 60 seconds."
  fi
  # Only a run that had nothing running before it (a fresh install, still
  # marked state=installing) may leave the service down. Anything that had a
  # previous, working install — including a same-version, config-only
  # re-run — restores exactly what commit_and_start backed up and restarts
  # it, confirming it is healthy again before giving up.
  if [ "$PRE_EXISTING_APP" = 1 ]; then
    warn "Rolling back to the previous version."
    service_stop
    mkdir -p "$STAGING/failed"

    if [ -f "$STAGING/old/sabia.env" ]; then
      rm -rf "$STAGING/failed/sabia.env"
      [ ! -e "$ROOT/sabia.env" ] || mv "$ROOT/sabia.env" "$STAGING/failed/sabia.env"
      mv "$STAGING/old/sabia.env" "$ROOT/sabia.env"
    fi
    if [ -f "$STAGING/old/certs/cert" ]; then
      mkdir -p "$STAGING/failed/certs"
      [ ! -e "$ENV_TLS_CERT" ] || mv "$ENV_TLS_CERT" "$STAGING/failed/certs/cert"
      [ ! -e "$ENV_TLS_KEY" ] || mv "$ENV_TLS_KEY" "$STAGING/failed/certs/key"
      mv "$STAGING/old/certs/cert" "$ENV_TLS_CERT"
      mv "$STAGING/old/certs/key" "$ENV_TLS_KEY"
    fi
    local name
    for name in $APP_ENTRIES node; do
      if [ -e "$STAGING/old/$name" ]; then
        rm -rf "$STAGING/failed/$name"
        [ ! -e "$ROOT/$name" ] || mv "$ROOT/$name" "$STAGING/failed/$name"
        mv "$STAGING/old/$name" "$ROOT/$name"
      fi
    done

    restart_current_service
    if (cd "$ROOT" && run_node "$ROOT/node/bin/node" dist/install/cli.js wait-healthy --env-file sabia.env --timeout 30) && verify_own_listener; then
      :
    else
      warn "The previous version did not come back up healthy either; check the logs."
    fi
    die "Upgrade failed and was rolled back to the previous version. Check the logs: $(log_command)"
  else
    service_stop
    die "Install failed. The service is left installed for inspection. Check the logs: $(log_command)"
  fi
}

# ── pairing / commands ───────────────────────────────────────────────────────

print_pairing_and_commands() {
  log ""
  log "Sabia is installed at $ROOT"
  log ""
  if ! (cd "$ROOT" && run_node "$ROOT/node/bin/node" dist/install/cli.js pairing --env-file sabia.env); then
    warn "could not print the pairing block; run: cd \"$ROOT\" && ./node/bin/node dist/install/cli.js pairing --env-file sabia.env"
  fi
  log ""
  log "backup           cd \"$ROOT\" && ./node/bin/node --env-file=sabia.env dist/backup.js"
  log "reset password   cd \"$ROOT\" && ./node/bin/node --env-file=sabia.env dist/setPassword.js"
  if [ "$AUTOSTART" = none ]; then
    log "start manually   cd \"$ROOT\" && ./node/bin/node --env-file=sabia.env dist/index.js"
  else
    log "logs             $(log_command)"
  fi
}

# ── uninstall ────────────────────────────────────────────────────────────────

confirm_purge() {
  [ "$ASSUME_YES" != 1 ] || return 0
  # Not `[ -t 0 ]`: under `curl | bash`, stdin is the piped script, never a
  # terminal, even when one is attached and usable via /dev/tty directly.
  if { : < /dev/tty; } 2>/dev/null; then
    local reply
    printf 'Type "purge" to permanently delete %s: ' "$ROOT" > /dev/tty
    read -r reply < /dev/tty
    [ "$reply" = "purge" ] || die "purge cancelled."
  else
    die "--purge in a non-interactive run requires --yes."
  fi
}

do_uninstall() {
  [ -f "$ROOT/.sabia-install" ] || die "no Sabia install found at $ROOT"
  read_marker

  mkdir "$ROOT/.install.lock" 2>/dev/null || die "another install or upgrade is already in progress (lock: $ROOT/.install.lock)"
  trap '[ -d "$ROOT/.install.lock" ] && rmdir "$ROOT/.install.lock" 2>/dev/null; true' EXIT

  case "$OS" in
    linux)
      if command -v systemctl >/dev/null 2>&1; then
        systemctl --user disable --now sabia.service 2>/dev/null || true
        rm -f "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/sabia.service"
        systemctl --user daemon-reload 2>/dev/null || true
      fi
      if [ "$NO_LINGER" != 1 ] && [ "$MARKER_LINGER" = "1" ] && command -v loginctl >/dev/null 2>&1; then
        loginctl disable-linger "$(id -un)" 2>/dev/null || warn "could not disable linger automatically; run: loginctl disable-linger $(id -un)"
      fi
      ;;
    darwin)
      launchctl bootout "gui/$(id -u)/$LAUNCHD_LABEL" 2>/dev/null || true
      rm -f "$HOME/Library/LaunchAgents/$LAUNCHD_LABEL.plist"
      ;;
  esac

  local name
  for name in dist client package.json package-lock.json airports.json airport-tiers.json VERSION LICENSE node_modules node chrome bin run .staging; do
    rm -rf "${ROOT:?}/$name"
  done

  mark_uninstalled

  log "Removed the Sabia service and application files from $ROOT."
  log "Kept: sabia.env, flights.db*, flight_plans/, navdata/, backups/, certs/, logs/"

  if [ "$DO_PURGE" = 1 ]; then
    confirm_purge
    rmdir "$ROOT/.install.lock" 2>/dev/null || true
    trap - EXIT
    rm -rf "${ROOT:?}"
    log "Purged $ROOT."
  fi
}

# ── main ─────────────────────────────────────────────────────────────────────

main() {
  set -euo pipefail

  VERSION="${SABIA_VERSION:-}"
  BUNDLE="${SABIA_BUNDLE:-}"
  INSTALL_DIR_ARG="${SABIA_INSTALL_DIR:-}"
  PORT_ARG="${SABIA_PORT:-}"
  PORT_GIVEN=0; [ -z "$PORT_ARG" ] || PORT_GIVEN=1
  BIND_HOST_ARG="${SABIA_BIND_HOST:-}"
  BIND_HOST_GIVEN=0; [ -z "$BIND_HOST_ARG" ] || BIND_HOST_GIVEN=1
  OPERATOR_USERNAME="${SABIA_OPERATOR_USERNAME:-operator}"
  PASSWORD_FILE="${SABIA_OPERATOR_PASSWORD_FILE:-}"
  TLS_SAN="${SABIA_TLS_SAN:-}"
  # Only the literal value "1" turns a boolean on: SABIA_FORCE=0 (or any
  # other non-empty, non-"1" value) must not enable it.
  RENEW_CERT=0; [ "${SABIA_RENEW_CERT:-}" != "1" ] || RENEW_CERT=1
  NO_CHROMIUM=0; [ "${SABIA_NO_CHROMIUM:-}" != "1" ] || NO_CHROMIUM=1
  NO_SERVICE=0; [ "${SABIA_NO_SERVICE:-}" != "1" ] || NO_SERVICE=1
  FORCE=0; [ "${SABIA_FORCE:-}" != "1" ] || FORCE=1
  DO_UNINSTALL=0; [ "${SABIA_UNINSTALL:-}" != "1" ] || DO_UNINSTALL=1
  DO_PURGE=0; [ "${SABIA_PURGE:-}" != "1" ] || DO_PURGE=1
  ASSUME_YES=0; [ "${SABIA_YES:-}" != "1" ] || ASSUME_YES=1
  NO_LINGER=0; [ "${SABIA_NO_LINGER:-}" != "1" ] || NO_LINGER=1
  LINGER_ENABLED_BY_INSTALLER=0

  while [ $# -gt 0 ]; do
    case "$1" in
      --version) [ $# -ge 2 ] || die "--version needs a value"; VERSION="$2"; shift 2 ;;
      --bundle) [ $# -ge 2 ] || die "--bundle needs a value"; BUNDLE="$2"; shift 2 ;;
      --install-dir) [ $# -ge 2 ] || die "--install-dir needs a value"; INSTALL_DIR_ARG="$2"; shift 2 ;;
      --port) [ $# -ge 2 ] || die "--port needs a value"; PORT_ARG="$2"; PORT_GIVEN=1; shift 2 ;;
      --bind-host) [ $# -ge 2 ] || die "--bind-host needs a value"; BIND_HOST_ARG="$2"; BIND_HOST_GIVEN=1; shift 2 ;;
      --username) [ $# -ge 2 ] || die "--username needs a value"; OPERATOR_USERNAME="$2"; shift 2 ;;
      --password-file) [ $# -ge 2 ] || die "--password-file needs a value"; PASSWORD_FILE="$2"; shift 2 ;;
      --tls-san) [ $# -ge 2 ] || die "--tls-san needs a value"; TLS_SAN="$2"; shift 2 ;;
      --renew-cert) RENEW_CERT=1; shift ;;
      --no-chromium) NO_CHROMIUM=1; shift ;;
      --no-service) NO_SERVICE=1; shift ;;
      --force) FORCE=1; shift ;;
      --uninstall) DO_UNINSTALL=1; shift ;;
      --purge) DO_PURGE=1; shift ;;
      --yes) ASSUME_YES=1; shift ;;
      --no-linger) NO_LINGER=1; shift ;;
      --help|-h) usage; exit 0 ;;
      *) die "unrecognised argument: $1 (see --help)" ;;
    esac
  done

  if [ "$DO_PURGE" = 1 ] && [ "$DO_UNINSTALL" != 1 ]; then
    die "--purge requires --uninstall."
  fi

  if [ "$PORT_GIVEN" = 1 ]; then
    case "$PORT_ARG" in
      ''|*[!0-9]*) die "--port must be 1024-65535" ;;
    esac
    if [ "$PORT_ARG" -lt 1024 ] || [ "$PORT_ARG" -gt 65535 ]; then
      die "--port must be 1024-65535"
    fi
  fi

  require_cmd curl tar awk sed grep

  detect_os
  if [ "$OS" = "darwin" ]; then
    warn "macOS support is untested and unsupported: the installer has never been run on a Mac. It may work; if it doesn't, use Docker."
  fi
  detect_arch
  check_not_musl
  check_not_sudo

  if [ -n "$INSTALL_DIR_ARG" ]; then
    ROOT="$(to_abs_path "$INSTALL_DIR_ARG")"
  else
    ROOT="$(default_root)"
  fi
  validate_install_dir

  if [ "$DO_UNINSTALL" = 1 ]; then
    do_uninstall
    exit 0
  fi

  check_root_claimable
  mkdir -p "$ROOT"

  mkdir "$ROOT/.install.lock" 2>/dev/null || die "another install or upgrade is already in progress (lock: $ROOT/.install.lock)"
  STAGING="$ROOT/.staging"
  mkdir -p "$STAGING"
  trap '[ -d "$ROOT/.install.lock" ] && rmdir "$ROOT/.install.lock" 2>/dev/null; true' EXIT

  read_marker
  PRE_EXISTING_APP=0
  [ ! -f "$ROOT/dist/index.js" ] || PRE_EXISTING_APP=1

  # A root with no marker at all is either brand new or an empty dir this run
  # just adopted (check_root_claimable already required one or the other).
  # Mark it before any download, so a failure below still leaves a root a
  # re-run can resume and --uninstall can recognise and remove.
  if [ ! -f "$ROOT/.sabia-install" ]; then
    write_installing_marker
  fi

  ensure_node
  resolve_version

  SKIP_BUNDLE=0
  if [ "$MARKER_VERSION" = "$VERSION" ] && [ "$PRE_EXISTING_APP" = 1 ] && [ "$FORCE" != 1 ] && [ -z "$BUNDLE" ]; then
    SKIP_BUNDLE=1
  fi

  if [ "$SKIP_BUNDLE" = 1 ]; then
    STAGED_NODE=0
    rm -rf "$STAGING/node" 2>/dev/null || true
    NODE_DIR="$ROOT/node"
    CLI_JS="$ROOT/dist/install/cli.js"
  else
    resolve_bundle
    npm_ci
    smoke_test
    CLI_JS="$STAGING/app/dist/install/cli.js"
  fi

  decide_autostart

  # Everything from here down through cert_step must succeed — or fail
  # without touching $ROOT/sabia.env or stopping anything — with any
  # existing install's service still running. That covers a same-version,
  # config-only re-run too (SKIP_BUNDLE=1): it has no files to swap, but it
  # still runs the port check and stages a config commit exactly like an
  # upgrade does.
  precheck_port_and_host
  if [ "$PORT_CHECK_NEEDED" = 1 ]; then
    if ! run_node "$NODE_DIR/bin/node" "$CLI_JS" port-free --host "$REQUESTED_BIND_HOST" --port "$REQUESTED_PORT" >/dev/null 2>&1; then
      die "port $REQUESTED_PORT on $REQUESTED_BIND_HOST is already in use by another program; retry with --port."
    fi
  fi

  env_merge_step
  cert_step

  # Only past this point is the running install actually touched: stop
  # first, then commit_and_start backs up whatever it replaces so a failed
  # wait-healthy below can restore it.
  [ "$AUTOSTART" = none ] || service_stop
  commit_and_start

  # From here on the app at $ROOT is the one that will run.
  operator_status_and_password

  if [ "$AUTOSTART" != none ]; then
    write_service_def
    enable_and_start_service
    wait_healthy_or_rollback
  else
    warn "No user service manager is available (or --no-service was given): Sabia is installed but not registered to start automatically."
  fi

  rm -rf "$STAGING"
  write_marker installed
  print_pairing_and_commands
}

main "$@"
