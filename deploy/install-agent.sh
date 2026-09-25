#!/bin/sh
set -eu

fail() {
    printf '%s\n' "$*" >&2
    exit 1
}
server='' version='' code='' service=false
while [ "$#" -gt 0 ]; do
    case "$1" in
    --server | --version | --code)
        [ "$#" -ge 2 ] || fail "Missing value: $1"
        case "$1" in
        --server) server=$2 ;;
        --version) version=$2 ;;
        --code) code=$2 ;;
        esac
        shift 2
        ;;
    --service)
        service=true
        shift
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
[ "$(uname -s)" = Linux ] || fail "Only Linux is supported"
case "$(uname -m)" in
x86_64) arch=amd64 ;;
aarch64 | arm64) arch=arm64 ;;
*) fail "Only Linux amd64/arm64 is supported" ;;
esac

install_hint() {
    if command -v apk >/dev/null 2>&1; then
        printf '%s' 'apk add curl ca-certificates tar gzip coreutils musl-utils'
    elif command -v apt-get >/dev/null 2>&1; then
        printf '%s' 'apt-get update && apt-get install -y curl ca-certificates tar gzip coreutils libc-bin'
    elif command -v yum >/dev/null 2>&1; then
        printf '%s' 'yum install -y curl ca-certificates tar gzip coreutils glibc-common'
    else
        printf '%s' 'Install curl, CA certificates, tar, gzip, sha256sum, mktemp, id, getent and readlink using your system package manager'
    fi
}
for tool in curl tar gzip sha256sum mktemp id getent readlink; do
    command -v "$tool" >/dev/null 2>&1 || fail "Missing $tool. Base dependencies: $(install_hint) (use root or sudo for package installation)"
done
[ -z "${KITELINE_AGENT_HOME+x}${KITELINE_AGENT_RUN_DIR+x}" ] || fail "The connection command uses the installation configuration. Unset KITELINE_AGENT_HOME/KITELINE_AGENT_RUN_DIR environment overrides; configure existing custom directories in /etc/kiteline-agent.env."
user=$(id -un)
if [ "$(id -u)" -ne 0 ]; then
    command -v sudo >/dev/null 2>&1 || fail "The installer requires sudo. Ask an administrator to install sudo, or manually install the complete agent package."
fi
if "$service"; then
    [ "$(id -u)" -ne 0 ] || fail "For a background service, run this command as an existing non-root project user. Do not run the entire connection command with sudo."
    if [ ! -d /run/systemd/system ] || ! command -v systemctl >/dev/null 2>&1; then
        fail "A background service requires a running systemd instance; use foreground mode in this environment."
    fi
fi
as_root() {
    if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo -- "$@"; fi
}
agent=/usr/local/bin/kiteline-agent
if [ ! -e /etc/kiteline-agent.json ]; then
    temporary=$(mktemp -d /var/tmp/kiteline-agent-install.XXXXXX)
    trap 'rm -rf "$temporary"' EXIT
    name="kiteline-agent-$version-linux-$arch"
    base="$server/downloads/agent/$version/$name.tar.gz"
    curl --fail --show-error --location --proto "$protocols" --proto-redir "$protocols" "$base" -o "$temporary/$name.tar.gz"
    curl --fail --show-error --location --proto "$protocols" --proto-redir "$protocols" "$base.sha256" -o "$temporary/$name.tar.gz.sha256"
    (cd "$temporary" && sha256sum -c "$name.tar.gz.sha256")
    tar -xpzf "$temporary/$name.tar.gz" -C "$temporary" --no-same-owner
    package="$temporary/$name"
    (cd "$package" && sha256sum -c SHA256SUMS >/dev/null)
    [ "$("$package/bin/kiteline-agent" --version)" = "$version" ] || fail "Package version mismatch"
    "$package/bin/kiteline-agent" check
    as_root "$package/bin/kiteline-agent" install --user "$user"
    rm -rf "$temporary"
    trap - EXIT
fi
[ -x "$agent" ] || fail "An installation record exists, but $agent is missing; repair the existing installation."
[ "$("$agent" --version)" = "$version" ] || fail "A different version is installed; the existing installation was not changed. Run kiteline-agent service upgrade explicitly before connecting."
if "$service"; then as_root "$agent" service check; else "$agent" check; fi
printf '%s\n' "$code" | "$agent" bind --server "$server" --if-unbound
if "$service"; then
    as_root "$agent" service install --user "$user"
    as_root "$agent" service start
    printf '%s\n' 'The agent system service has started. Check the device list in the web app for its online status.'
else
    printf '%s\n' 'The agent is running in the foreground here; Ctrl-C stops it and ends managed terminal tasks. To run it again: kiteline-agent run'
    exec "$agent" run
fi
