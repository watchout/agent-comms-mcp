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
