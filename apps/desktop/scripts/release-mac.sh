#!/usr/bin/env bash
# Builds the macOS app for Apple silicon and Intel, signs it with a Developer ID, notarizes it,
# and uploads it to a draft GitHub release for the version in package.json: the DMGs for people to
# download, and the zips with latest-mac.yml that installed copies update themselves from.
#
#   MAC_IDENTITY="Your Name (TEAMID)" NOTARY_PROFILE=parawatch-notary apps/desktop/scripts/release-mac.sh
#
# Once per machine, store notarization credentials in the keychain under NOTARY_PROFILE:
#
#   xcrun notarytool store-credentials parawatch-notary --apple-id you@example.com --team-id TEAMID
#
# The release is left as a draft; publish it on GitHub or with `gh release edit vX.Y.Z --draft=false`.
# Publishing it also publishes the CLI to npm (.github/workflows/publish.yml).
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

# electron-builder notarizes the app before it packs the DMG, so the app inside is stapled.
# Pass only the profile: notarytool keeps it outside the login keychain file, so naming that file
# with APPLE_KEYCHAIN makes the lookup fail.
APPLE_KEYCHAIN_PROFILE="$NOTARY_PROFILE" npx electron-builder --config builder.json --mac dmg zip --arm64 --x64 \
  --publish never -c.mac.identity="$MAC_IDENTITY" -c.mac.notarize=true

for app in release/mac*/Parawatch.app; do
  node scripts/check-package.cjs "$app"
  xcrun stapler validate "$app"
  spctl --assess --type execute "$app"
done

# the update feed must name both builds, or one kind of Mac never hears of the release
feed=release/latest-mac.yml
if [[ ! -f $feed ]] || ! grep -q "arm64" "$feed" || [[ $(grep -c "url: .*\.zip" "$feed") -lt 2 ]]; then
  echo "$feed is missing or does not list both zips." >&2
  exit 1
fi

files=(release/*.dmg release/*.zip release/*.zip.blockmap "$feed")
notes=$(awk -v v="## $version" 'index($0, v) == 1 { on = 1; next } /^## / { on = 0 } on' ../../CHANGELOG.md)
gh release create "$tag" "${files[@]}" --draft --title "Parawatch $version" --notes "$notes"
echo "Draft release $tag created with: ${files[*]}"
