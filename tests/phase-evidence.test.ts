import { describe, expect, test } from 'bun:test'
import {
  parseConveyorPhaseEvidenceComment,
  parsePhaseHandoffQueueRow,
  reconcileWithGithub,
} from '../core/phase-evidence'

const HEAD = '38bb910e5891252386c1a9f695363f0db6c6b6f8'
const REPO = 'watchout/agent-comms-mcp'

function auditComment(overrides = '') {
  return {
    url: 'https://github.com/watchout/agent-comms-mcp/pull/764#issuecomment-audit',
    author: 'l2auditor',
    createdAt: '2026-06-16T08:30:00Z',
    body: [
      '<!-- conveyor:audit-result/v1 -->',
      'repo: watchout/agent-comms-mcp',
      'pr: 764',
      'role: audit',
      'audit_level: L2',
      'phase: l2_reaudit',
      'verdict: PASS',
      `exact_head: ${HEAD}`,
      'source_handoff_url: https://github.com/watchout/agent-comms-mcp/pull/764#issuecomment-handoff',
      'required_fixes: none',
      'next_role: qa',
      'non_scope: no #722 activation / no LaunchAgent restart',
      overrides,
    ].filter(Boolean).join('\n'),
  }
}

function l1AuditComment() {
  return {
    url: 'https://github.com/watchout/agent-comms-mcp/pull/764#issuecomment-l1',
    author: 'devauditor',
    createdAt: '2026-06-16T08:30:00Z',
    body: [
      '<!-- conveyor:audit-result/v1 -->',
      'repo: watchout/agent-comms-mcp',
      'pr: 764',
      'role: audit',
      'audit_level: L1',
      'phase: l1_audit',
      'verdict: PASS',
      `exact_head: ${HEAD}`,
      'source_handoff_url: https://github.com/watchout/agent-comms-mcp/pull/764#issuecomment-handoff',
      'required_fixes: none',
      'next_role: audit',
      'non_scope: no #722 activation / no LaunchAgent restart',
    ].join('\n'),
  }
}

function qaComment() {
  return {
    url: 'https://github.com/watchout/agent-comms-mcp/pull/764#issuecomment-qa',
    author: 'qa',
    createdAt: '2026-06-16T08:31:00Z',
    body: [
      '<!-- conveyor:qa-result/v1 -->',
      'repo: watchout/agent-comms-mcp',
      'pr: 764',
      'role: qa',
      'phase: qa',
      'verdict: PASS',
      `exact_head: ${HEAD}`,
      'source_handoff_url: https://github.com/watchout/agent-comms-mcp/pull/764#issuecomment-audit',
      'required_fixes: none',
      'next_role: check',
      'non_scope: no live activation',
    ].join('\n'),
  }
}

function checkComment() {
  return {
    url: 'https://github.com/watchout/agent-comms-mcp/pull/764#issuecomment-check',
    author: 'check',
    createdAt: '2026-06-16T08:32:00Z',
    body: [
      '<!-- conveyor:check-result/v1 -->',
      'repo: watchout/agent-comms-mcp',
      'pr: 764',
      'role: check',
      'phase: check',
      'verdict: PASS',
      `exact_head: ${HEAD}`,
      'source_handoff_url: https://github.com/watchout/agent-comms-mcp/pull/764#issuecomment-qa',
      'required_fixes: none',
      'next_role: cto',
      'non_scope: no runtime activation',
      '',
      'upstream: L2 PASS / QA PASS',
    ].join('\n'),
  }
}

function ctoComment() {
  return {
    url: 'https://github.com/watchout/agent-comms-mcp/pull/764#issuecomment-cto',
    author: 'codex-cto',
    createdAt: '2026-06-16T08:33:00Z',
    body: [
      '<!-- conveyor:cto-result/v1 -->',
      'repo: watchout/agent-comms-mcp',
      'pr: 764',
      'role: cto',
      'phase: cto',
      'verdict: GO',
      `exact_head: ${HEAD}`,
      'source_handoff_url: https://github.com/watchout/agent-comms-mcp/pull/764#issuecomment-check',
      'required_fixes: none',
      'next_role: merge-owner',
      'non_scope: no live activation',
    ].join('\n'),
  }
}

