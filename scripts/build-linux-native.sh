#!/bin/sh
set -eu
inputs=$2

case "$1" in
  x64) cpu_flags='-march=x86-64 -mtune=generic' ;;
  arm64) cpu_flags='-march=armv8-a' ;;
  *) echo "Unsupported native architecture: $1" >&2; exit 1 ;;
esac
export CFLAGS="-O2 -std=gnu99 $cpu_flags"
export LDFLAGS='-static'
prefix=/var/tmp/build/prefix
export PKG_CONFIG_LIBDIR="$prefix/lib/pkgconfig"
mkdir -p "$prefix" /output/native/bin /output/native/licenses /output/native/share/terminfo

for library in libevent ncurses; do
  mkdir "$library"
  tar -xf "$inputs/$library.tar.gz" --strip-components=1 -C "$library"
  tar -xf "$inputs/$library-patches.tar.xz" -C "$library"
  (
    cd "$library"
    sed -e 's/#.*//' -e '/^[[:space:]]*$/d' debian/patches/series |
      while IFS= read -r patch; do
        patch -p1 -i "debian/patches/$patch"
      done
  )
done

cd libevent
./autogen.sh
./configure --prefix="$prefix" --disable-shared --enable-static --disable-openssl \
  --disable-samples --disable-libevent-regress --disable-debug-mode
make -j2
make install
cp LICENSE /output/native/licenses/libevent.txt
cd ../ncurses
./configure --prefix="$prefix" --without-shared --with-normal --without-debug \
  --enable-widec --with-termlib --without-cxx --without-cxx-binding --without-ada \
  --without-manpages --enable-pc-files --with-pkg-config-libdir="$prefix/lib/pkgconfig" \
  --with-terminfo-dirs=/etc/terminfo:/lib/terminfo:/usr/share/terminfo
make -j2
make install
cp COPYING /output/native/licenses/ncurses.txt
cd ..

mkdir tmux
tar -xf "$inputs/tmux.tar.gz" --strip-components=1 -C tmux
cd tmux
while IFS= read -r file || [ -n "$file" ]; do
  patch -p1 -i "$inputs/native/tmux/$file"
done < "$inputs/native/tmux/series"
./configure --enable-static --disable-sixel
make -j2
cp tmux /output/native/bin/tmux
cp COPYING /output/native/licenses/tmux.txt
cd ..
# The flags contain separate compiler arguments.
# shellcheck disable=SC2086
cc -static -Wall -Wextra -Werror -O2 $cpu_flags \
  "$inputs/native/linux/rename-noreplace.c" -o /output/native/bin/rename-noreplace
# shellcheck disable=SC2086
cc -static -Wall -Wextra -Werror -O2 $cpu_flags \
  "$inputs/native/terminal/pty-bridge.c" -lutil -o /output/native/bin/pty-bridge
"$prefix/bin/tic" -x -o /output/native/share/terminfo "$inputs/native/tmux/tmux.terminfo"
[ "$(grep -c 'pairs#0x10000,' "$inputs/native/tmux/tmux.terminfo")" -eq 1 ]
sed 's/pairs#0x10000,/pairs#32767,/' "$inputs/native/tmux/tmux.terminfo" >tmux-legacy.terminfo
"$prefix/bin/tic" -x -o /output/native/share/terminfo-legacy tmux-legacy.terminfo
rm -rf libevent ncurses tmux prefix
