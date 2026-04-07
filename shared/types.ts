/**
 * Shared types for daemon ↔ channel-server communication (§5)
 */

export interface PushPayload {
  // Message identification
  message_id: string          // UUID
  sequence: number            // Channel-scoped sequence number

  // Destination
  channel_id: string          // Core channel ID
  thread_id?: string          // Core thread ID (if applicable)

  // Sender
  author_id: string           // agent_id format ("cto", "hotel-dev")

  // Mentions
  mentions: string[]          // agent_id format array (resolved from Discord)

  // Content
  content: string             // Message body (@agent_id format, converted)

  // Reply
  reply_to?: string           // Original message UUID
  reply_to_content?: string   // Quote text (max 500 chars)
  reply_to_author?: string    // Original message sender

  // Attachments
  attachments?: {
    filename: string
    path: string              // Local file path
    mime_type?: string
    size_bytes?: number
  }[]

  // Metadata
  message_type: string        // "chat" | "instruction" | "report" | "emergency" | "system_error"
  timestamp: string           // ISO 8601
}
