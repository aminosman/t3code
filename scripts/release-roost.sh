#!/bin/zsh
# Cut a Roost release: bump the version, build the macOS arm64 app with
# its auto-update manifest, verify the artifacts, commit and tag, push,
# and publish the GitHub release that Roost's updater and Ruru's installer
# both read (aminosman/t3code, assets Roost-<version>-arm64.*).
#
#   scripts/release-roost.sh <version|patch|minor> [--notes "text"] [--dry-run]
#
# --dry-run builds and verifies but writes nothing: no version bump on
# disk is kept, no commit, no tag, no push, no release.
set -euo pipefail
cd "$(dirname "$0")/.."

REPO="aminosman/t3code"
REMOTE="fork"
DRY=0
NOTES=""
SPEC=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --notes) shift; NOTES="$1" ;;
    -h|--help) sed -n 2,12p "$0"; exit 0 ;;
    *) SPEC="$1" ;;
  esac
  shift
done
[ -n "$SPEC" ] || { echo "usage: $0 <version|patch|minor> [--notes text] [--dry-run]" >&2; exit 2; }

say() { printf '\033[1m[roost]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[roost]\033[0m %s\n' "$*" >&2; exit 1; }

# --- preconditions --------------------------------------------------------
[ "$(git branch --show-current)" = "main" ] || die "release from main (on $(git branch --show-current))"
if [ -n "$(git status --porcelain | grep -v '^?? .claude/worktrees/')" ]; then
  git status --short | grep -v '^?? .claude/worktrees/' >&2
  die "the tree is not clean"
fi
command -v gh >/dev/null || die "gh is not installed"
gh auth status >/dev/null 2>&1 || die "gh is not logged in"
CARGO_BIN="$(dirname "$(rustup which cargo 2>/dev/null || true)")"
[ -x "$CARGO_BIN/cargo" ] || die "cargo not found (rustup which cargo)"
export PATH="$CARGO_BIN:$PATH"
rustup target list --installed | grep -q aarch64-apple-darwin || die "rustup target add aarch64-apple-darwin"

# --- version ---------------------------------------------------------------
CURRENT="$(node -p "require('./apps/desktop/package.json').version")"
case "$SPEC" in
  patch) VERSION="$(node -p "const [a,b,c]='$CURRENT'.split('.').map(Number); [a,b,c+1].join('.')")" ;;
  minor) VERSION="$(node -p "const [a,b]='$CURRENT'.split('.').map(Number); [a,b+1,0].join('.')")" ;;
  *) VERSION="$SPEC" ;;
esac
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "version must be x.y.z (got $VERSION)"
TAG="v$VERSION"
if git ls-remote --tags "$REMOTE" "refs/tags/$TAG" | grep -q "$TAG"; then die "$TAG already exists on $REMOTE"; fi
if gh release view "$TAG" -R "$REPO" >/dev/null 2>&1; then die "release $TAG already exists on $REPO"; fi
say "Roost $CURRENT → $VERSION ($TAG)$( [ $DRY = 1 ] && echo ', dry run')"

# Every package that carries the app version moves together.
PKGS=(apps/desktop/package.json apps/server/package.json apps/web/package.json)
for f in $PKGS; do
  node -e "
    const fs=require('fs'); const p='$f'; const j=JSON.parse(fs.readFileSync(p,'utf8'));
    if (j.version !== '$CURRENT') { console.error(p+' is at '+j.version+', not $CURRENT'); process.exit(1); }
    j.version='$VERSION'; fs.writeFileSync(p, JSON.stringify(j, null, 2)+'\n');"
done
vp fmt $PKGS >/dev/null 2>&1 || true

restore() { git checkout -q -- $PKGS 2>/dev/null || true; }
[ $DRY = 1 ] && trap restore EXIT

# --- build -----------------------------------------------------------------
OUT="release/roost-$VERSION"
rm -rf "$OUT"
say "building Roost $VERSION for macOS arm64 → $OUT"
T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR="${T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR:-true}" \
T3CODE_DESKTOP_PRODUCT_NAME=Roost \
T3CODE_DESKTOP_MAC_ICON_PNG=assets/roost/roost-macos-1024.png \
T3CODE_DESKTOP_UPDATE_REPOSITORY="$REPO" \
  node scripts/build-desktop-artifact.ts --platform mac --target dmg --arch arm64 --output-dir "$OUT"

# --- verify ----------------------------------------------------------------
ASSETS=("$OUT/Roost-$VERSION-arm64.zip" "$OUT/Roost-$VERSION-arm64.zip.blockmap"
        "$OUT/Roost-$VERSION-arm64.dmg" "$OUT/Roost-$VERSION-arm64.dmg.blockmap" "$OUT/latest-mac.yml")
for a in $ASSETS; do [ -s "$a" ] || die "missing artifact: $a"; done
grep -q "^version: $VERSION$" "$OUT/latest-mac.yml" || die "latest-mac.yml is not for $VERSION"
grep -q "Roost-$VERSION-arm64.zip" "$OUT/latest-mac.yml" || die "latest-mac.yml does not name the zip"
TMP="$(mktemp -d)"; unzip -q "$OUT/Roost-$VERSION-arm64.zip" -d "$TMP"
[ -d "$TMP/Roost.app" ] || die "the zip does not hold Roost.app"
BUILT="$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$TMP/Roost.app/Contents/Info.plist")"
[ "$BUILT" = "$VERSION" ] || die "the app says $BUILT, not $VERSION"
codesign --verify --deep "$TMP/Roost.app" 2>/dev/null || die "the app's signature does not verify"
rm -rf "$TMP"
say "artifacts verified"
du -h $ASSETS | sed 's/^/  /'

if [ $DRY = 1 ]; then say "dry run: nothing committed, tagged, pushed or released"; exit 0; fi

# --- commit, tag, push, release -------------------------------------------
git add $PKGS
git commit -q -m "release: Roost $VERSION"
git tag -a "$TAG" -m "Roost $VERSION"
git push -q "$REMOTE" main "$TAG"
say "pushed main and $TAG to $REMOTE"

if [ -z "$NOTES" ]; then
  LAST="$(git describe --tags --abbrev=0 --match 'v*' HEAD~1 2>/dev/null || true)"
  NOTES="Roost $VERSION: our build of the T3 Code fork (\`main\` @ $(git rev-parse --short HEAD))."$'\n\n'
  if [ -n "$LAST" ]; then
    NOTES+="$(git log --no-merges --format='- %s' "$LAST..HEAD~1" | grep -v '^- release:' | head -30)"$'\n\n'
  fi
  NOTES+="macOS arm64, ad-hoc signed. Same bundle id and \`~/.t3\` home as T3 Code. Auto-updates from this repo's releases."
fi
gh release create "$TAG" -R "$REPO" --title "Roost $VERSION" --notes "$NOTES" $ASSETS
say "released: https://github.com/$REPO/releases/tag/$TAG"
