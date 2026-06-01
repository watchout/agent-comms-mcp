import { createHash } from 'node:crypto'

export interface CanonicalPresentationEvidence {
  message_id: string
  presentation_group_id: string
  fragment_count: number
  fragment_index: number
  is_claimable: boolean
  canonical_body_hash: string
  fragment_body_hash: string
  parent_message_id?: string
  child_request_id?: string
}

export function sha256BodyHash(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

export function buildCanonicalPresentationEvidence(input: {
  canonicalMessageId: string
  presentationGroupId: string
  fragmentCount: number
  fragmentIndex: number
  isClaimable: boolean
  canonicalContent: string
  fragmentContent: string
  parentMessageId?: string | null
  childRequestId?: string | null
}): CanonicalPresentationEvidence {
  const evidence: CanonicalPresentationEvidence = {
    message_id: input.canonicalMessageId,
    presentation_group_id: input.presentationGroupId,
    fragment_count: input.fragmentCount,
    fragment_index: input.fragmentIndex,
    is_claimable: input.isClaimable,
    canonical_body_hash: sha256BodyHash(input.canonicalContent),
    fragment_body_hash: sha256BodyHash(input.fragmentContent),
  }
  if (input.parentMessageId) evidence.parent_message_id = input.parentMessageId
  if (input.childRequestId) evidence.child_request_id = input.childRequestId
  return evidence
}
