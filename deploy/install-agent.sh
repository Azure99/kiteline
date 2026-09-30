#!/bin/sh
set -eu

fail() {
    printf '%s\n' "$*" >&2
    exit 1
}
server='' version='' code='' platform=''
while [ "$#" -gt 0 ]; do
    case "$1" in
    --server | --version | --code | --platform)
        [ "$#" -ge 2 ] || fail "Missing value: $1"
        case "$1" in
        --server) server=$2 ;;
        --version) version=$2 ;;
        --code) code=$2 ;;
        --platform) platform=$2 ;;
        esac
        shift 2
        ;;
    *) fail "Unknown option: $1" ;;
    esac
done
case "$server" in
https://*) protocols='=https' ;;
http://*) protocols='=http,https' ;;
*) fail "An HTTP or HTTPS server URL is required" ;;
esac
case "$version" in '' | *[!0-9A-Za-z.+-]*) fail "Invalid release version" ;; esac
[ -n "$code" ] || fail "Missing binding code; generate a new connection command in the web app"
case "$platform:$(uname -s)" in
linux:Linux | macos:Darwin) ;;
*) fail "Selected platform does not match this device" ;;
esac
case "$(uname -m)" in
x86_64) arch=amd64 ;;
aarch64 | arm64) arch=arm64 ;;
*) fail "No agent archive is available for this architecture" ;;
esac

install_hint() {
    if [ "$platform" = macos ]; then
        printf '%s' 'Restore the standard macOS curl, CA certificates, tar, gzip, shasum, Directory Services and shell utilities'
    elif command -v apk >/dev/null 2>&1; then
        printf '%s' 'apk add curl ca-certificates tar gzip coreutils musl-utils util-linux'
    elif command -v apt-get >/dev/null 2>&1; then
        printf '%s' 'apt-get update && apt-get install -y curl ca-certificates tar gzip coreutils libc-bin util-linux'
    elif command -v yum >/dev/null 2>&1; then
        printf '%s' 'yum install -y curl ca-certificates tar gzip coreutils glibc-common util-linux'
    else
        printf '%s' 'Install curl, CA certificates, tar, gzip, sha256sum, mktemp, id, getent, readlink, cp and flock using your system package manager'
    fi
}
tools='curl tar gzip mktemp id readlink cp'
if [ "$platform" = macos ]; then
    tools="$tools /usr/bin/shasum /usr/bin/dscl /usr/bin/plutil"
else
    tools="$tools sha256sum getent flock"
fi
for tool in $tools; do
    command -v "$tool" >/dev/null 2>&1 || fail "Missing $tool. Base dependencies: $(install_hint) (use root or sudo for package installation)"
done
checksum() {
    if [ "$platform" = macos ]; then /usr/bin/shasum -a 256 -c "$1"; else sha256sum -c "$1"; fi
}
[ -z "${KITELINE_AGENT_HOME+x}${KITELINE_AGENT_RUN_DIR+x}" ] || fail "The connection command uses the installation configuration. Unset KITELINE_AGENT_HOME/KITELINE_AGENT_RUN_DIR environment overrides; configure existing custom directories in /etc/kiteline-agent.env."
user=$(id -un)
if [ "$(id -u)" -ne 0 ]; then
    command -v sudo >/dev/null 2>&1 || fail "The installer requires sudo. Ask an administrator to install sudo, or manually install the complete agent package."
fi
as_root() {
    if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo -- "$@"; fi
}
agent=/usr/local/bin/kiteline-agent
if [ ! -e /etc/kiteline-agent.json ]; then
    temporary=$(mktemp -d /var/tmp/kiteline-agent-install.XXXXXX)
    trap 'rm -rf "$temporary"' EXIT
    trap 'exit 129' HUP
    trap 'exit 130' INT
    trap 'exit 143' TERM
    name="kiteline-agent-$version-$platform-$arch"
    base="$server/downloads/agent/$version/$name.tar.gz"
    curl --fail --show-error --location --proto "$protocols" --proto-redir "$protocols" "$base" -o "$temporary/$name.tar.gz"
    curl --fail --show-error --location --proto "$protocols" --proto-redir "$protocols" "$base.sha256" -o "$temporary/$name.tar.gz.sha256"
    (cd "$temporary" && checksum "$name.tar.gz.sha256")
    tar -xpzf "$temporary/$name.tar.gz" -C "$temporary" --no-same-owner
    package="$temporary/$name"
    (cd "$package" && checksum SHA256SUMS >/dev/null)
    [ "$("$package/bin/kiteline-agent" --version)" = "$version" ] || fail "Package version mismatch"
    "$package/bin/kiteline-agent" check
    kiteline_interrupted=0
    trap 'kiteline_interrupted=129' HUP
    trap 'kiteline_interrupted=130' INT
    trap 'kiteline_interrupted=143' TERM
    as_root "$package/bin/kiteline-agent" install --user "$user"
    [ "$kiteline_interrupted" -eq 0 ] || exit "$kiteline_interrupted"
    rm -rf "$temporary"
    trap - EXIT
    [ "$kiteline_interrupted" -eq 0 ] || exit "$kiteline_interrupted"
    trap - HUP INT TERM
fi
[ -x "$agent" ] || fail "An installation record exists, but $agent is missing; repair the existing installation."
[ "$("$agent" --version)" = "$version" ] || fail "A different version is installed; the existing installation was not changed. Run kiteline-agent upgrade explicitly before connecting."
"$agent" check
printf '%s\n' "$code" | "$agent" bind --server "$server" --if-unbound
printf '%s\n' 'The agent is running in the foreground here; Ctrl-C stops it and ends managed terminal tasks. To run it again: kiteline-agent run'
exec "$agent" run
