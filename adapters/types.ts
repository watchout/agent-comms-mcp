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
