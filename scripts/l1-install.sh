#!/usr/bin/env bash
# Install or remove the CROT command confinement L1 components and AppArmor
# policy on Linux (ARCHITECTURE.md §27 AD-20 points 3 and 4).
#
# For source checkouts (developers) and CI only; run as root. Packages
# (WP-34) ship the same artifacts. The CROT service never runs this, never
# loads AppArmor profiles and has no setuid component.
#
#   sudo scripts/l1-install.sh install   build crot-bwrap (pinned bubblewrap
#                                         release, SHA-256 checked) and
#                                         crot-l1-init, install them in
#                                         /usr/lib/crot/l1/<v>/ (root-owned),
#                                         write manifest.json, load the policy
#   sudo scripts/l1-install.sh remove    unload the policy and remove <v>
#        scripts/l1-install.sh status    show what is installed and loaded
#
# Environment:
#   CROT_L1_BWRAP_TARBALL  use this local bubblewrap release tarball instead of
#                          downloading it (its SHA-256 is still checked)
#   CROT_L1_ABI            force the AppArmor ABI: 4.0 (Ubuntu 24.04) or 3.0
#                          (Ubuntu 22.04); default: detected
#
# Build dependencies (Ubuntu): gcc meson ninja-build pkg-config libcap-dev
# xz-utils curl apparmor (apparmor_parser).
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
components_ts="$repo/src/native-host/linux-l1/components.ts"

# Single source of truth: the version and the pinned release are read from components.ts.
v="$(sed -n 's/^export const L1_VERSION = "\([0-9A-Za-z._-]*\)";$/\1/p' "$components_ts")"
release_block="$(sed -n '/^export const BUBBLEWRAP_RELEASE = {$/,/^} as const;$/p' "$components_ts")"
bwrap_version="$(printf '%s\n' "$release_block" | sed -n 's/^ *version: "\(.*\)",$/\1/p')"
bwrap_url="$(printf '%s\n' "$release_block" | sed -n 's/^ *source: "\(.*\)",$/\1/p')"
bwrap_sha256="$(printf '%s\n' "$release_block" | sed -n 's/^ *sha256: "\([0-9a-f]\{64\}\)",$/\1/p')"
[ -n "$v" ] && [ -n "$bwrap_version" ] && [ -n "$bwrap_url" ] && [ -n "$bwrap_sha256" ] || {
  echo "l1-install: cannot read the L1 version or the bubblewrap release from $components_ts" >&2
  exit 1
}

root="/usr/lib/crot/l1"
dir="$root/$v"
policy_name="crot-l1-$v"
etc_policy="/etc/apparmor.d/$policy_name"

die() { echo "l1-install: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "missing tool: $1"; }
apparmor_enabled() { [ "$(cat /sys/module/apparmor/parameters/enabled 2>/dev/null || true)" = "Y" ]; }

detect_abi() {
  if [ -n "${CROT_L1_ABI:-}" ]; then
    case "$CROT_L1_ABI" in 4.0 | 3.0) echo "$CROT_L1_ABI"; return ;; *) die "CROT_L1_ABI must be 4.0 or 3.0" ;; esac
  fi
  # ABI 4.0 (user-namespace mediation) where the parser and the kernel support it (Ubuntu 24.04).
  if [ -f /etc/apparmor.d/abi/4.0 ] && [ -e /sys/kernel/security/apparmor/features/namespaces/userns_create ]; then
    echo 4.0
  else
    echo 3.0
  fi
}

render_policy() { # <abi> <out>
  local abi="$1" out="$2"
  if [ "$abi" = 4.0 ]; then
    sed -e "s/@V@/$v/g" -e '/^@ABI3@/d' -e 's/^@ABI4@//' "$repo/l1/apparmor/crot-l1.apparmor.in" >"$out"
  else
    sed -e "s/@V@/$v/g" -e '/^@ABI4@/d' -e 's/^@ABI3@//' "$repo/l1/apparmor/crot-l1.apparmor.in" >"$out"
  fi
  if grep -qE '@ABI[34]@|@V@' "$out"; then die "unrendered template markers in the policy"; fi
}

