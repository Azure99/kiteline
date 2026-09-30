#!/usr/bin/env bash
set -euo pipefail
export PATH=/usr/bin
export LC_ALL=C.UTF-8
export CONFIG_SITE=/etc/config.site
export CFLAGS='-O2 -g0'
export LDFLAGS='-Wl,--no-insert-timestamp'
unset BASH_ENV ENV CDPATH
inputs=$(cygpath -u "$1")
output=$(cygpath -u "$2")
mkdir -p "$output/source" "$output/terminfo"
cd "$output/source"
tar -xf "$inputs/tmux.tar.gz" --strip-components=1
patch -p1 -i "$inputs/native/tmux-paste.patch"
patch -p1 -i "$inputs/native/tmux-cygwin-outfd.patch"
./configure --disable-sixel --prefix=/usr/local
make -j2
cp tmux.exe "$output/tmux.exe"
cp COPYING "$output/tmux-LICENSE"
cp cmd-parse.c "$output/cmd-parse.c"
tic -x -o "$output/terminfo" "$inputs/native/tmux.terminfo"
cp /etc/config.site "$output/config.site"
gcc --version > "$output/gcc-version.txt"
./tmux.exe -V
