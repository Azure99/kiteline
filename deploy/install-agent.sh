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
case "$server" in https://*) ;; *) fail "需要 HTTPS server 地址" ;; esac
case "$version" in '' | *[!0-9A-Za-z.+-]*) fail "无效发布版本" ;; esac
[ -n "$code" ] || fail "缺少绑定码，请在网页重新生成接入命令"
[ "$(uname -s)" = Linux ] || fail "仅支持 Linux"
case "$(uname -m)" in
x86_64) arch=amd64 ;;
aarch64 | arm64) arch=arm64 ;;
*) fail "仅支持 Linux amd64/arm64" ;;
esac

for tool in curl tar gzip sha256sum mktemp id getent readlink; do
    command -v "$tool" >/dev/null 2>&1 || fail "缺少 $tool。Ubuntu 24.04: apt-get update && apt-get install -y curl ca-certificates tar gzip coreutils libc-bin（普通用户加 sudo）"
done
[ -z "${KITELINE_AGENT_HOME+x}${KITELINE_AGENT_RUN_DIR+x}" ] || fail "接入命令使用安装配置。请取消 KITELINE_AGENT_HOME/KITELINE_AGENT_RUN_DIR 环境覆盖；已有自定义目录通过 /etc/kiteline-agent.env 配置。"
user=$(id -un)
if [ "$(id -u)" -ne 0 ]; then
    command -v sudo >/dev/null 2>&1 || fail "安装程序需要 sudo。请由管理员安装 sudo 或手工安装完整 agent 包。"
fi
if "$service"; then
    [ "$(id -u)" -ne 0 ] || fail "后台服务请以已有的非 root 项目用户执行此命令，不要 sudo 整条接入命令。"
    if [ ! -d /run/systemd/system ] || ! command -v systemctl >/dev/null 2>&1; then
        fail "后台服务需要运行中的 systemd；此环境可使用前台方式。"
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
    curl --fail --show-error --location --proto '=https' --proto-redir '=https' "$base" -o "$temporary/$name.tar.gz"
    curl --fail --show-error --location --proto '=https' --proto-redir '=https' "$base.sha256" -o "$temporary/$name.tar.gz.sha256"
    (cd "$temporary" && sha256sum --check "$name.tar.gz.sha256")
    tar -xzf "$temporary/$name.tar.gz" -C "$temporary" --no-same-owner
    package="$temporary/$name"
    (cd "$package" && sha256sum --status --check SHA256SUMS)
    [ "$("$package/bin/kiteline-agent" --version)" = "$version" ] || fail "安装包版本不匹配"
    if "$service"; then "$package/bin/kiteline-agent" check --service; else "$package/bin/kiteline-agent" check; fi
    as_root "$package/bin/kiteline-agent" install --user "$user"
    rm -rf "$temporary"
    trap - EXIT
fi
[ -x "$agent" ] || fail "安装记录存在，但缺少 $agent；请修复原安装。"
[ "$("$agent" --version)" = "$version" ] || fail "已安装其他版本；原安装未改动。请先明确执行 kiteline-agent service upgrade，再接入。"
if "$service"; then as_root "$agent" service check; else "$agent" check; fi
printf '%s\n' "$code" | "$agent" bind --server "$server" --if-unbound
if "$service"; then
    as_root "$agent" service install --user "$user"
    as_root "$agent" service start
    printf '%s\n' 'Agent 系统服务已启动，实际在线状态请查看网页设备列表。'
else
    printf '%s\n' 'Agent 在此前台运行；Ctrl-C 停止并结束受管终端任务。再次运行：kiteline-agent run'
    exec "$agent" run
fi
