#!/bin/sh
set -eu

export CFLAGS='-O2 -std=gnu99 -march=x86-64 -mtune=generic'
export LDFLAGS='-static'
prefix=/var/tmp/build/prefix
export PKG_CONFIG_LIBDIR="$prefix/lib/pkgconfig"
mkdir -p "$prefix" /output/native/bin /output/native/licenses /output/native/share/terminfo

for library in libevent ncurses; do
  mkdir "$library"
  tar -xf "$library.tar.gz" --strip-components=1 -C "$library"
  tar -xf "$library-patches.tar.xz" -C "$library"
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
tar -xf tmux.tar.gz --strip-components=1 -C tmux
cd tmux
patch -p1 -i ../tmux-paste.patch
./configure --enable-static --disable-sixel
make -j2
cp tmux /output/native/bin/tmux
cp COPYING /output/native/licenses/tmux.txt
cd ..
mkdir -p /output/native/sources
cp tmux.tar.gz /output/native/sources/tmux.tar.gz
cc -static -Wall -Wextra -Werror -O2 -march=x86-64 -mtune=generic \
  rename-noreplace.c -o /output/native/bin/rename-noreplace
"$prefix/bin/tic" -x -o /output/native/share/terminfo tmux.terminfo
[ "$(grep -c 'pairs#0x10000,' tmux.terminfo)" -eq 1 ]
sed 's/pairs#0x10000,/pairs#32767,/' tmux.terminfo >tmux-legacy.terminfo
"$prefix/bin/tic" -x -o /output/native/share/terminfo-legacy tmux-legacy.terminfo
rm -rf libevent ncurses tmux prefix ./*.tar.*
