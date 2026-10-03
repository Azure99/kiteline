#!/bin/sh
set -eu

connect() {
    if [ "$#" -ne 2 ]; then
        echo 'Usage: sh -s -- PLATFORM CODE' >&2
        exit 1
    fi
    [ -n "$2" ] || { echo 'Missing binding code; generate a connection command in the web app' >&2; exit 1; }
    for kiteline_tool in curl mktemp; do
        command -v "$kiteline_tool" >/dev/null || { echo "Missing $kiteline_tool; install curl, CA certificates and core utilities using your system package manager, then run this command again" >&2; exit 1; }
    done
    kiteline_install=$(mktemp /var/tmp/kiteline-install.XXXXXX)
    trap 'rm -f "$kiteline_install"' EXIT
    trap 'exit 129' HUP
    trap 'exit 130' INT
    trap 'exit 143' TERM
    __KITELINE_CURL__ __KITELINE_INSTALL_URL__ -o "$kiteline_install"
    sh "$kiteline_install" --server __KITELINE_ORIGIN__ --version __KITELINE_VERSION__ --platform "$1" --code "$2"
}

connect "$@"
