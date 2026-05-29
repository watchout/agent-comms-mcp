export const DISCORD_RUNTIME_LOGIN_CREDENTIAL_STATUSES = ['active', 'registered'] as const
export const DISCORD_DELIVERY_CREDENTIAL_STATUSES = ['active', 'registered'] as const

export type DiscordRuntimeLoginCredentialStatus = typeof DISCORD_RUNTIME_LOGIN_CREDENTIAL_STATUSES[number]
export type DiscordDeliveryCredentialStatus = typeof DISCORD_DELIVERY_CREDENTIAL_STATUSES[number]

const runtimeLoginStatuses = new Set<string>(DISCORD_RUNTIME_LOGIN_CREDENTIAL_STATUSES)
const deliveryStatuses = new Set<string>(DISCORD_DELIVERY_CREDENTIAL_STATUSES)

function normalizedStatus(status: unknown): string {
  return typeof status === 'string' && status.trim() ? status.trim() : 'registered'
}

export function isDiscordRuntimeLoginCredentialStatus(status: unknown): status is DiscordRuntimeLoginCredentialStatus {
  return runtimeLoginStatuses.has(normalizedStatus(status))
}

export function isDiscordDeliveryCredentialStatus(status: unknown): status is DiscordDeliveryCredentialStatus {
  return deliveryStatuses.has(normalizedStatus(status))
}

export function discordCredentialStatusSqlList(statuses: readonly string[]): string {
  return statuses.map((status) => `'${status.replace(/'/g, "''")}'`).join(', ')
}
