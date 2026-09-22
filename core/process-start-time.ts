import { dlopen, FFIType, ptr } from 'bun:ffi'

// Darwin SDK sys/proc_info.h: PROC_PIDTBSDINFO=3, proc_bsdinfo is 136
// bytes, PID at 12, start seconds/useconds at 120/128 on supported 64-bit Macs.
// The handle is code, not an observation cache: proc_pidinfo is called anew.
let library: ReturnType<typeof dlopen> | undefined
export function readDarwinProcessStart(pid: number): string {
  if(process.platform!=='darwin' || !Number.isSafeInteger(pid) || pid<=1)throw new Error('PROCESS_START_UNAVAILABLE')
  library ??= dlopen('/usr/lib/libproc.dylib', {
    proc_pidinfo:{args:[FFIType.i32,FFIType.i32,FFIType.u64,FFIType.ptr,FFIType.i32],returns:FFIType.i32},
  })
  const buffer=Buffer.alloc(136)
  const size=library.symbols.proc_pidinfo(pid,3,0n,ptr(buffer),buffer.length)
  if(size!==buffer.length || buffer.readUInt32LE(12)!==pid)throw new Error('PROCESS_START_UNAVAILABLE')
  const seconds=buffer.readBigUInt64LE(120),micros=buffer.readBigUInt64LE(128)
  if(seconds<=0n || micros>=1000000n)throw new Error('PROCESS_START_UNAVAILABLE')
  return `${new Date(Number(seconds)*1000).toISOString().slice(0,19)}.${micros.toString().padStart(6,'0')}Z`
}

/** Conservative end of the measured interval, without inventing precision. */
export function processStartUpperBoundMs(startedAt: string): number {
  const started=Date.parse(startedAt)
  const fractional=/\.(\d+)Z$/.exec(startedAt)?.[1] ?? ''
  return started+(fractional.length===0?1000:
    fractional.length<3?10**(3-fractional.length):
    /[1-9]/.test(fractional.slice(3))?1:0)
}

/** A grant inside a coarse observation interval cannot prove ownership. */
export function authorityAcquiredAfterStart(acquiredAt: unknown, startedAt: string): boolean {
  const acquired=acquiredAt instanceof Date?acquiredAt.getTime():Date.parse(String(acquiredAt))
  const upperStart=processStartUpperBoundMs(startedAt)
  return Number.isFinite(acquired) && Number.isFinite(upperStart) && acquired>=upperStart
}
