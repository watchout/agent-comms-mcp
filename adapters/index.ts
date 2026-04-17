/**
 * adapters/ public surface (FEAT-005 adapter rewrite).
 *
 * Single import site so callers do not need to know which file in
 * adapters/ owns a given symbol. spec-enforcement adapter-rewrite #9
 * pins this surface; extend here when a new adapter function becomes
 * public, not in the individual module files.
 */

export {
  discord,
  discordClients,
  refreshAgentCache,
  resolveDiscordToken,
  connectBotDiscord,
  getDiscordClient,
  setDbGetter as setDiscordClientDbGetter,
} from './discord-client'

export {
  PollingDriver,
  pollingDriver,
  consumeOneOutboundRow,
  reclaimOrphanOutboundRows,
  startOutboundConsumer,
  stopOutboundConsumer,
  computeOutboundRetryDelayMs,
  isTransientDeliveryError,
  setDbGetter as setOutboundConsumerDbGetter,
  type BufferedQueueRow,
  OUTBOUND_POLL_INTERVAL_MS,
  OUTBOUND_ORPHAN_TICK_MS,
  OUTBOUND_BACKOFF_MAX_MS,
  OUTBOUND_TICK_TIMEOUT_MS,
  POLL_DRIVER_INTERVAL_MS,
  POLL_DRIVER_HEARTBEAT_MS,
} from './outbound-consumer'

export {
  pollNewMessages,
  startPolling,
  stopPolling,
  startListener,
  scheduleListenerReconnect,
  stopListener,
  stopKeepalive,
  handleInboundMessage,
  sendHumanWarning,
  setInboundReceiverDeps,
  type InboundReceiverDeps,
  type InboundRouteResult,
} from './inbound-receiver'
