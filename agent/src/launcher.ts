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
) {
  const root = source ? quote(source) : '$(dirname -- "$(dirname -- "$(readlink -f -- "$0")")")';
  // The entire body is parsed before maintenance can replace or remove this launcher.
  return `#!/bin/sh
kiteline_main() {
  kiteline_root=${root}
  kiteline_installed=${quote(paths.directory)}
  kiteline_management=${quote(paths.management)}
  kiteline_use=${quote(paths.use)}
  case "$1" in
    install|upgrade|uninstall)
      [ "$(id -u)" -eq 0 ] || { echo 'Installation changes require sudo or root' >&2; return 1; }
      umask 077
      mkdir -p -- "$(dirname -- "$kiteline_management")" || return
      exec 9>>"$kiteline_management" || return
      flock --exclusive --nonblock 9 || { echo 'Another installation operation is running' >&2; return 1; }
      if [ "$kiteline_root" = "$kiteline_installed" ]; then
        exec 8<"$kiteline_use" || return
        flock --shared --nonblock 8 || { echo 'Agent installation is being changed' >&2; return 1; }
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
        flock --shared --nonblock 8 || { echo 'Agent installation is being changed; try again after maintenance' >&2; return 1; }
      fi
      exec "$kiteline_root/runtime/bin/node" "$kiteline_root/agent/dist/main.js" "$@"
      ;;
  esac
}
kiteline_main "$@"
`;
}
