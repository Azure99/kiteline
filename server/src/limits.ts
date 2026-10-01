export const serverLimits = {
  sessionLifetime: 30 * 86400_000,
  channelsPerDevice: 128,
  channelIdleTimeout: 120_000,
  setupTokenLifetime: 30 * 60_000,
  bindingLifetime: 10 * 60_000,
} as const;