describe('conveyor phase evidence parser', () => {
  test('parses a complete exact-head audit result comment', () => {
    const evidence = parseConveyorPhaseEvidenceComment(auditComment())

    expect(evidence?.valid).toBe(true)
    expect(evidence).toMatchObject({
      marker: 'audit-result/v1',
      role: 'audit',
      auditLevel: 'L2',
      repo: REPO,
      pr: 764,
      phase: 'l2_reaudit',
      verdict: 'PASS',
      exactHead: HEAD,
      requiredFixes: 'none',
      nextRole: 'qa',
    })
  })

  test('rejects downstream summaries as substitute upstream evidence', () => {
    const evidence = parseConveyorPhaseEvidenceComment(checkComment())

    expect(evidence?.valid).toBe(true)
    expect(evidence?.role).toBe('check')
  })

  test('parses QA, check, and CTO exact-head result comments', () => {
    const qa = parseConveyorPhaseEvidenceComment(qaComment())
    const check = parseConveyorPhaseEvidenceComment(checkComment())
    const cto = parseConveyorPhaseEvidenceComment(ctoComment())

    expect(qa).toMatchObject({ valid: true, role: 'qa', phase: 'qa', exactHead: HEAD })
    expect(check).toMatchObject({ valid: true, role: 'check', phase: 'check', exactHead: HEAD })
    expect(cto).toMatchObject({ valid: true, role: 'cto', phase: 'cto', verdict: 'GO', exactHead: HEAD })
  })

  test('reports missing required fields on marker comments', () => {
    const evidence = parseConveyorPhaseEvidenceComment({
      body: [
        '<!-- conveyor:qa-result/v1 -->',
        'repo: watchout/agent-comms-mcp',
        'pr: 764',
        'role: qa',
        'verdict: PASS',
      ].join('\n'),
    })

    expect(evidence?.valid).toBe(false)
    expect(evidence?.missingRequiredFields).toEqual([
      'phase',
      'exact_head',
      'source_handoff_url',
      'required_fixes',
      'next_role',
      'non_scope',
    ])
  })

  test('ignores phase result examples inside fenced code blocks', () => {
    const evidence = parseConveyorPhaseEvidenceComment({
      body: [
        'Required output example:',
        '',
        '```text',
        '<!-- conveyor:audit-result/v1 -->',
        'repo: watchout/agent-comms-mcp',
        'pr: 767',
        'role: audit',
        'audit_level: L1',
        'phase: l1_audit',
        'verdict: PASS | NO-GO | HOLD',
        `exact_head: ${HEAD}`,
        'source_handoff_url: https://github.com/watchout/agent-comms-mcp/pull/767#issuecomment-handoff',
        'required_fixes: none | <concrete required fixes>',
        'next_role: l2auditor | agent-com-dev',
        'non_scope: no live activation',
        '```',
      ].join('\n'),
    })

    expect(evidence).toBeNull()
  })

  test('surfaces invalid phase evidence as a reconciliation warning', () => {
    const report = reconcileWithGithub({
      repo: REPO,
      pr: 764,
      currentHead: HEAD,
      labels: [],
      comments: [{
        body: [
          '<!-- conveyor:audit-result/v1 -->',
          'repo: watchout/agent-comms-mcp',
          'pr: 764',
          'role: audit',
          'verdict: PASS',
        ].join('\n'),
      }],
    })

    const invalid = report.findings.find((finding) => finding.code === 'invalid_phase_evidence')
    expect(invalid?.severity).toBe('warning')
    expect(invalid?.details.missing_required_fields).toContain('exact_head')
  })
})

describe('phase handoff queue parser', () => {
  test('parses structured phase_handoff envelope rows', () => {
    const handoff = parsePhaseHandoffQueueRow({
      id: 121839,
      agent_id: 'l2auditor',
      status: 'pending',
      created_at: '2026-06-16T08:20:00Z',
      payload: {
        kind: 'phase_handoff',
        ssot: 'github',
        repo: REPO,
        pr: 764,
        phase: 'l2_reaudit',
        target_role: 'l2auditor',
        exact_head: HEAD,
        source_url: 'https://github.com/watchout/agent-comms-mcp/pull/764#issuecomment-handoff',
        required_response: 'post GitHub comment with conveyor:audit-result/v1',
        dedupe_key: `${REPO}:pr-764:l2_reaudit:${HEAD}`,
        ttl_seconds: 3600,
        created_by: 'agent-com-dev',
      },
    })

    expect(handoff).toMatchObject({
      queueId: '121839',
      agentId: 'l2auditor',
      repo: REPO,
      pr: 764,
      phase: 'l2_reaudit',
      exactHead: HEAD,
      requiredResponse: 'post GitHub comment with conveyor:audit-result/v1',
      dedupeKey: `${REPO}:pr-764:l2_reaudit:${HEAD}`,
      ttlSeconds: 3600,
      createdBy: 'agent-com-dev',
    })
  })

  test('extracts legacy human-readable GitHub handoff content', () => {
    const handoff = parsePhaseHandoffQueueRow({
      id: 121839,
      agent_id: 'l2auditor',
      status: 'pending',
      payload: {
        content: [
          'PR #764 の L2 re-audit をお願いします。',
          'PR: https://github.com/watchout/agent-comms-mcp/pull/764',
          `Exact head: ${HEAD}`,
        ].join('\n'),
      },
    })

    expect(handoff).toMatchObject({
      repo: REPO,
      pr: 764,
      phase: 'audit',
      exactHead: HEAD,
    })
  })

  test('trims sentence punctuation from extracted GitHub URLs', () => {
    const handoff = parsePhaseHandoffQueueRow({
      id: 121868,
      agent_id: 'devauditor',
      status: 'pending',
      payload: {
        content: [
          'PR #767 L1 audit request updated.',
          `New exact head: ${HEAD}.`,
          'GitHub SSOT instruction: https://github.com/watchout/agent-comms-mcp/pull/767#issuecomment-4724500337.',
        ].join(' '),
      },
    })

    expect(handoff?.sourceUrl).toBe('https://github.com/watchout/agent-comms-mcp/pull/767#issuecomment-4724500337')
  })
})

