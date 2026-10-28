import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, test, vi } from "vitest";
import type { GitOperation, GitReview } from "@kiteline/shared/protocol";
import { GitActions, type GitTarget } from "../src/git/actions";
import { GitFeedback } from "../src/git/feedback";
import { DiscardSummary } from "../src/git/change-actions";
import { OperationBar } from "../src/git/operation-bar";
import { TooltipProvider } from "../src/components/ui/tooltip";
import { ApiError } from "../src/lib/api";
import { setLanguagePreference } from "../src/i18n";

vi.mock("../src/git/actions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/git/actions")>()),
  useGitActivity: (store: GitActions, target: GitTarget) => store.get(target),
}));

const target = { deviceId: "device", workspaceId: "workspace", repoId: "repo" };
function render(element: ReactElement) {
  return renderToStaticMarkup(createElement(TooltipProvider, null, element));
}
function feedback(actions: GitActions) {
  return render(createElement(GitFeedback, { actions, target, onLocate() {}, onTerminal() {} }));
}

afterEach(async () => {
  await setLanguagePreference("auto");
});

test.each([
  ["failed", "Not completed"],
  ["unknown", "Result unconfirmed"],
  ["partial", "Partially completed"],
])("Git feedback preserves the %s outcome and full diagnostics", async (outcome, label) => {
  await setLanguagePreference("en");
  const actions = new GitActions();
  const value = actions.get(target);
  const stderr = "first diagnostic\nsecond diagnostic\n";
  value.lastMethod = "git.stage";
  value.error = new ApiError(
    "io_error",
    stderr.trim(),
    outcome,
    { blockedPaths: ["blocked.txt"], invalidPaths: ["invalid bytes"], truncated: true },
    {
      stdout: "standard output\n",
      stderr,
      truncated: true,
      changedPaths: outcome === "partial" ? ["changed.txt"] : [],
    },
  );
  const markup = feedback(actions);
  expect(markup).toContain(`Stage · ${label}`);
  expect(markup).toContain("standard output\n");
  expect(markup).toContain(stderr);
  expect(markup.match(/first diagnostic/g)).toHaveLength(1);
  expect(markup).toContain("Only the beginning of the output was retained");
  if (outcome === "partial") expect(markup).toContain("changed.txt");
  expect(markup).toContain("blocked.txt");
  expect(markup).toContain("Non-UTF-8 path: invalid bytes");
  expect(markup).toContain("Additional blocking paths are not shown");
  expect(markup).toContain("io_error");
  expect(markup).toContain("blockedPaths");
  expect(markup).toContain('aria-label="Close"');
});

test("Git feedback merges identical streams while retaining a distinct error message", async () => {
  await setLanguagePreference("en");
  const actions = new GitActions();
  const value = actions.get(target);
  value.lastMethod = "git.fetch";
  value.error = new ApiError("io_error", "connection interrupted", "unknown", undefined, {
    stdout: "same output\nnext line\n",
    stderr: "same output\nnext line\n",
  });
  const markup = feedback(actions);
  expect(markup).toContain("connection interrupted\nsame output\nnext line\n");
  expect(markup.match(/same output/g)).toHaveLength(1);
});

test("pending feedback offers cancellation without dismissal and successful index changes stay silent", async () => {
  await setLanguagePreference("en");
  const actions = new GitActions();
  const value = actions.get(target);
  value.request = { id: "request", method: "git.fetch", phase: "queued", cancelling: false };
  const markup = feedback(actions);
  expect(markup).toContain("Fetch · queued");
  expect(markup).toContain("Cancel operation");
  expect(markup).not.toContain('aria-label="Close"');
  value.request = undefined;
  for (const method of ["git.stage", "git.unstage"] as const) {
    value.completed = method;
    value.lastMethod = method;
    expect(feedback(actions)).toBe("");
  }
});

