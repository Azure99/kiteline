import {
  ArrowDown,
  ArrowUp,
  Columns2,
  Copy,
  Maximize2,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Rows2,
  Settings,
  Split,
  Trash2,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import type { Session } from "@kiteline/shared/protocol";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "../components/ui/menu";
import { Button } from "../components/ui/button";
import { groupFor, type TerminalLayout } from "./groups";

export type SessionCommand =
  | "rename"
  | "end"
  | "copy"
  | "redisplay"
  | "redraw"
  | "larger"
  | "smaller"
  | "close";
export function SessionMenu({
  id,
  session,
  layout,
  dock,
  disabled,
  label,
  onCommand,
  onMove,
  onSplit,
  onDirection,
  onSettings,
}: {
  id?: string;
  session?: Session;
  layout: TerminalLayout;
  dock?: boolean;
  disabled: boolean;
  label?: string;
  onCommand(command: SessionCommand, id: string): void;
  onMove(id: string, target?: string, before?: string): void;
  onSplit(): void;
  onDirection(direction: "horizontal" | "vertical"): void;
  onSettings(): void;
}) {
  const group = id ? groupFor(layout, id) : undefined;
  const index = group && id ? group.members.indexOf(id) : -1;
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            aria-label={label ?? (dock ? "配套终端操作" : "终端操作")}
          />
        }
      >
        <MoreHorizontal />
      </MenuTrigger>
      <MenuContent>
        <MenuItem onClick={onSettings}>
          <Settings />
          终端设置
        </MenuItem>
        {id && (
          <>
            {!dock && (
              <>
                <MenuItem disabled={disabled} onClick={onSplit}>
                  <Plus />
                  新建并分屏
                </MenuItem>
                <MenuItem disabled={!group || group.members.length < 2} onClick={() => onMove(id)}>
                  <Split />
                  拆为独立组
                </MenuItem>
                {layout.groups
                  .filter((item) => item !== group)
                  .map((item) => (
                    <MenuItem key={item.id} onClick={() => onMove(id, item.id)}>
                      <Maximize2 />
                      移入第 {layout.groups.indexOf(item) + 1} 组
                    </MenuItem>
                  ))}
                <MenuItem
                  disabled={index <= 0}
                  onClick={() => onMove(id, group!.id, group!.members[index - 1])}
                >
                  <ArrowUp />
                  向前移动
                </MenuItem>
                <MenuItem
                  disabled={!group || index === group.members.length - 1}
                  onClick={() => onMove(id, group!.id, group!.members[index + 2])}
                >
                  <ArrowDown />
                  向后移动
                </MenuItem>
                <MenuItem
                  disabled={!group || group.members.length < 2}
                  onClick={() => onDirection("horizontal")}
                >
                  <Columns2 />
                  横向分屏
                </MenuItem>
                <MenuItem
                  disabled={!group || group.members.length < 2}
                  onClick={() => onDirection("vertical")}
                >
                  <Rows2 />
                  纵向分屏
                </MenuItem>
                <div className="my-1 border-t border-border" />
              </>
            )}
            {session && (
              <>
                <MenuItem onClick={() => onCommand("redisplay", id)}>
                  <RefreshCw />
                  重新显示
                </MenuItem>
                <MenuItem onClick={() => onCommand("redraw", id)}>
                  <RefreshCw />
                  重绘程序
                </MenuItem>
              </>
            )}
            <MenuItem onClick={() => onCommand("larger", id)}>
              <ZoomIn />
              增大字号
            </MenuItem>
            <MenuItem onClick={() => onCommand("smaller", id)}>
              <ZoomOut />
              减小字号
            </MenuItem>
            {session && (
              <>
                <MenuItem onClick={() => onCommand("rename", id)}>
                  <Pencil />
                  重命名
                </MenuItem>
                <MenuItem onClick={() => onCommand("copy", id)}>
                  <Copy />
                  本机接续命令
                </MenuItem>
              </>
            )}
            <MenuItem onClick={() => onCommand("close", id)}>
              <X />
              关闭显示
            </MenuItem>
            {session && (
              <MenuItem onClick={() => onCommand("end", id)}>
                <Trash2 />
                结束会话
              </MenuItem>
            )}
          </>
        )}
      </MenuContent>
    </Menu>
  );
}
