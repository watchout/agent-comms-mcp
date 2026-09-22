/** Runs only inside runtimeStartupFixture's private synthetic provider process. */
import { Client } from 'pg'
import { writeFileSync } from 'node:fs'
import { bindRuntimeEndpoint, resolveRuntimeEndpoint } from '../../core/runtime-endpoint'
import { heartbeatRuntimeInstance } from '../../core/runtime-heartbeat'

const agentId=process.env.AGENT_ID!,runtimeInstanceId=process.env.AGENT_COM_RUNTIME_INSTANCE_ID!
const client=new Client({connectionString:process.env.AGENT_COM_TEST_DATABASE_URL,connectionTimeoutMillis:3000})
let publications=0,work=0,acquisitions=0
const events:string[]=[]
const db={async query(sql:string,params?:any[]) {
  if(sql==='BEGIN'||sql==='COMMIT'||sql==='ROLLBACK')events.push(sql)
  if(sql.includes('INSERT INTO agent_runtime_instances'))events.push('anchor-acquisition')
  if(sql.includes('INSERT INTO control_plane_leases'))events.push('lease-acquisition')
  return client.query(sql,params)
}}
const endpoint=bindRuntimeEndpoint({port:0,fetch:()=>{work++;return new Response('fixture work')},async authorize() {
  const resolved=await resolveRuntimeEndpoint(db,{agentId,runtimeInstanceId})
  events.push(resolved.ok?'reauthorized':'authorization-denied')
  return resolved.ok && resolved.endpoint?.processId===process.pid && resolved.endpoint.port===endpoint.port
}})
events.push('socket-bound')
const prepublishStatus=(await fetch(endpoint.endpointUri)).status
function report(status:string,errors:string[]=[]) {
  writeFileSync(process.env.AUN_STARTUP_RESULT!,JSON.stringify({status,errors,pid:process.pid,port:endpoint.port,
    workspace:process.cwd(),runtimeInstanceId,publications,work,acquisitions,prepublishStatus,events}))
}
try {
  await client.connect()
  await endpoint.publish(async(port,endpointUri)=>{
    acquisitions++
    return heartbeatRuntimeInstance(db,{agentId,runtimeInstanceId,processId:process.pid,port,endpointUri,checkoutPath:process.cwd()})
  })
  publications++;events.push('endpoint-published')
  report('READY')
} catch(error) {
  const errors:string[]=[]
  for(let current:any=error;current;current=current.cause)errors.push(current.message)
  report('STARTUP_FAILED',errors)
  endpoint.server.stop(true);await client.end().catch(()=>{});process.exit(1)
}
// Crash simulation deliberately does not release the acquired logical lease.
process.on('SIGTERM',async()=>{endpoint.server.stop(true);await client.end();process.exit(0)})
