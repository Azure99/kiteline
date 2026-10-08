#!/bin/bash
set -euo pipefail
inputs=$1
output=$2
build=$3
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
export SDKROOT
SDKROOT=$(xcrun --show-sdk-path)
export CC
CC=$(xcrun -f clang)
export CFLAGS="-O2 -mmacosx-version-min=$MACOSX_DEPLOYMENT_TARGET"
export LDFLAGS="-mmacosx-version-min=$MACOSX_DEPLOYMENT_TARGET"
export TMPDIR="$build/tmp"
mkdir -p "$TMPDIR" "$build/libevent" "$build/tmux" "$build/flock" \
  "$output/native/bin" "$output/native/share/terminfo" "$output/native/licenses"

tar -xzf "$inputs/libevent.tar.gz" -C "$build/libevent" --strip-components=1
cd "$build/libevent"
./configure --prefix="$build/dependencies" --disable-shared --enable-static \
  --disable-openssl --disable-samples --disable-libevent-regress
make -j2
make install
cp LICENSE "$output/native/licenses/libevent.txt"

tar -xzf "$inputs/tmux.tar.gz" -C "$build/tmux" --strip-components=1
cd "$build/tmux"
patch -p1 -i "$inputs/native/tmux/paste.patch"
patch -p1 -i "$inputs/native/tmux/flow-control.patch"
# System ioctl headers can load an incomplete queue.h with the same include guard.
CPPFLAGS="-include $build/tmux/compat/queue.h" \
  LIBEVENT_CORE_CFLAGS="-I$build/dependencies/include" \
  LIBEVENT_CORE_LIBS="$build/dependencies/lib/libevent_core.a" \
  ./configure --disable-utf8proc --disable-sixel
make -j2
cp tmux "$output/native/bin/tmux"
cp COPYING "$output/native/licenses/tmux.txt"

tar -xzf "$inputs/flock.tar.gz" -C "$build/flock" --strip-components=1
cd "$build/flock"
./configure
make flock
grep -qx '#define HAVE_FLOCK 1' config.h
grep -qx '#define HAVE_SYS_FILE_H 1' config.h
cp flock "$output/native/bin/flock"
cp LICENSE.md "$output/native/licenses/flock.txt"

for helper in rename-noreplace entry-name; do
  "$CC" -Wall -Wextra -Werror -O2 "-mmacosx-version-min=$MACOSX_DEPLOYMENT_TARGET" \
    "$inputs/native/macos/$helper.c" \
    -o "$output/native/bin/$helper"
done
tic -x -o "$output/native/share/terminfo" "$inputs/native/tmux/tmux.terminfo"
TERMINFO="$output/native/share/terminfo" infocmp -x -1 tmux-256color >"$build/terminfo.actual"
for capability in 'pairs#32767,' 'AX,' 'BE=\E[?2004h,' 'BD=\E[?2004l,' \
  'Ms=\E]52;%p1%s;%p2%s\007,' 'kDC3=\E[3;3~,'; do
  grep -Fx "$(printf '\t%s' "$capability")" "$build/terminfo.actual"
done
