#!/bin/bash
# Checks a signed macOS build before it is released (see "macOS signing and notarization" in docs/maintenance.md).
# The Installers workflow runs it after a signed build; run it yourself on a downloaded DMG and zip in one folder.
#
#   scripts/verify-mac-release.sh <folder with the .dmg and .zip> <Apple team ID> [--skip-notarization]
#
# The DMG must pass `hdiutil verify`. In the DMG and in the update zip, Foreman.app must be signed by the team's
# Developer ID Application certificate with the Hardened Runtime and a secure timestamp, pass a strict deep
# verification, and have its notarization ticket stapled. Every Mach-O file inside must carry a valid Developer ID
# signature too: Foreman's, or the agent vendor's (build.mac.signIgnore). --skip-notarization checks a local build
# that was signed but not notarized; never use it for a release.
set -euo pipefail

dir=${1:?usage: verify-mac-release.sh <dir> <team id> [--skip-notarization]}
team=${2:?usage: verify-mac-release.sh <dir> <team id> [--skip-notarization]}
notarized=1
[ "${3:-}" = --skip-notarization ] && notarized=0

fail() { echo "::error::$*" >&2; exit 1; }

shopt -s nullglob
dmgs=("$dir"/*.dmg) zips=("$dir"/*.zip)
[ ${#dmgs[@]} -eq 1 ] && [ ${#zips[@]} -eq 1 ] || fail "Expected one .dmg and one .zip in $dir"

work=$(mktemp -d)
mounted=''
cleanup() {
  [ -z "$mounted" ] || hdiutil detach "$mounted" -quiet || true
  rm -rf "$work"
}
trap cleanup EXIT

check_app() {
  local app=$1 info
  [ -d "$app" ] || fail "No Foreman.app in $2"
  echo "--- $2: Foreman.app"
  codesign --verify --deep --strict --verbose=2 "$app" || fail "$2: Foreman.app fails strict signature verification"
  info=$(codesign -dv --verbose=4 "$app" 2>&1)
  echo "$info" | grep -E '^(Identifier|Format|CodeDirectory|Authority|Timestamp|TeamIdentifier|Runtime Version)='
  grep -q '^Authority=Developer ID Application: ' <<<"$info" || fail "$2: Foreman.app is not signed with a Developer ID Application certificate"
  grep -qx "TeamIdentifier=$team" <<<"$info" || fail "$2: Foreman.app is not signed by team $team"
  grep -q '^Timestamp=' <<<"$info" || fail "$2: Foreman.app's signature has no secure timestamp"
  grep -q 'flags=0x[0-9a-f]*(.*runtime' <<<"$info" || fail "$2: Foreman.app is not signed with the Hardened Runtime"
  codesign -d --entitlements - --xml "$app" 2>/dev/null | plutil -p - || true

  # Code in Contents/Resources (node-pty, the agents' executables, native modules) is sealed as data by the app's
  # signature, so --deep doesn't check its own signatures. The notary service and the Hardened Runtime do.
  local count=0 file sig
  : >"$work/teams"
  while IFS= read -r -d '' file; do
    [[ $(file -b "$file") == Mach-O* ]] || continue
    count=$((count + 1))
    codesign --verify --strict "$file" 2>/dev/null || fail "$2: invalid signature on ${file#"$app"/}"
    sig=$(codesign -dvv "$file" 2>&1)
    grep -q '^Authority=Developer ID Application: ' <<<"$sig" && grep -q '^Timestamp=' <<<"$sig" \
      || fail "$2: ${file#"$app"/} has no timestamped Developer ID signature"
    sed -n 's/^TeamIdentifier=//p' <<<"$sig" >>"$work/teams"
  done < <(find "$app/Contents" -type f -print0)
  echo "$count Mach-O files, signed by team (count):"
  sort "$work/teams" | uniq -c
  rm -f "$work/teams"

  if [ $notarized = 1 ]; then
    xcrun stapler validate "$app" || fail "$2: Foreman.app has no valid stapled notarization ticket"
    if spctl --status 2>&1 | grep -q 'assessments enabled'; then
      local gk
      gk=$(spctl --assess --type execute --verbose=4 "$app" 2>&1) || fail "$2: Gatekeeper rejects Foreman.app: $gk"
      echo "$gk"
      grep -q 'source=Notarized Developer ID' <<<"$gk" || fail "$2: Gatekeeper does not see Foreman.app as notarized: $gk"
    else
      echo "::warning::Gatekeeper assessments are disabled on this machine, so spctl was not run; the stapled ticket was validated."
    fi
  fi
}

echo "--- ${dmgs[0]##*/}"
hdiutil verify "${dmgs[0]}" || fail "hdiutil verify failed for ${dmgs[0]##*/}"
mkdir "$work/dmg"
hdiutil attach -nobrowse -readonly -noautoopen -mountpoint "$work/dmg" "${dmgs[0]}" >/dev/null
mounted="$work/dmg"
check_app "$work/dmg/Foreman.app" "${dmgs[0]##*/}"

mkdir "$work/zip"
ditto -x -k "${zips[0]}" "$work/zip"
check_app "$work/zip/Foreman.app" "${zips[0]##*/}"

echo "macOS release checks passed$([ $notarized = 1 ] || echo ' (notarization not checked)')."
