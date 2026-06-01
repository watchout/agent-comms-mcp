import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildCanonicalPresentationEvidence,
  sha256BodyHash,
} from '../../core/canonical-presentation'

const ROOT = join(import.meta.dir, '..', '..')
const SERVER_SRC = readFileSync(join(ROOT, 'server.ts'), 'utf8')

describe('CP-40C canonical presentation producer guard', () => {
  test('presentation evidence pins canonical and fragment body hashes', () => {
    const evidence = buildCanonicalPresentationEvidence({
      canonicalMessageId: 'canonical-1',
      presentationGroupId: 'group-1',
      fragmentCount: 3,
      fragmentIndex: 0,
      isClaimable: true,
      canonicalContent: 'full logical body',
      fragmentContent: '(1/3) full',
    })

    expect(evidence).toMatchObject({
      message_id: 'canonical-1',
      presentation_group_id: 'group-1',
      fragment_count: 3,
      fragment_index: 0,
      is_claimable: true,
      canonical_body_hash: sha256BodyHash('full logical body'),
      fragment_body_hash: sha256BodyHash('(1/3) full'),
    })
  })

  test('MCP split send/notify enqueue only the canonical part as claimable work', () => {
    expect(SERVER_SRC).toContain('CP-40C: transport fragments remain projection data')
    expect(SERVER_SRC).toContain('parts.length === 1 || partIdx === 0')
    expect(SERVER_SRC).toContain('const queueContent = canonicalPresentation ? safeContent : partContent')
    expect(SERVER_SRC).toContain('content: queueContent')
    expect(SERVER_SRC).toContain('canonical_presentation: canonicalPresentation')
    expect(SERVER_SRC).toContain('isClaimable: partIdx === 0')
  })
})
