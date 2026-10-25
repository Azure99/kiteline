import { EditorState } from "@codemirror/state";
import { expect, test } from "vitest";
import { codeLineReference } from "../src/files/code-line-reference";
import { DraftStore } from "../src/files/drafts";

function draft(doc: string, anchor = 0, head = anchor) {
  const item = new DraftStore().open({
    deviceId: "device",
    workspaceId: "workspace",
    deviceName: 'Dev "box"',
    workspaceName: "Kiteline",
    path: "",
  });
  item.path = "src/code.ts";
  item.state = EditorState.create({ doc, selection: { anchor, head } });
  item.baseText = doc;
  return item;
}

test.each([
  ["alpha\nbeta\ngamma", 2, 8, "Buffer lines 1-2\n> alpha\n> beta"],
  ["alpha\nbeta\ngamma", 8, 2, "Buffer lines 1-2\n> alpha\n> beta"],
  ["alpha\nbeta\ngamma", 2, 6, "Buffer line 1\n> alpha"],
  ["alpha\nbeta\ngamma", 8, 8, "Buffer line 2\n> beta"],
  ["alpha\n", 6, 6, "Buffer line 2\n> "],
  ["", 0, 0, "Buffer line 1\n> "],
])("copies the touched logical lines from %j at %i..%i", (doc, anchor, head, expected) => {
  const item = draft(doc, anchor, head);
  const before = item.state;
  expect(codeLineReference(item)).toBe(
    String.raw`Device: "Dev \"box\""` +
      '\nWorkspace: "Kiteline"\nWorkspace-relative file: "src/code.ts"\n' +
      expected,
  );
  expect(item.state).toBe(before);
});

test("quotes the current buffer and identifies unnamed or missing device files", () => {
  const item = draft("const retries = 9;");
  item.baseText = "const retries = 0;";
  item.path = 'a "quoted"\nfile.ts';
  expect(codeLineReference(item)).toContain(
    String.raw`Workspace-relative file: "a \"quoted\"\nfile.ts"`,
  );
  expect(codeLineReference(item)).toContain(
    "Buffer line 1; unsaved or unconfirmed\n> const retries = 9;",
  );
  item.baseText = item.state!.doc.toString();
  item.missing = true;
  expect(codeLineReference(item)).toContain("; unsaved or unconfirmed; device file missing");
  item.path = "";
  expect(codeLineReference(item)).toContain("Untitled buffer:");
  expect(codeLineReference(item)).not.toContain("Workspace-relative file:");
});
