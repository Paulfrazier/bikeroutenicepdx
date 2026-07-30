#!/usr/bin/env bash
#
# ship-testflight.sh — bump the build number, archive, sign, and upload to TestFlight.
# One command, no Xcode GUI, and (locally) NO App Store Connect API key.
#
#   ./ship-testflight.sh              # bump build, archive, upload
#   ./ship-testflight.sh --no-bump    # re-upload at the current build number
#   ./ship-testflight.sh --no-upload  # archive + export a signed .ipa, don't send it
#
# ── How the upload authenticates ────────────────────────────────────────────
# The ExportOptions plist below sets `destination: upload`, which makes
# `xcodebuild -exportArchive` push the build straight to App Store Connect using
# the Apple ID ALREADY SIGNED INTO XCODE. No .p8, no Transporter, no Organizer,
# no interactive 2FA. That's the whole trick, and it's why this script has no
# credential prerequisites on a dev Mac.
#
# For CI (where no Xcode account is signed in) drop an App Store Connect API key
# at ~/.appstoreconnect/private_keys/AuthKey_<KEYID>.p8 and put ASC_KEY_ID +
# ASC_ISSUER_ID in a gitignored ios/.testflight.env — the script picks it up
# automatically and passes -authenticationKey* through. Never commit the .p8.

set -euo pipefail
cd "$(cd "$(dirname "$0")" && pwd)"

PROJECT="BikeRouteNicePDX.xcodeproj"
SCHEME="BikeRouteNicePDX"
TEAM_ID="DFG7YZ82LP"
OUT="build/ship"
ARCHIVE="$OUT/$SCHEME.xcarchive"

BUMP=1
UPLOAD=1
for arg in "$@"; do
  case "$arg" in
    --no-bump)   BUMP=0 ;;
    --no-upload) UPLOAD=0 ;;
    *) echo "unknown flag: $arg"; exit 2 ;;
  esac
done

# --- optional API key (CI only; local runs use the Xcode account) -----------
AUTH=(-allowProvisioningUpdates)
if [ -f .testflight.env ]; then
  # shellcheck disable=SC1091
  source .testflight.env
  KEY_PATH="${ASC_KEY_PATH:-$HOME/.appstoreconnect/private_keys/AuthKey_${ASC_KEY_ID:-}.p8}"
  if [ -n "${ASC_KEY_ID:-}" ] && [ -f "$KEY_PATH" ]; then
    echo "▸ Auth: App Store Connect API key ${ASC_KEY_ID:0:6}…"
    AUTH+=(-authenticationKeyPath "$KEY_PATH"
           -authenticationKeyID "$ASC_KEY_ID"
           -authenticationKeyIssuerID "$ASC_ISSUER_ID")
  fi
fi
[ ${#AUTH[@]} -eq 1 ] && echo "▸ Auth: Apple ID signed into Xcode (no API key needed)"

# --- 1. bump the build number, regenerate the project ----------------------
# project.yml is the source of truth — Info.plist only holds
# $(CURRENT_PROJECT_VERSION), so the bump has to happen BEFORE xcodegen.
# MARKETING_VERSION deliberately stays put: App Store Connect only rejects a
# duplicate BUILD number, and 1.0.0 holds until the first public release.
if [ "$BUMP" -eq 1 ]; then
  CUR=$(grep -E '^[[:space:]]*CURRENT_PROJECT_VERSION:' project.yml | grep -oE '[0-9]+' | head -1)
  NEXT=$((CUR + 1))
  sed -i '' -E "s/(CURRENT_PROJECT_VERSION: )[0-9]+/\1${NEXT}/" project.yml
  echo "▸ Build number: $CUR → $NEXT"
else
  NEXT=$(grep -E '^[[:space:]]*CURRENT_PROJECT_VERSION:' project.yml | grep -oE '[0-9]+' | head -1)
  echo "▸ --no-bump: staying at build $NEXT"
fi
xcodegen generate

# --- 2. archive ------------------------------------------------------------
# Signing logs "Apple Development" here — that's expected. The distribution
# cert/profile get minted at export by -allowProvisioningUpdates.
echo "▸ Archiving (Release)…"
rm -rf "$ARCHIVE"
xcodebuild archive \
  -project "$PROJECT" -scheme "$SCHEME" -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath "$ARCHIVE" \
  DEVELOPMENT_TEAM="$TEAM_ID" "${AUTH[@]}" \
  | grep -E 'error:|warning: .*(deprecat|signing)|ARCHIVE (SUCCEEDED|FAILED)' || true

[ -d "$ARCHIVE" ] || { echo "✗ No archive produced"; exit 1; }

# Trust the artifact, not the intent: confirm the number that actually got
# baked in. A stale .xcodeproj (xcodegen skipped) silently ships the old build
# and App Store Connect rejects it as a duplicate minutes later.
BUILT=$(/usr/libexec/PlistBuddy -c 'Print :ApplicationProperties:CFBundleVersion' "$ARCHIVE/Info.plist")
SHORT=$(/usr/libexec/PlistBuddy -c 'Print :ApplicationProperties:CFBundleShortVersionString' "$ARCHIVE/Info.plist")
echo "▸ Archived $SHORT (build $BUILT)"
[ "$BUILT" = "$NEXT" ] || { echo "✗ Archive says build $BUILT but project.yml says $NEXT"; exit 1; }

# --- 3. export (and upload) ------------------------------------------------
if [ "$UPLOAD" -eq 1 ]; then DEST=upload; else DEST=export; fi
cat > "$OUT/ExportOptions.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>${DEST}</string>
  <key>teamID</key><string>${TEAM_ID}</string>
  <key>signingStyle</key><string>automatic</string>
  <key>uploadSymbols</key><true/>
</dict></plist>
PLIST

echo "▸ Export (destination=$DEST)…"
rm -rf "$OUT/$DEST"
xcodebuild -exportArchive \
  -archivePath "$ARCHIVE" \
  -exportPath "$OUT/$DEST" \
  -exportOptionsPlist "$OUT/ExportOptions.plist" \
  "${AUTH[@]}" \
  | grep -E 'error:|Upload succeeded|Uploaded |EXPORT (SUCCEEDED|FAILED)' || true

echo ""
if [ "$UPLOAD" -eq 1 ]; then
  echo "✅ Build $BUILT uploaded. TestFlight shows it in ~5–15 min once processing finishes."
  echo "   Internal testers get it immediately after that (no review)."
  echo "   External testers need the one-time Beta App Review for a new version."
else
  echo "✅ Signed .ipa at $OUT/$DEST (not uploaded)."
fi
echo "   Commit the project.yml build bump: git add ios/project.yml"
