#!/bin/sh
set -eu

architecture=$1
case "$architecture" in
  x64) cpu_flags='-march=x86-64 -mtune=generic' ;;
  arm64) cpu_flags='-march=armv8-a' ;;
  *) echo "Unsupported Node architecture: $architecture" >&2; exit 1 ;;
esac
mkdir source
tar -xf node.tar.xz --strip-components=1 -C source
cd source
export CC=gcc CXX=g++
export CFLAGS="$cpu_flags"
export CXXFLAGS="$CFLAGS"
./configure --fully-static --dest-cpu="$architecture" --dest-os=linux --with-intl=full-icu
make -j3
mkdir -p /output/runtime/bin
cp out/Release/node /output/runtime/bin/node
strip --strip-debug /output/runtime/bin/node
cp LICENSE /output/runtime/LICENSE
cp config.gypi /output/runtime/build-config.gypi
cd ..
rm -rf source node.tar.xz
