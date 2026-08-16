import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  classifyQueueWorkResidueRows,
  loadQueueWorkResiduePolicyFile,
  matchQueueWorkResiduePolicyEntry,
  parseQueueWorkResiduePolicy,
  queueWorkResidueExcludedQueueIds,
  type QueueWorkResidueRow,
} from '../core/state-daemon/queue-work-residue-policy'

const REPO = join(import.meta.dir, '..')
const POLICY_PATH = join(REPO, 'config', 'queue-work-residue-policy.json')

function loadPolicyJson(): any {
  return JSON.parse(readFileSync(POLICY_PATH, 'utf8'))
}

function row120138(patch: Partial<QueueWorkResidueRow> = {}): QueueWorkResidueRow {
  return {
    id: 120138,
    agent_id: 'agent-com-dev',
    message_id: null,
    status: 'pending',
    payload: JSON.stringify({
      source: 'state-daemon-github-work-puller-canary',
      message_type: 'github_work',
      github_url: 'https://github.com/watchout/agent-comms-mcp/issues/747',
    }),
    ...patch,
  }
}

function row120245(patch: Partial<QueueWorkResidueRow> = {}): QueueWorkResidueRow {
  return {
    id: 120245,
    agent_id: 'qa',
    message_id: 'ab20f921-4b99-4392-960a-673ee834292a',
    status: 'pending',
    payload: JSON.stringify({
      receive_claim: {
        source: 'state-daemon-queue-work-scheduler',
      },
      runner_error: {
        code: 'ADAPTER_ERROR',
        runtime_id: 'codex-exec',
        invocation_source: 'state-daemon-queue-work-scheduler',
      },
    }),
    ...patch,
  }
}

function row121744(patch: Partial<QueueWorkResidueRow> = {}): QueueWorkResidueRow {
  return {
    id: 121744,
    agent_id: 'secretary',
    message_id: '51647a24-0bfe-4efc-8cc8-2c795069bbf0',
    status: 'in_progress',
    payload: JSON.stringify({
      receive_claim: {
        source: 'state-daemon-queue-work-scheduler',
      },
    }),
    ...patch,
  }
}

function row121873(patch: Partial<QueueWorkResidueRow> = {}): QueueWorkResidueRow {
  return {
    id: 121873,
    agent_id: 'check',
    message_id: 'b12a0c4d-aee3-4238-8cb4-5f7703f0dd8e',
    status: 'pending',
    payload: JSON.stringify({
      source: 'cli-notify',
      message_type: 'phase_handoff',
    }),
    ...patch,
  }
}

const L2AUDITOR_OBSOLETE_ROWS = [
  {
    id: 121839,
    message_id: '7016c340-2351-4e2b-9242-e04c05ba19e1',
    message_type: 'chat',
  },
  {
    id: 121876,
    message_id: '0794ce90-bddf-4487-be97-e208eb7735bb',
    message_type: 'phase_handoff',
  },
  {
    id: 121919,
    message_id: '549bf0c9-424a-467c-a214-cecd80e08a1d',
    message_type: 'phase_handoff',
  },
  {
    id: 121924,
    message_id: '2a932426-6cf3-4eb3-b99a-be999ec9c7f8',
    message_type: 'phase_handoff',
  },
  {
    id: 121938,
    message_id: 'e717e0c6-549a-45e8-ba39-73b26f99c11a',
    message_type: 'phase_handoff',
  },
] as const

const CP80_EXACT_ROW_RESIDUE_ROWS = [
  {
    id: 123851,
    message_id: 'b91e28bf-01f0-42d0-91ad-59e8b5765f4b',
    source: 'cli-notify',
    payload_md5: 'c364d75e90e4c2e83c750ac9bfe4077a',
  },
  {
    id: 123940,
    message_id: '439850af-a7e2-487a-8bec-3350d5ea244d',
    source: 'agent-comms',
    payload_md5: '86415242b48a77d83184d0719f1d045d',
  },
  {
    id: 123945,
    message_id: 'e8da25ca-93d7-4d8a-9dd2-63756c9c0c69',
    source: 'agent-comms',
    payload_md5: '979de68a28e0b0a79fd6708467d14751',
  },
] as const

