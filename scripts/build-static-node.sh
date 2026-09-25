#!/bin/sh
set -eu

mkdir source
tar -xf node.tar.xz --strip-components=1 -C source
cd source
export CC=gcc CXX=g++
export CFLAGS='-march=x86-64 -mtune=generic'
export CXXFLAGS="$CFLAGS"
./configure --fully-static --dest-cpu=x64 --dest-os=linux --with-intl=full-icu
make -j3
mkdir -p /output/runtime/bin
cp out/Release/node /output/runtime/bin/node
strip --strip-debug /output/runtime/bin/node
cp LICENSE /output/runtime/LICENSE
cp config.gypi /output/runtime/build-config.gypi
cd ..
rm -rf source node.tar.xz
