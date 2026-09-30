import type { ChildProcess } from 'node:child_process'

const STDERR_MAX_BYTES = 65536

/** Test-only spawn diagnostics. All timing and request inputs belong to callers. */
export function createReadiness(file: string) {
  const states = new Map<number, { child: ChildProcess; spawnedAt: number; portFree: string;
    ring: Buffer; end: number; size: number; dropped: number }>()
  return {
    boot(port: number, spawnChild: () => ChildProcess): ChildProcess {
      let portFree = 'true'
      try {
        Bun.listen({ hostname: '::', port, socket: { data() {} } }).stop(true)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        portFree = code === 'EADDRINUSE' ? 'false(EADDRINUSE)' : `unknown(${String(error)})`
      }
      const spawnedAt = Date.now(), child = spawnChild()
      const state = { child, spawnedAt, portFree, ring: Buffer.alloc(STDERR_MAX_BYTES), end: 0, size: 0, dropped: 0 }
      states.set(port, state)
      child.stderr!.on('data', (chunk: Buffer) => {
        state.dropped += Math.max(0, state.size + chunk.length - STDERR_MAX_BYTES)
        state.size = Math.min(STDERR_MAX_BYTES, state.size + chunk.length)
        if (chunk.length >= STDERR_MAX_BYTES) {
          chunk.copy(state.ring, 0, chunk.length - STDERR_MAX_BYTES)
          state.end = 0
        } else {
          const first = Math.min(chunk.length, STDERR_MAX_BYTES - state.end)
          chunk.copy(state.ring, state.end, 0, first)
          chunk.copy(state.ring, 0, first)
          state.end = (state.end + chunk.length) % STDERR_MAX_BYTES
        }
      })
      return child
    },
    async wait(port: number, timeoutMs: number, pollMs: number, requestInit?: RequestInit): Promise<void> {
      const state = states.get(port)!
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/health`, requestInit)
          if (res.ok) {
            console.log(`[readiness] file=${file} port=${port} ready_ms=${Date.now() - state.spawnedAt}`)
            return
          }
        } catch {}
        await new Promise((r) => setTimeout(r, pollMs))
      }
      const start = (state.end - state.size + STDERR_MAX_BYTES) % STDERR_MAX_BYTES
      const bytes = Buffer.concat([state.ring.subarray(start, start + state.size),
        state.ring.subarray(0, Math.max(0, start + state.size - STDERR_MAX_BYTES))])
      // A wrapped tail may begin inside a UTF-8 sequence. Omit that fragment.
      let prefix = 0
      while (prefix < bytes.length && (bytes[prefix] & 0xc0) === 0x80) prefix++
      const tail = Buffer.from(bytes.subarray(prefix).toString('utf8').replace(/\n$/, '').split('\n').slice(-40).join('\n'))
      // Invalid UTF-8 replacement can expand bytes; bound the rendered tail too.
      let offset = Math.max(0, tail.length - STDERR_MAX_BYTES)
      while (offset < tail.length && (tail[offset] & 0xc0) === 0x80) offset++
      const truncated = state.dropped + prefix || offset
        ? `truncated: dropped=${state.dropped + prefix} rendered_dropped=${offset}\n` : ''
      throw new Error(`server /health never became ready: file=${file} port=${port} elapsed_ms=${Date.now() - state.spawnedAt}`
        + ` port_free_before_spawn=${state.portFree} exit_code=${state.child.exitCode} signal=${state.child.signalCode}`
        + `\n${truncated}stderr_tail_40:\n${tail.subarray(offset).toString('utf8')}`)
    },
  }
}
