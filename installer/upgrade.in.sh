#!/bin/sh
set -eu
[ "$#" -eq 4 ] && [ "$1" = --version ] && [ "$2" = __KITELINE_VERSION__ ] && [ "$3" = --platform ] || { echo 'The server release changed; obtain a new upgrade command from the web app' >&2; exit 1; }
kiteline_platform=$4
[ -t 0 ] || { echo 'Run this command in an interactive terminal or SSH session on the target device' >&2; exit 1; }
for kiteline_tool in curl mktemp uname id; do
  command -v "$kiteline_tool" >/dev/null || { echo "Missing $kiteline_tool; install curl, CA certificates and core utilities using your system package manager, then run this command again" >&2; exit 1; }
done
case "$kiteline_platform:$(uname -s)" in
  linux:Linux|macos:Darwin) ;;
  *) echo 'Selected platform does not match this device' >&2; exit 1 ;;
esac
case "$kiteline_platform:$(uname -m)" in
  linux:x86_64|macos:x86_64) kiteline_arch=amd64 ;;
  linux:aarch64|linux:arm64|macos:aarch64|macos:arm64) kiteline_arch=arm64 ;;
  *) echo 'No agent archive is available for this architecture' >&2; exit 1 ;;
esac
[ -x /usr/local/bin/kiteline-agent ] || { echo 'Install and bind the agent before upgrading' >&2; exit 1; }
if [ "$(id -u)" -ne 0 ]; then
  command -v sudo >/dev/null || { echo 'The upgrade requires sudo or root' >&2; exit 1; }
fi
kiteline_upgrade=$(mktemp -d /var/tmp/kiteline-agent-upgrade.XXXXXX)
trap 'rm -rf "$kiteline_upgrade"' EXIT
kiteline_interrupted=0
trap 'kiteline_interrupted=129' HUP
trap 'kiteline_interrupted=130' INT
trap 'kiteline_interrupted=143' TERM
kiteline_name="kiteline-agent-__KITELINE_ARCHIVE_VERSION__-$kiteline_platform-$kiteline_arch.tar.gz"
kiteline_base=__KITELINE_DOWNLOAD_URL__"$kiteline_name"
__KITELINE_CURL__ "$kiteline_base" -o "$kiteline_upgrade/$kiteline_name"
__KITELINE_CURL__ "$kiteline_base.sha256" -o "$kiteline_upgrade/$kiteline_name.sha256"
[ "$kiteline_interrupted" -eq 0 ] || exit "$kiteline_interrupted"
kiteline_result=0
if [ "$(id -u)" -eq 0 ]; then
  /usr/local/bin/kiteline-agent upgrade --archive "$kiteline_upgrade/$kiteline_name" || kiteline_result=$?
else
  sudo -- /usr/local/bin/kiteline-agent upgrade --archive "$kiteline_upgrade/$kiteline_name" || kiteline_result=$?
fi
[ "$kiteline_interrupted" -eq 0 ] || kiteline_result=$kiteline_interrupted
exit "$kiteline_result"
