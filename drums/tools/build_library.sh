#!/usr/bin/env bash
# Builds the Pulse 16 built-in sound library: compiles the synthesizer, renders every sound,
# packs drums/library/library.zip, verifies kits.json references, and removes the temporary WAVs.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
LIB="$HERE/../library"
BUILD="$(mktemp -d)"
trap 'rm -rf "$BUILD"' EXIT

CXX="${CXX:-c++}"
"$CXX" -std=c++17 -O2 -Wall -Wextra "$HERE/make_library.cpp" -o "$BUILD/make_library"

rm -rf "$LIB/src"
mkdir -p "$LIB"
"$BUILD/make_library" "$LIB/src"

python3 "$HERE/pack_library.py" "$LIB/src" "$LIB/library.zip"
python3 "$HERE/check_library.py" "$LIB/library.zip" "$LIB/kits.json"

rm -rf "$LIB/src"
echo "Done: $LIB/library.zip"
