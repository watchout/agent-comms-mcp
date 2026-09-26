#!/usr/bin/env bun
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
/** Managed launch boundary: a new incarnation is visible in OS exec environment. */
const agentId=process.env.AGENT_ID
if(!agentId?.trim() || (process.env.AGENT_COM_EXPECTED_AGENT_ID && process.env.AGENT_COM_EXPECTED_AGENT_ID!==agentId))throw new Error('RUNTIME_PRE_EXEC_SEAT_IDENTITY_REQUIRED')
const runtimeId=randomUUID()
const child=Bun.spawn([process.execPath,resolve(import.meta.dir,'../server.ts')],{
  cwd:process.cwd(),env:{...process.env,AGENT_COM_EXPECTED_AGENT_ID:agentId,AGENT_COM_RUNTIME_INSTANCE_ID:runtimeId,
    AGENT_COM_WORKSPACE:process.env.AGENT_COM_WORKSPACE || process.cwd(),
    AGENT_COM_RUNTIME_SESSION:process.env.AGENT_COM_RUNTIME_SESSION || `runtime:${runtimeId}`},
  stdin:'inherit',stdout:'inherit',stderr:'inherit',
})
for(const signal of ['SIGINT','SIGTERM'] as const) process.on(signal,()=>child.kill(signal))
process.exit(await child.exited)
