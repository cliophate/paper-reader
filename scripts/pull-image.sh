#!/bin/sh
set -eu
version=0.1.0-alpha.4
image="ghcr.io/cliophate/paper-reader:$version"
if docker pull "$image"; then
    exit 0
fi

printf '%s\n' 'Registry image unavailable. Downloading the release image archive.'
archive="paper-reader-$version-linux-amd64.tar.gz"
temporary=$(mktemp -d)
trap 'rm -f "$temporary/$archive" "$temporary/$archive.sha256"; rmdir "$temporary"' EXIT HUP INT TERM
download() {
    if command -v curl >/dev/null 2>&1; then
        curl --fail --location --retry 2 --proto '=https' --proto-redir '=https' --output "$2" "$1"
    else
        wget --https-only --output-document "$2" "$1"
    fi
}
base="https://github.com/cliophate/paper-reader/releases/download/v$version"
download "$base/$archive.sha256" "$temporary/$archive.sha256"
download "$base/$archive" "$temporary/$archive"
expected=$(awk -v name="$archive" 'NF == 2 && $2 == name && length($1) == 64 { print $1 }' "$temporary/$archive.sha256")
case "$expected" in ''|*[!0-9a-f]*) printf '%s\n' 'Invalid release checksum file.' >&2; exit 1;; esac
if command -v sha256sum >/dev/null 2>&1; then
    actual=$(sha256sum "$temporary/$archive" | cut -d ' ' -f 1)
else
    actual=$(shasum -a 256 "$temporary/$archive" | cut -d ' ' -f 1)
fi
if [ "$actual" != "$expected" ]; then
    printf '%s\n' 'Release checksum does not match. The image was not loaded.' >&2
    exit 1
fi
gzip -dc "$temporary/$archive" | docker load
loaded=$(docker image inspect "$image" --format '{{index .Config.Labels "org.opencontainers.image.version"}}')
test "$loaded" = "$version"
