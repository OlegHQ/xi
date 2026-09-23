#!/bin/sh
set -eu

repo=${XI_REPO:-OlegHQ/xi}
install_dir=${XI_INSTALL_DIR:-${HOME:?HOME must be set}/.local/bin}
base_url=${XI_RELEASE_URL:-https://github.com/$repo/releases}

os=$(uname -s)
arch=$(uname -m)
if [ "$os" != Linux ] || { [ "$arch" != aarch64 ] && [ "$arch" != arm64 ]; }; then
  echo "Xi installer supports Linux ARM64 only; detected $os/$arch" >&2
  exit 1
fi
if ! command -v getconf >/dev/null 2>&1 || ! getconf GNU_LIBC_VERSION >/dev/null 2>&1; then
  echo "Xi installer supports glibc; this host does not report GNU libc" >&2
  exit 1
fi

for command in tar mktemp mkdir chmod mv rm cp grep head sed; do
  command -v "$command" >/dev/null 2>&1 || { echo "Xi installer requires $command" >&2; exit 1; }
done
if command -v curl >/dev/null 2>&1; then
  download() { curl --fail --location --silent --show-error "$1" --output "$2"; }
elif command -v wget >/dev/null 2>&1; then
  download() { wget --https-only -q "$1" -O "$2"; }
else
  echo "Xi installer requires curl or wget" >&2
  exit 1
fi
if command -v sha256sum >/dev/null 2>&1; then
  verify() { (cd "$1" && sha256sum --check --status SHA256SUMS); }
elif command -v shasum >/dev/null 2>&1; then
  verify() { (cd "$1" && shasum -a 256 --check --status SHA256SUMS); }
else
  echo "Xi installer requires sha256sum or shasum" >&2
  exit 1
fi

tag=${XI_VERSION:-}
if [ -z "$tag" ]; then
  api_tmp=$(mktemp)
  trap 'rm -f "$api_tmp"' EXIT HUP INT TERM
  if ! download "https://api.github.com/repos/$repo/releases/latest" "$api_tmp"; then
    echo "Could not find the latest published Xi release" >&2
    exit 1
  fi
  tag=$(sed -n 's/^[[:space:]]*"tag_name":[[:space:]]*"\([^"]*\)".*/\1/p' "$api_tmp" | head -n 1)
  rm -f "$api_tmp"
  [ -n "$tag" ] || { echo "Latest Xi release response has no tag_name" >&2; exit 1; }
fi
version=${tag#v}
case "$version" in *[!A-Za-z0-9._+-]*|'') echo "Invalid Xi version: $tag" >&2; exit 1 ;; esac

work=$(mktemp -d)
candidate=
trap 'rm -rf "$work"; [ -z "$candidate" ] || rm -f "$candidate"' EXIT HUP INT TERM
archive="xi-$version-linux-arm64.tar.gz"
release_url="$base_url/download/$tag"
if ! download "$release_url/SHA256SUMS" "$work/SHA256SUMS" ||
   ! download "$release_url/$archive" "$work/$archive"; then
  echo "Could not download Xi $tag assets; the release may be unavailable" >&2
  exit 1
fi
if ! (cd "$work" && grep "  $archive\$" SHA256SUMS > ARCHIVE-SUM); then
  echo "SHA256SUMS does not contain $archive" >&2
  exit 1
fi
mv "$work/ARCHIVE-SUM" "$work/SHA256SUMS"
if ! verify "$work"; then
  echo "Checksum verification failed for $archive" >&2
  exit 1
fi
mkdir -p "$work/unpacked"
if ! tar -xzf "$work/$archive" -C "$work/unpacked"; then
  echo "Could not extract Xi $tag archive" >&2
  exit 1
fi
[ -f "$work/unpacked/xi" ] || { echo "Xi executable is missing from the release archive" >&2; exit 1; }
mkdir -p "$install_dir"
candidate="$install_dir/.xi.new.$$"
trap 'rm -rf "$work"; [ -z "$candidate" ] || rm -f "$candidate"' EXIT HUP INT TERM
cp "$work/unpacked/xi" "$candidate"
chmod 755 "$candidate"
mv -f "$candidate" "$install_dir/xi"
echo "Installed Xi $tag to $install_dir/xi"
