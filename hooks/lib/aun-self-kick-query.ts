import { Client } from 'pg'
import { evaluateRuntimeMemoryReadyGate } from '../../core/runtime-memory-ready'

const agentId=process.argv[2]
const client=new Client({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:1500,query_timeout:2000})
try {
  await client.connect()
  const ready=await evaluateRuntimeMemoryReadyGate(client as any,{agent_id:agentId,expected_agent_id:agentId,
    project:process.env.AGENT_COMMS_MEMORY_READY_PROJECT??process.env.AGENT_MEMORY_PROJECT??'agent-comms-mcp'})
  if(!ready.ok)console.log('0')
  else {
    const result=await client.query(`SELECT
      (SELECT count(*) FROM message_queue WHERE agent_id=$1 AND status='pending')+
      (SELECT count(*) FROM outbound_queue WHERE agent_id=$1 AND status IN ('pending','claimed')) AS total`,[agentId])
    console.log(String(result.rows[0].total))
  }
} catch {process.stderr.write('aun-self-kick: DB unreachable or current readiness unavailable, skipping\n')}
finally {await client.end().catch(()=>{})}
