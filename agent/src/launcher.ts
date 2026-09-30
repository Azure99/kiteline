import {
  installationManagementFile,
  installationUseFile,
  installDirectory,
} from "./installation.js";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export function agentLauncher(
  source?: string,
  paths = {
    directory: installDirectory,
    management: installationManagementFile,
    use: installationUseFile,
  },
  platform: NodeJS.Platform = process.platform,
) {
  const macos = platform === "darwin";
  const root = source
    ? `kiteline_root=${quote(source)}`
    : macos
      ? `kiteline_entry=$0 kiteline_links=0
  while [ -L "$kiteline_entry" ]; do
    kiteline_links=$((kiteline_links + 1))
    [ "$kiteline_links" -le 40 ] || { echo 'Launcher symbolic link loop' >&2; return 1; }
    kiteline_parent=$(CDPATH= cd -P -- "$(dirname -- "$kiteline_entry")" && pwd) || return
    kiteline_link=$(readlink "$kiteline_entry") || return
    case "$kiteline_link" in
      /*) kiteline_entry=$kiteline_link ;;
      *) kiteline_entry=$kiteline_parent/$kiteline_link ;;
    esac
  done
  kiteline_root=$(CDPATH= cd -P -- "$(dirname -- "$kiteline_entry")/.." && pwd) || return`
      : 'kiteline_root=$(dirname -- "$(dirname -- "$(readlink -f -- "$0")")")';
  // The entire body is parsed before maintenance can replace or remove this launcher.
  return `#!/bin/sh
kiteline_main() {
  ${root}
  kiteline_flock=${macos ? '"$kiteline_root/dist/native/bin/flock"' : "flock"}
  kiteline_installed=${quote(paths.directory)}
  kiteline_management=${quote(paths.management)}
  kiteline_use=${quote(paths.use)}
  case "$1" in
    install|upgrade|uninstall)
      [ "$(id -u)" -eq 0 ] || { echo 'Installation changes require sudo or root' >&2; return 1; }
      umask 077
      (umask 022; mkdir -p -- "$(dirname -- "$kiteline_management")") || return
      exec 9>>"$kiteline_management" || return
      "$kiteline_flock" --exclusive --nonblock 9 || { echo 'Another installation operation is running' >&2; return 1; }
      if [ "$kiteline_root" = "$kiteline_installed" ]; then
        exec 8<"$kiteline_use" || return
        "$kiteline_flock" --shared --nonblock 8 || { echo 'Agent installation is being changed' >&2; return 1; }
      fi
      kiteline_temporary=$(mktemp -d /var/tmp/kiteline-agent-maintenance.XXXXXX) || return
      kiteline_child='' kiteline_interrupted=0
      trap 'kiteline_interrupted=129; [ -z "$kiteline_child" ] || kill -HUP "$kiteline_child" 2>/dev/null || true' HUP
      trap 'kiteline_interrupted=130; [ -z "$kiteline_child" ] || kill -INT "$kiteline_child" 2>/dev/null || true' INT
      trap 'kiteline_interrupted=143; [ -z "$kiteline_child" ] || kill -TERM "$kiteline_child" 2>/dev/null || true' TERM
      kiteline_result=0
      cp -a -- "$kiteline_root" "$kiteline_temporary/package" || kiteline_result=$?
      exec 8<&-
      if [ "$kiteline_result" -eq 0 ] && [ "$kiteline_interrupted" -eq 0 ]; then
        exec 7<&0
        "$kiteline_temporary/package/runtime/bin/node" "$kiteline_temporary/package/agent/dist/main.js" "$@" <&7 7<&- &
        kiteline_child=$!
        exec 7<&-
        while :; do
          wait "$kiteline_child"
          kiteline_result=$?
          kill -0 "$kiteline_child" 2>/dev/null || break
        done
        kiteline_child=''
      fi
      if ! rm -rf -- "$kiteline_temporary"; then
        echo "Maintenance cleanup failed: $kiteline_temporary" >&2
        [ "$kiteline_result" -ne 0 ] || kiteline_result=1
      fi
      [ "$kiteline_interrupted" -eq 0 ] || kiteline_result=$kiteline_interrupted
      return "$kiteline_result"
      ;;
    *)
      if [ "$kiteline_root" = "$kiteline_installed" ]; then
        exec 8<"$kiteline_use" || return
        "$kiteline_flock" --shared --nonblock 8 || { echo 'Agent installation is being changed; try again after maintenance' >&2; return 1; }
      fi
      exec "$kiteline_root/runtime/bin/node" "$kiteline_root/agent/dist/main.js" "$@"
      ;;
  esac
}
kiteline_main "$@"
`;
}
