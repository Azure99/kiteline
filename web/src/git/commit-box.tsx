import { useState } from "react";
import { Check } from "lucide-react";
import type { GitStatus } from "@kiteline/shared/protocol";
import { Button } from "../components/ui/button";
import { Textarea } from "../components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { type GitActions, type GitTarget, useGitActivity } from "./actions";

export function CommitBox({
  target,
  actions,
  status,
  disabled,
  mobile,
}: {
  target: GitTarget;
  actions: GitActions;
  status?: GitStatus;
  disabled: boolean;
  mobile: boolean;
}) {
  const value = useGitActivity(actions, target);
  const [open, setOpen] = useState(false);
  const available =
    !disabled && !!status?.stagedCount && !status.hasConflicts && !!status.indexToken;
  const submit = () => {
    if (!available || !value.message.trim() || !status?.indexToken) return;
    void actions.run(
      target,
      "git.commit",
      { message: value.message, indexToken: status.indexToken },
      "提交",
    );
    setOpen(false);
  };
  const input = (
    <Textarea
      aria-label="提交消息"
      placeholder="提交消息"
      rows={3}
      value={value.message}
      onChange={(event) => actions.message(target, event.target.value)}
    />
  );
  const button = (
    <Button disabled={!available || !value.message.trim()} onClick={submit}>
      <Check />
      提交
    </Button>
  );
  if (!mobile)
    return (
      <div className="shrink-0 space-y-2 border-t border-border p-3">
        {input}
        <div className="flex justify-end">{button}</div>
      </div>
    );
  return (
    <>
      <div className="shrink-0 border-t border-border p-2">
        <Button className="w-full" disabled={!available} onClick={() => setOpen(true)}>
          <Check />
          提交
        </Button>
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>提交</DialogTitle>
          </DialogHeader>
          <div className="p-4">{input}</div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              取消
            </Button>
            {button}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