test("successful feedback names Fetch and shows the actual commit OID for a commit", async () => {
  await setLanguagePreference("en");
  const actions = new GitActions();
  const value = actions.get(target);
  value.completed = value.lastMethod = "git.fetch";
  value.result = { stdout: "Fetched refs\n", stderr: "", truncated: false };
  expect(feedback(actions)).toContain("Fetch · Completed");
  expect(feedback(actions)).toContain("Fetched refs\n");
  const oid = "0123456789abcdef0123456789abcdef01234567";
  value.completed = value.lastMethod = "git.commit";
  value.result = { commitOid: oid };
  const markup = feedback(actions);
  expect(markup).toContain(`title="${oid}"`);
  expect(markup).toContain("Commit: 01234567");
});

test.each([
  [
    "en",
    "worktree",
    "Delete 2 items",
    "Restore 1 item to the staged version",
    "Deleted files are not moved to the trash.",
  ],
  [
    "en",
    "all",
    "Delete 2 items",
    "Restore 1 item to HEAD",
    "Deleted files are not moved to the trash.",
  ],
  ["zh-CN", "worktree", "删除 2 项", "恢复为暂存区中的版本：1 项", "删除时不使用回收站。"],
  ["zh-CN", "all", "删除 2 项", "恢复为 HEAD 中的版本：1 项", "删除时不使用回收站。"],
] as const)(
  "discard review groups actual actions with the %s/%s restore source",
  async (language, scope, deletes, restores, warning) => {
    await setLanguagePreference(language);
    const summary: GitReview["summary"] = [
      { path: "restore.txt", action: "restore" },
      { path: "delete one.txt", action: "delete" },
      { path: "delete\ntwo.txt", action: "delete" },
    ];
    const markup = render(createElement(DiscardSummary, { summary, scope }));
    expect(markup).toContain(deletes);
    expect(markup).toContain(restores);
    expect(markup).toContain(warning);
    expect(markup.indexOf(deletes)).toBeLessThan(markup.indexOf(restores));
    for (const entry of summary) expect(markup).toContain(entry.path);
  },
);

test.each([
  ["en", "Resolve conflicts and stage the affected files first.", "Continue", "Abort", "Merge"],
  ["zh-CN", "请先解决冲突并暂存相关文件。", "继续", "中止", "合并"],
] as const)(
  "operation conflict hints use the machine field and preserve permissions in %s",
  async (language, translated, continueLabel, abortLabel, operationLabel) => {
    await setLanguagePreference(language);
    const reasons: {
      kind: GitOperation["kind"];
      blocked?: GitOperation["blocked"];
      reason: string;
      displayed: string;
    }[] = [
      {
        kind: "merge",
        blocked: "conflicts",
        reason: "Unmerged files need attention",
        displayed: translated,
      },
      {
        kind: "merge",
        reason: "Resolve and stage conflicting files first",
        displayed: "Resolve and stage conflicting files first",
      },
      {
        kind: "rebase",
        reason: "This rebase contains special steps; continue in the terminal",
        displayed: "This rebase contains special steps; continue in the terminal",
      },
      { kind: "unknown", reason: "Unknown Git operation", displayed: "Unknown Git operation" },
      {
        kind: "rebase",
        reason: "Cannot determine the Git comment prefix; continue in the terminal",
        displayed: "Cannot determine the Git comment prefix; continue in the terminal",
      },
      {
        kind: "unknown",
        reason: "Permission denied reading rebase state",
        displayed: "Permission denied reading rebase state",
      },
    ];
    for (const { kind, blocked, reason, displayed } of reasons) {
      const markup = render(
        createElement(OperationBar, {
          operation: {
            kind,
            token: kind === "unknown" ? undefined : "operation",
            canContinue: false,
            canAbort: kind !== "unknown",
            reason,
            blocked,
          },
          target,
          actions: new GitActions(),
          disabled: false,
          onTerminal() {},
        }),
      );
      expect(markup).toContain(displayed);
      if (reason !== displayed) expect(markup).not.toContain(reason);
      const buttons = markup.match(/<button\b[^>]*>[\s\S]*?<\/button>/g)!;
      expect(buttons.find((button) => button.includes(continueLabel))).toMatch(/\sdisabled=/);
      const abort = buttons.find((button) => button.includes(abortLabel));
      expect(abort).toBeDefined();
      if (kind === "unknown") expect(abort).toMatch(/\sdisabled=/);
      else expect(abort).not.toMatch(/\sdisabled=/);
      if (kind === "merge") expect(markup).toContain(operationLabel);
    }
  },
);
