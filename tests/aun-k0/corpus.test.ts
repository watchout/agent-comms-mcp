import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { ACCEPTANCE, SPECIMEN_IDS } from '../../benchmarks/aun-k0/profiles'

const directory = new URL('../fixtures/aun-k0/specimens/', import.meta.url)
const specimens = readdirSync(directory)
  .filter((name) => name.endsWith('.json'))
  .sort()
  .map((name) => JSON.parse(readFileSync(new URL(name, directory), 'utf8')))

describe('AUN K0 correctness corpus', () => {
  test('contains exactly the 12 owner-ratified specimens', () => {
    const actual = specimens.map((specimen) => specimen.id).sort()
    expect(actual).toEqual([...SPECIMEN_IDS].sort())
    expect(new Set(actual).size).toBe(12)
  })

  test('every specimen carries provenance, executable input, predicate, proof tier, and future owner', () => {
    const validProofTiers = new Set(['future_measured', 'current_regression_plus_future_measured'])
    for (const specimen of specimens) {
      expect(specimen.schema_version).toBe('aun-k0-correctness-specimen/v1')
      expect(specimen.provenance.spec_ref).toStartWith('SPEC-AUN-SHIRUBE-001')
      expect(specimen.provenance.acceptance_ids.length).toBeGreaterThan(0)
      expect(Object.keys(specimen.input).length).toBeGreaterThan(0)
      expect(specimen.expected_predicate.length).toBeGreaterThan(0)
      expect(validProofTiers.has(specimen.proof_tier)).toBe(true)
      expect(specimen.owning_future_cell).toMatch(/^AUN-K[1-4](?:_K[1-4])?$/)
      expect(specimen.behavior_status).toBe('not_executed')
    }
  })

  test('corpus and acceptance map have zero dangling IDs in either direction', () => {
    const acceptance = JSON.parse(readFileSync(new URL('../fixtures/aun-k0/acceptance-v1.json', import.meta.url), 'utf8'))
    const knownAcceptance = new Set(ACCEPTANCE.map(([id]) => id))
    const knownSpecimens = new Set(specimens.map((specimen) => specimen.id))

    for (const specimen of specimens) {
      expect(specimen.provenance.acceptance_ids.every((id: string) => knownAcceptance.has(id as any))).toBe(true)
    }
    for (const item of acceptance.acceptance) {
      expect(item.specimen_ids.every((id: string) => knownSpecimens.has(id))).toBe(true)
    }
    const referencedSpecimens = new Set(acceptance.acceptance.flatMap((item: any) => item.specimen_ids))
    expect([...knownSpecimens].every((id) => referencedSpecimens.has(id))).toBe(true)
  })
})
