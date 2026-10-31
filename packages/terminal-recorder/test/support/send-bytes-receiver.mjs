import { watch, writeFileSync } from "node:fs";
import { join } from "node:path";

const directory = process.argv[2];
const { bracketedPaste, applicationCursorKeys } = JSON.parse(process.argv[3]);
let received = Buffer.alloc(0);
writeFileSync(join(directory, "received"), received);

const modes = watch(directory, (_event, name) => {
  if (name !== "application-mode") return;
  modes.close();
  process.stdout.write("\x1b[?1hMODE_CHANGED");
});
process.stdout.write(
  `\x1b[?2004${bracketedPaste ? "h" : "l"}\x1b[?1${applicationCursorKeys ? "h" : "l"}READY`,
);
process.stdin.on("data", (chunk) => {
  received = Buffer.concat([received, chunk]);
  writeFileSync(join(directory, "received"), received);
});
