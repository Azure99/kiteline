// Task output is read without a terminal, so control sequences from programs that force colour
// (or send terminal notifications) would show as stray characters. Only text is kept for display.
const complete =
  // eslint-disable-next-line no-control-regex
  /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[ -/]*[0-~]?|[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f\x7f]/g;
// eslint-disable-next-line no-control-regex
const incomplete = /\x1b(?:\[[0-?]*[ -/]*|\][^\x07\x1b\n]*\x1b?|[ -/]*)$/;

/**
 * Removes terminal control sequences from one output piece. A sequence split across pieces is
 * returned as `carry` and must be prepended to the next piece of the same stream. The final read
 * releases any incomplete tail through the same control-sequence cleanup.
 */
export function outputText(carry: string, piece: string, final: boolean) {
  const input = carry + piece;
  const tail = final ? undefined : incomplete.exec(input);
  const body = tail ? input.slice(0, tail.index) : input;
  return { text: body.replace(complete, ""), carry: tail ? tail[0] : "" };
}
