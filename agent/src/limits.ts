export const agentLimits = {
  resultBytes: 512 * 1024,
  listPageEntries: 500,
  cursorLifetime: 60_000,
  cursorsPerDevice: 16,
  copyNameAttempts: 1000,
  searchMatches: 1000,
  searchLineBytes: 2048,
  searchPathBytes: 4096,
  searchRanges: 128,
  searchErrorBytes: 4096,
  discoveryDirectories: 10_000,
  discoverySlice: 2000,
  terminalInitialCols: 80,
  terminalInitialRows: 24,
} as const;

export const taskLimits = {
  nameBytes: 256,
  commandBytes: 16 * 1024,
  outputReadBytes: 32 * 1024,
  diagnosticBytes: 2048,
  pageEntries: 50,
  lateToleranceMs: 5000,
  stopGraceMs: 5000,
} as const;
