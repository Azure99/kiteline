// Cancel a partial control string before restoring modes after a broken connection.
export const terminalReset = Buffer.from(
  "\x18\x1b\\\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1004l\x1b[?2004l\x1b[?1l\x1b>\x1b[0m\x1b[?25h\x1b[?1049l",
);
