#!/usr/bin/env bash
# Builds the macOS app for Apple silicon and Intel, signs it with a Developer ID, notarizes it,
# and uploads the DMGs to a draft GitHub release for the version in package.json.
#
#   MAC_IDENTITY="Your Name (TEAMID)" NOTARY_PROFILE=parawatch-notary apps/desktop/scripts/release-mac.sh
#
# Once per machine, store notarization credentials in the keychain under NOTARY_PROFILE:
#
#   xcrun notarytool store-credentials parawatch-notary --apple-id you@example.com --team-id TEAMID
#
# The release is left as a draft; publish it on GitHub or with `gh release edit vX.Y.Z --draft=false`.
set -euo pipefail

cd "$(dirname "$0")/.."
: "${MAC_IDENTITY:?set MAC_IDENTITY to the Developer ID name, e.g. \"Your Name (TEAMID)\"}"
: "${NOTARY_PROFILE:?set NOTARY_PROFILE to a notarytool keychain profile}"

version=$(node -p 'require("./package.json").version')
tag="v$version"

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Commit or stash your changes first: the release is built from what is checked in." >&2
  exit 1
fi
if gh release view "$tag" >/dev/null 2>&1; then
  echo "Release $tag already exists. Bump the version or delete the draft first." >&2
  exit 1
fi
xcrun notarytool history --keychain-profile "$NOTARY_PROFILE" >/dev/null

rm -rf release
npm run build
npm run icon

# electron-builder notarizes the app before it packs the DMG, so the app inside is stapled
APPLE_KEYCHAIN="$HOME/Library/Keychains/login.keychain-db" APPLE_KEYCHAIN_PROFILE="$NOTARY_PROFILE" \
  npx electron-builder --config builder.json --mac dmg --arm64 --x64 \
  -c.mac.identity="$MAC_IDENTITY" -c.mac.notarize=true

for app in release/mac*/Parawatch.app; do
  xcrun stapler validate "$app"
  spctl --assess --type execute "$app"
done

dmgs=(release/*.dmg)
notes=$(awk -v v="## $version" 'index($0, v) == 1 { on = 1; next } /^## / { on = 0 } on' ../../CHANGELOG.md)
gh release create "$tag" "${dmgs[@]}" --draft --title "Parawatch $version" --notes "$notes"
echo "Draft release $tag created with: ${dmgs[*]}"
