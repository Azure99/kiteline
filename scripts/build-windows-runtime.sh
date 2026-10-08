#!/usr/bin/env bash
# pkgver and _patches are supplied by the fixed upstream PKGBUILD.
# shellcheck disable=SC2154
set -euo pipefail
export PATH=/usr/bin
export LC_ALL=C
unset BASH_ENV ENV CDPATH CONFIG_SITE LDFLAGS
inputs=$(cygpath -u "$1")
output=$(cygpath -u "$2")
upstream=$(cygpath -u "$3")
# The checked source package owns its version and ordered MSYS2 patch series.
# shellcheck disable=SC1091
source "$upstream/PKGBUILD"
cd "$output/runtime-source"
for file in "${_patches[@]}"; do
  patch -p1 -i "$upstream/$file"
done
patch -p1 -i "$inputs/native/msys/ctrl-c.patch"
(cd winsup && ./autogen.sh)
export CFLAGS="-O2 -pipe -ggdb -DCYGPORT_RELEASE_INFO=$pkgver"
export CXXFLAGS='-O2 -pipe -ggdb'
target=$(gcc -dumpmachine)
mkdir "$output/runtime-build"
cd "$output/runtime-build"
"$output/runtime-source/configure" --prefix=/usr --sysconfdir=/etc --build="$target" \
  --with-msys2-runtime-commit="$(cat "$upstream/msys2-runtime.commit")" \
  --disable-doc --disable-dumper --with-cross-bootstrap
make -j2
objcopy -g "$target/winsup/cygwin/new-msys-2.0.dll" "$output/msys-2.0.dll"
