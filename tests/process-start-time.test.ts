import { test, expect } from 'bun:test'
import { authorityAcquiredAfterStart, processStartUpperBoundMs } from '../core/process-start-time'

test('second-resolution start denies a grant anywhere in its uncertainty interval', () => {
  const start='2026-09-22T00:00:00Z'
  for(const ms of [0,1,500,999])expect(authorityAcquiredAfterStart(new Date(Date.parse(start)+ms),start)).toBe(false)
  expect(authorityAcquiredAfterStart('2026-09-22T00:00:01.000Z',start)).toBe(true)
  expect(processStartUpperBoundMs(start)).toBe(Date.parse(start)+1000)
})
test('sub-millisecond start cannot borrow the preceding rounded grant', () => {
  const start='2026-09-22T00:00:00.123456Z'
  expect(authorityAcquiredAfterStart('2026-09-22T00:00:00.123Z',start)).toBe(false)
  expect(authorityAcquiredAfterStart('2026-09-22T00:00:00.124Z',start)).toBe(true)
  expect(authorityAcquiredAfterStart('invalid',start)).toBe(false)
  expect(authorityAcquiredAfterStart(new Date(),'invalid')).toBe(false)
})