do_install() {
  [ "$(id -u)" = 0 ] || die "install must run as root"
  [ "$(uname -s)" = Linux ] || die "L1 is Linux only"
  for t in cc meson ninja pkg-config sha256sum tar install; do need "$t"; done
  local work
  work="$(mktemp -d)"
  trap 'rm -rf "$work"' EXIT

  # 1. The pinned bubblewrap release, verified before it is unpacked.
  local tarball="$work/bubblewrap-$bwrap_version.tar.xz"
  if [ -n "${CROT_L1_BWRAP_TARBALL:-}" ]; then
    cp "$CROT_L1_BWRAP_TARBALL" "$tarball"
  else
    need curl
    curl -fsSL --retry 3 -o "$tarball" "$bwrap_url"
  fi
  echo "$bwrap_sha256  $tarball" | sha256sum -c --quiet - || die "bubblewrap tarball SHA-256 mismatch"
  tar -xJf "$tarball" -C "$work"
  local src="$work/bubblewrap-$bwrap_version"
  (
    cd "$src"
    meson setup _build -Dman=disabled -Dbash_completion=disabled -Dzsh_completion=disabled \
      -Dselinux=disabled -Dtests=false --buildtype=release >/dev/null
    ninja -C _build bwrap >/dev/null
  )

  # 2. crot-l1-init.
  cc -O2 -Wall -Wextra -Werror -D_FORTIFY_SOURCE=2 -fstack-protector-strong -fPIE -pie \
    -o "$work/crot-l1-init" "$repo/l1/native/crot-l1-init.c"

  # 3. The policy for this release's ABI.
  local abi
  abi="$(detect_abi)"
  render_policy "$abi" "$work/crot-l1.apparmor"

  # 4. Install side by side as <v>, root-owned and not writable by the user.
  install -d -o root -g root -m 0755 /usr/lib/crot "$root"
  local stage="$root/.$v.new"
  rm -rf "$stage"
  install -d -o root -g root -m 0755 "$stage"
  install -o root -g root -m 0755 "$src/_build/bwrap" "$stage/crot-bwrap"
  install -o root -g root -m 0755 "$work/crot-l1-init" "$stage/crot-l1-init"
  install -o root -g root -m 0644 "$work/crot-l1.apparmor" "$stage/crot-l1.apparmor"
  local d_bwrap d_init d_policy
  d_bwrap="$(sha256sum "$stage/crot-bwrap" | cut -d' ' -f1)"
  d_init="$(sha256sum "$stage/crot-l1-init" | cut -d' ' -f1)"
  d_policy="$(sha256sum "$stage/crot-l1.apparmor" | cut -d' ' -f1)"
  cat >"$work/manifest.json" <<JSON
{
  "version": "$v",
  "bubblewrap": { "version": "$bwrap_version", "sha256": "$bwrap_sha256" },
  "apparmorAbi": "$abi",
  "files": {
    "crot-bwrap": "$d_bwrap",
    "crot-l1-init": "$d_init",
    "crot-l1.apparmor": "$d_policy"
  }
}
JSON
  install -o root -g root -m 0644 "$work/manifest.json" "$stage/manifest.json"
  rm -rf "$dir"
  mv "$stage" "$dir"

  # 5. Load the policy (and keep it loaded across reboots).
  if apparmor_enabled; then
    need apparmor_parser
    install -o root -g root -m 0644 "$dir/crot-l1.apparmor" "$etc_policy"
    apparmor_parser -r "$etc_policy"
    echo "l1-install: installed L1 $v in $dir, AppArmor ABI $abi, policy $policy_name loaded"
  else
    echo "l1-install: installed L1 $v in $dir; AppArmor is not enabled, the policy was not loaded"
  fi
}

do_remove() {
  [ "$(id -u)" = 0 ] || die "remove must run as root"
  if apparmor_enabled && command -v apparmor_parser >/dev/null 2>&1; then
    if [ -f "$etc_policy" ]; then
      apparmor_parser -R "$etc_policy" || true
    elif [ -f "$dir/crot-l1.apparmor" ]; then
      apparmor_parser -R "$dir/crot-l1.apparmor" || true
    fi
  fi
  rm -f "$etc_policy"
  rm -rf "$dir" "$root/.$v.new"
  rmdir "$root" 2>/dev/null || true
  rmdir /usr/lib/crot 2>/dev/null || true
  echo "l1-install: removed L1 $v"
}

do_status() {
  echo "L1 version: $v (bubblewrap $bwrap_version)"
  if [ -f "$dir/manifest.json" ]; then echo "components: $dir"; cat "$dir/manifest.json"; else echo "components: not installed"; fi
  if apparmor_enabled; then
    if [ -r /sys/kernel/security/apparmor/profiles ]; then
      grep -E "^crot-l1(-payload|-container)?-$v " /sys/kernel/security/apparmor/profiles || echo "policy: not loaded"
    else
      echo "policy: the profile list is not readable"
    fi
  else
    echo "AppArmor: not enabled"
  fi
}

case "${1:-}" in
  install) do_install ;;
  remove) do_remove ;;
  status) do_status ;;
  render-policy) render_policy "${2:?abi}" "${3:?out}" ;;
  *) echo "usage: $0 install|remove|status|render-policy <abi> <out>" >&2; exit 2 ;;
esac