describe('GitHub/AUN phase reconciliation', () => {
  test('detects stale AUN L2 handoff superseded by later GitHub evidence', () => {
    const report = reconcileWithGithub({
      repo: REPO,
      pr: 764,
      currentHead: HEAD,
      labels: ['audit:l2-pending', 'needs:l2-audit', 'state:impl-l2'],
      comments: [auditComment(), qaComment(), checkComment()],
      queueRows: [{
        id: 121839,
        agent_id: 'l2auditor',
        status: 'pending',
        created_at: '2026-06-16T08:20:00Z',
        payload: {
          kind: 'phase_handoff',
          repo: REPO,
          pr: 764,
          phase: 'l2_reaudit',
          exact_head: HEAD,
        },
      }],
      now: '2026-06-16T08:40:00Z',
    })

    expect(report.findings.map((finding) => finding.code)).toContain('superseded_by_github_evidence')
    expect(report.findings.map((finding) => finding.code)).toContain('github_label_phase_drift')
    expect(report.findings.find((finding) => finding.code === 'github_label_phase_drift')?.suggestedCommand)
      .toContain('--transition l2-pass')
  })

  test('does not supersede an L2 handoff with only L1 audit evidence', () => {
    const report = reconcileWithGithub({
      repo: REPO,
      pr: 764,
      currentHead: HEAD,
      labels: ['audit:l2-pending', 'needs:l2-audit', 'state:impl-l2'],
      comments: [l1AuditComment()],
      queueRows: [{
        id: 121839,
        agent_id: 'l2auditor',
        status: 'pending',
        created_at: '2026-06-16T08:20:00Z',
        payload: {
          kind: 'phase_handoff',
          repo: REPO,
          pr: 764,
          phase: 'l2_reaudit',
          exact_head: HEAD,
        },
      }],
      now: '2026-06-16T08:40:00Z',
    })

    expect(report.findings.map((finding) => finding.code)).not.toContain('superseded_by_github_evidence')
  })

  test('does not treat L3 audit handoff as CTO or satisfy it with L2 evidence', () => {
    const report = reconcileWithGithub({
      repo: REPO,
      pr: 764,
      currentHead: HEAD,
      labels: ['audit:l3-required'],
      comments: [auditComment()],
      queueRows: [{
        id: 121840,
        agent_id: 'l3auditor',
        status: 'pending',
        created_at: '2026-06-16T08:20:00Z',
        payload: {
          kind: 'phase_handoff',
          repo: REPO,
          pr: 764,
          phase: 'l3_audit',
          exact_head: HEAD,
        },
      }],
      now: '2026-06-16T08:40:00Z',
    })

    expect(report.findings.map((finding) => finding.code)).not.toContain('superseded_by_github_evidence')
  })

  test('fails closed when only check summarizes L2/QA without independent comments', () => {
    const report = reconcileWithGithub({
      repo: REPO,
      pr: 764,
      currentHead: HEAD,
      labels: ['merge-ready'],
      comments: [checkComment()],
    })

    const missing = report.findings.filter((finding) => finding.code === 'missing_independent_phase_evidence')
    expect(missing.map((finding) => finding.details.role)).toEqual(['audit', 'qa'])
  })

  test('reports active handoff stalls with runtime health evidence', () => {
    const report = reconcileWithGithub({
      repo: REPO,
      pr: 765,
      currentHead: '73e40a6f9478fb779029cf529cbcc12e787ca75a',
      labels: ['needs:l1-audit', 'state:impl-l1'],
      comments: [],
      queueRows: [{
        id: 122000,
        agent_id: 'devauditor',
        status: 'pending',
        created_at: '2026-06-16T08:00:00Z',
        payload: {
          kind: 'phase_handoff',
          repo: REPO,
          pr: 765,
          phase: 'audit',
          exact_head: '73e40a6f9478fb779029cf529cbcc12e787ca75a',
        },
      }],
      agentStatuses: [{
        agent_id: 'devauditor',
        status: 'idle',
        runtime: 'TUI',
        last_seen_at: '2026-06-16T08:01:00Z',
      }],
      now: '2026-06-16T10:00:00Z',
      ttlSeconds: 3600,
    })

    const stalled = report.findings.find((finding) => finding.code === 'phase_handoff_stalled')
    expect(stalled?.details.runtime).toMatchObject({
      agent_id: 'devauditor',
      status: 'idle',
    })
  })
})