function rowL2AuditorObsolete(
  item: typeof L2AUDITOR_OBSOLETE_ROWS[number],
  patch: Partial<QueueWorkResidueRow> = {},
): QueueWorkResidueRow {
  return {
    id: item.id,
    agent_id: 'l2auditor',
    message_id: item.message_id,
    status: 'pending',
    payload: JSON.stringify({
      source: 'cli-notify',
      message_type: item.message_type,
    }),
    ...patch,
  }
}

function rowCp80ExactResidue(
  item: typeof CP80_EXACT_ROW_RESIDUE_ROWS[number],
  patch: Partial<QueueWorkResidueRow> = {},
): QueueWorkResidueRow {
  return {
    id: item.id,
    agent_id: 'aun',
    message_id: item.message_id,
    status: 'skipped',
    payload: JSON.stringify({
      source: item.source,
      message_type: 'instruction',
    }),
    ...patch,
  }
}

const NATIVE_AGENT_WORK_ROWS = [
  { id: 152953, agent_id: 'adf-lead', message_id: '425a14e9-8270-4e0f-be4c-db56b3745005' },
  { id: 153868, agent_id: 'adf-lead', message_id: '9898333f-d809-4342-ac82-f06629c5d8c3' },
  { id: 153903, agent_id: 'adf-lead', message_id: 'a1abb4cc-88b5-4666-9bb2-39a5937a3f37' },
  { id: 154250, agent_id: 'adf-lead', message_id: '5ed91721-06d9-4032-8ade-28718ea1a18e' },
  { id: 154252, agent_id: 'aun', message_id: '4bd91c16-f107-4bf7-9c23-7b139ebc290c' },
  { id: 154254, agent_id: 'codex-audit', message_id: '60ea96f6-bdab-4db2-95cb-e9287885f7b3' },
  { id: 154258, agent_id: 'devauditor', message_id: 'e1ba7a02-ca7b-4c5a-8459-ae0b2cc9d37c' },
] as const

function rowNativeAgentWork(
  item: typeof NATIVE_AGENT_WORK_ROWS[number],
  patch: Partial<QueueWorkResidueRow> = {},
): QueueWorkResidueRow {
  return {
    id: item.id,
    agent_id: item.agent_id,
    message_id: item.message_id,
    status: 'pending',
    payload: JSON.stringify({
      source: 'cli-notify',
      message_type: 'instruction',
    }),
    ...patch,
  }
}

