/**
 * UI Adapter interface definitions (SSOT §3.1)
 *
 * Each platform adapter implements UIAdapter to provide
 * a unified message receive/send interface for the communication bus.
 */

export interface AdapterConfig {
  /** Platform-specific configuration (e.g., bot token, state dir) */
  [key: string]: unknown
}

export interface SendOptions {
  /** Reply to a specific message ID */
  replyTo?: string
  /**
   * Idempotency nonce forwarded to the platform. The adapter MUST pass this
   * through to the underlying send API (Discord: `nonce` field) together
   * with `enforceNonce: true` when supplied, so a retry racing a lost HTTP
   * response cannot produce a duplicate post. outbound_queue consumer
   * supplies `"out-<row.id>"`. See docs/design/core/SSOT-5_CROSS_CUTTING.md
   * §1 and docs/agent-com-message-queue-spec.md §7.4. Phase C Step 1 PR-A.
   */
  nonce?: string
  /**
   * Opt-in flag that instructs the platform to reject rather than silently
   * accept a duplicate `nonce` within its dedup window. Discord surfaces
   * this as `enforce_nonce: true` in the message-create payload; a rejected
   * retry returns error code 40062 which the consumer collapses to
   * idempotent success. Adapters whose platform does not expose the flag
   * may treat it as a no-op but MUST NOT drop the `nonce`. Phase C Step 1
   * PR-A cycle 4 — aligned with the SSOT-5 adapter contract.
   */
  enforceNonce?: boolean
}

export interface Attachment {
  name: string
  contentType: string
  size: number
  url?: string
}

export interface UnifiedMessage {
  /** Platform-specific message ID */
  id: string
  /** Channel identifier */
  channel: string
  /** Sender info */
  author: {
    id: string
    name: string
    isBot: boolean
  }
  /** Message body */
  content: string
  /** Reply-to message ID */
  replyTo?: string
  /** Mentioned user IDs (platform-native, e.g. Discord user IDs) */
  mentionUserIds?: string[]
  /** Attachments */
  attachments?: Attachment[]
  /** Sent timestamp */
  timestamp: Date
  /** Originating platform */
  platform: string
  /** Platform-specific raw data */
  raw: unknown
}

export interface PlatformCapabilities {
  maxMessageLength: number
  supportsThreads: boolean
  supportsReactions: boolean
  supportsAttachments: boolean
  supportsEdit: boolean
}

// --- v0.1.0: Core Adapter Interface (SSOT-5) ---

export interface InboundMessage {
  external_message_id: string
  external_channel_id: string
  external_thread_id?: string
  author_external_id: string
  author_name: string
  author_is_bot: boolean
  content: string
  reply_to_external_id?: string
  attachments?: Attachment[]
  timestamp: Date
  platform: string
  raw: unknown
}

export interface Adapter {
  platform: string
  connect(config: AdapterConfig): Promise<void>
  disconnect(): Promise<void>
  isConnected(): boolean
  sendMessage(params: {
    external_channel_id: string
    content: string
    reply_to_external_id?: string
    thread_external_id?: string
  }): Promise<{ external_message_id: string }>
  onMessage(callback: (msg: InboundMessage) => void): void
  fetchHistory?(params: {
    external_channel_id: string
    limit: number
  }): Promise<InboundMessage[]>
}

// --- Legacy UIAdapter (maintained for backward compatibility) ---

export interface UIAdapter {
  /** Platform identifier */
  platform: string

  /** Platform capabilities */
  capabilities: PlatformCapabilities

  /** Connect to the platform */
  connect(config: AdapterConfig): Promise<void>

  /** Register message-received callback */
  onMessage(callback: (msg: UnifiedMessage) => void): void

  /** Send a message to a channel */
  sendMessage(channel: string, text: string, options?: SendOptions): Promise<{ messageId: string }>

  /** Fetch channel history */
  fetchHistory(channel: string, limit?: number, before?: string): Promise<UnifiedMessage[]>

  /** Start typing indicator */
  startTyping(channel: string): void

  /** Stop typing indicator */
  stopTyping(channel: string): void

  /** Disconnect */
  disconnect(): Promise<void>
}
