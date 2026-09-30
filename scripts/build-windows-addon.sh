#!/bin/bash
set -euo pipefail
temporary=$(mktemp -d /var/tmp/kiteline-windows-addon-XXXXXX)
trap 'rm -rf "$temporary"' EXIT
tar -xf /inputs/node-headers.tar.gz -C "$temporary" --strip-components=1
x86_64-w64-mingw32-dlltool -d /inputs/native/windows/node.def -l "$temporary/libnode.a"
x86_64-w64-mingw32-g++-posix -std=c++20 -Wall -Wextra -Werror -O2 -shared -static \
  -Wl,--no-insert-timestamp -Wl,-Map,/output/addon.map \
  -I "$temporary/include/node" \
  /inputs/native/windows/module.cc /inputs/native/windows/system.cc \
  /inputs/native/windows/job.cc /inputs/native/windows/pipe.cc \
  /inputs/native/windows/files.cc /inputs/native/windows/network.cc \
  "$temporary/libnode.a" -ladvapi32 -lshell32 -lole32 -luuid -liphlpapi -lws2_32 \
  -o /output/kiteline-windows.node
dpkg-query -W > /output/build-packages.txt
mkdir -p /output/licenses
cp -L /usr/share/doc/gcc-mingw-w64-base/copyright /output/licenses/gcc-mingw-w64.txt
cp -L /usr/share/doc/mingw-w64-x86-64-dev/copyright /output/licenses/mingw-w64.txt
for license in GPL-3 GPL-2 LGPL-2 LGPL-2.1; do
  cp -L "/usr/share/common-licenses/$license" "/output/licenses/$license"
done
x86_64-w64-mingw32-objdump -p /output/kiteline-windows.node > /output/addon-pe.txt