describe('#758 queue-work residue policy model', () => {
  test('repo policy validates and exposes exact excluded queue ids', () => {
    const policy = loadQueueWorkResiduePolicyFile(POLICY_PATH)

    expect(policy.schema_version).toBe('queue_work_residue_policy_v1')
    expect(queueWorkResidueExcludedQueueIds(policy)).toEqual([
      120138,
      120245,
      121744,
      121839,
      121873,
      121876,
      121919,
      121924,
      121938,
      123851,
      123940,
      123945,
      152953,
      153868,
      153903,
      154250,
      154252,
      154254,
      154258,
    ])
    expect(policy.entries.map((entry) => entry.authorized_action)).toEqual(
      Array.from({ length: policy.entries.length }, () => 'preserve_only'),
    )
  })

  test('parser rejects duplicate queue_id entries', () => {
    const raw = loadPolicyJson()
    raw.entries.push({ ...raw.entries[0] })

    expect(() => parseQueueWorkResiduePolicy(raw)).toThrow('duplicate residue policy entry for queue_id=120138')
  })

  test('parser rejects unsupported classification and action', () => {
    const invalidClassification = loadPolicyJson()
    invalidClassification.entries[0].classification = 'delete_after_review'
    expect(() => parseQueueWorkResiduePolicy(invalidClassification)).toThrow('unsupported residue classification')

    const invalidAction = loadPolicyJson()
    invalidAction.entries[0].scheduler_action = 'ignore_by_age'
    expect(() => parseQueueWorkResiduePolicy(invalidAction)).toThrow('unsupported scheduler_action')
  })

  test('120138 matches only exact queue id, agent id, null message id, and GitHub canary source', () => {
    const policy = loadQueueWorkResiduePolicyFile(POLICY_PATH)
    const entry = policy.entries.find((candidate) => candidate.queue_id === 120138)!

    expect(matchQueueWorkResiduePolicyEntry(entry, row120138()).matched).toBe(true)

    const wrongMessage = matchQueueWorkResiduePolicyEntry(entry, row120138({ message_id: 'unexpected-message' }))
    expect(wrongMessage.matched).toBe(false)
    expect(wrongMessage.mismatches.join('\n')).toContain('message_id expected null')

    const wrongSource = matchQueueWorkResiduePolicyEntry(entry, row120138({
      payload: JSON.stringify({ source: 'state-daemon-queue-work-scheduler' }),
    }))
    expect(wrongSource.matched).toBe(false)
    expect(wrongSource.mismatches.join('\n')).toContain('payload.source expected state-daemon-github-work-puller-canary')
  })

  test('120245 rejects message id, agent, runner source, and ADAPTER_ERROR drift', () => {
    const policy = loadQueueWorkResiduePolicyFile(POLICY_PATH)
    const entry = policy.entries.find((candidate) => candidate.queue_id === 120245)!

    expect(matchQueueWorkResiduePolicyEntry(entry, row120245()).matched).toBe(true)

    const drifted = matchQueueWorkResiduePolicyEntry(entry, row120245({
      agent_id: 'secretary',
      message_id: 'different',
      payload: JSON.stringify({
        receive_claim: { source: 'manual-next' },
        runner_error: { code: 'OTHER', invocation_source: 'manual-next' },
      }),
    }))
    expect(drifted.matched).toBe(false)
    expect(drifted.mismatches.join('\n')).toContain('agent_id expected qa')
    expect(drifted.mismatches.join('\n')).toContain('message_id expected ab20f921-4b99-4392-960a-673ee834292a')
    expect(drifted.mismatches.join('\n')).toContain('receive_claim.source expected state-daemon-queue-work-scheduler')
    expect(drifted.mismatches.join('\n')).toContain('runner invocation_source expected state-daemon-queue-work-scheduler')
    expect(drifted.mismatches.join('\n')).toContain('runner_error.code expected ADAPTER_ERROR')
  })

  test('121744 in_progress evidence rejects terminal status unless policy changes explicitly', () => {
    const policy = loadQueueWorkResiduePolicyFile(POLICY_PATH)
    const entry = policy.entries.find((candidate) => candidate.queue_id === 121744)!

    expect(matchQueueWorkResiduePolicyEntry(entry, row121744()).matched).toBe(true)

    const terminal = matchQueueWorkResiduePolicyEntry(entry, row121744({ status: 'replied' }))
    expect(terminal.matched).toBe(false)
    expect(terminal.mismatches.join('\n')).toContain('status expected one of in_progress')
  })

  test('121873 obsolete PR #765 check handoff matches only exact pending cli-notify evidence', () => {
    const policy = loadQueueWorkResiduePolicyFile(POLICY_PATH)
    const entry = policy.entries.find((candidate) => candidate.queue_id === 121873)!

    expect(matchQueueWorkResiduePolicyEntry(entry, row121873()).matched).toBe(true)

    const drifted = matchQueueWorkResiduePolicyEntry(entry, row121873({
      status: 'replied',
      payload: JSON.stringify({ source: 'state-daemon-queue-work-scheduler' }),
    }))
    expect(drifted.matched).toBe(false)
    expect(drifted.mismatches.join('\n')).toContain('status expected one of pending')
    expect(drifted.mismatches.join('\n')).toContain('payload.source expected cli-notify')
  })

  test('obsolete l2auditor handoffs match only exact pending cli-notify evidence', () => {
    const policy = loadQueueWorkResiduePolicyFile(POLICY_PATH)

    for (const item of L2AUDITOR_OBSOLETE_ROWS) {
      const entry = policy.entries.find((candidate) => candidate.queue_id === item.id)!
      expect(matchQueueWorkResiduePolicyEntry(entry, rowL2AuditorObsolete(item)).matched).toBe(true)

      const drifted = matchQueueWorkResiduePolicyEntry(entry, rowL2AuditorObsolete(item, {
        agent_id: 'qa',
        status: 'replied',
        payload: JSON.stringify({ source: 'state-daemon-queue-work-scheduler' }),
      }))
      expect(drifted.matched).toBe(false)
      expect(drifted.mismatches.join('\n')).toContain('agent_id expected l2auditor')
      expect(drifted.mismatches.join('\n')).toContain('status expected one of pending')
      expect(drifted.mismatches.join('\n')).toContain('payload.source expected cli-notify')
    }
  })

  test('CP80 exact-row residue entries pin only governed skipped-state identity metadata', () => {
    const raw = loadPolicyJson()
    const policy = loadQueueWorkResiduePolicyFile(POLICY_PATH)

    for (const item of CP80_EXACT_ROW_RESIDUE_ROWS) {
      const rawEntry = raw.entries.find((candidate: any) => candidate.queue_id === item.id)
      const entry = policy.entries.find((candidate) => candidate.queue_id === item.id)!

      expect(rawEntry).toMatchObject({
        queue_id: item.id,
        agent_id: 'aun',
        message_id: item.message_id,
        classification: 'preserve_immutable_evidence',
        scheduler_action: 'exclude',
        authorized_action: 'preserve_only',
        expected_status: ['skipped'],
        expected_payload_source: item.source,
        payload_md5: item.payload_md5,
      })
      expect(matchQueueWorkResiduePolicyEntry(entry, rowCp80ExactResidue(item)).matched).toBe(true)

      const drifted = matchQueueWorkResiduePolicyEntry(entry, rowCp80ExactResidue(item, {
        status: 'pending',
        payload: JSON.stringify({ source: 'state-daemon-queue-work-scheduler' }),
      }))
      expect(drifted.matched).toBe(false)
      expect(drifted.mismatches.join('\n')).toContain('status expected one of skipped')
      expect(drifted.mismatches.join('\n')).toContain(`payload.source expected ${item.source}`)
    }
  })

  test('daily PDCA rows remain pending native-agent work and reject scheduler provenance drift', () => {
    const policy = loadQueueWorkResiduePolicyFile(POLICY_PATH)

    for (const item of NATIVE_AGENT_WORK_ROWS) {
      const entry = policy.entries.find((candidate) => candidate.queue_id === item.id)!
      expect(entry.classification).toBe('preserve_native_agent_work')
      expect(matchQueueWorkResiduePolicyEntry(entry, rowNativeAgentWork(item)).matched).toBe(true)
      const drifted = matchQueueWorkResiduePolicyEntry(entry, rowNativeAgentWork(item, {
        payload: JSON.stringify({ source: 'state-daemon-queue-work-scheduler' }),
      }))
      expect(drifted.matched).toBe(false)
      expect(drifted.mismatches.join('\n')).toContain('payload.source expected cli-notify')
    }
  })

  test('classifier reports exact matches, unclassified rows, missing entries, and mismatches', () => {
    const policy = loadQueueWorkResiduePolicyFile(POLICY_PATH)
    const l2Rows = L2AUDITOR_OBSOLETE_ROWS.map((item) => rowL2AuditorObsolete(item))
    const cp80Rows = CP80_EXACT_ROW_RESIDUE_ROWS.map((item) => rowCp80ExactResidue(item))
    const nativeRows = NATIVE_AGENT_WORK_ROWS.map((item) => rowNativeAgentWork(item))
    const passing = classifyQueueWorkResidueRows(policy, [row120138(), row120245(), row121744(), row121873(), ...l2Rows, ...cp80Rows, ...nativeRows], {
      requirePolicyRows: true,
    })

    expect(passing.ok).toBe(true)
    expect(passing.classifications.map((item) => item.queue_id)).toEqual([
      120138,
      120245,
      121744,
      121873,
      121839,
      121876,
      121919,
      121924,
      121938,
      123851,
      123940,
      123945,
      152953,
      153868,
      153903,
      154250,
      154252,
      154254,
      154258,
    ])

    const failing = classifyQueueWorkResidueRows(policy, [
      row120138(),
      row120245({ message_id: 'wrong' }),
      {
        id: 130000,
        agent_id: 'qa',
        message_id: 'fresh',
        status: 'pending',
        payload: '{}',
      },
    ], { requirePolicyRows: true })

    expect(failing.ok).toBe(false)
    expect(failing.blockers.map((blocker) => blocker.code)).toEqual(expect.arrayContaining([
      'queue_work_residue_policy_mismatch',
      'queue_work_unclassified_nonterminal_residue',
      'queue_work_residue_policy_entry_missing',
    ]))
  })
})
