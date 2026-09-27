import { describe, test, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { heartbeatAgentStatus, markAgentOfflineIfNoOtherLiveRuntime, markAgentRuntimeStopped } from '../core/agent-status-lifecycle'

// Legacy observations are seeded before an always-on write guard. Every helper
// must leave those bytes intact; actual lease release is tested by the real server.
function fixture() {
  const db=new Database(':memory:')
  db.exec("CREATE TABLE agents(agent_id TEXT,status TEXT,last_seen_at TEXT); CREATE TABLE agent_runtime_instances(runtime_instance_id TEXT,status TEXT)")
  db.exec("INSERT INTO agents VALUES ('aun','busy','2026-01-01'); INSERT INTO agent_runtime_instances VALUES ('runtime-a','running')")
  db.exec("CREATE TRIGGER guard_agents BEFORE UPDATE ON agents BEGIN SELECT RAISE(ABORT,'PHYSICAL_STATUS_WRITE_FORBIDDEN'); END; CREATE TRIGGER guard_runtime BEFORE UPDATE ON agent_runtime_instances BEGIN SELECT RAISE(ABORT,'PHYSICAL_STATUS_WRITE_FORBIDDEN'); END")
  const calls:string[]=[]
  return {db,calls,async query(sql:string):Promise<any>{calls.push(sql);return {rows:db.query(sql).all()}}}
}
describe('agent status lifecycle — NP03 observation boundary',()=>{
  test('heartbeat preserves historical status and last-seen without issuing a writer',async()=>{
    const f=fixture()
    try {
      await heartbeatAgentStatus(f,'aun')
      expect(f.calls).toHaveLength(0)
      expect(f.db.query('SELECT * FROM agents').get()).toEqual({agent_id:'aun',status:'busy',last_seen_at:'2026-01-01'})
    }finally{f.db.close()}
  })
  test('shutdown does not infer permission to write offline from saved liveness',async()=>{
    const f=fixture()
    try {
      expect(await markAgentOfflineIfNoOtherLiveRuntime(f,{agentId:'aun',runtimeInstanceId:'short-lived-runtime'})).toBe(false)
      expect(f.calls).toHaveLength(0)
      expect(f.db.query('SELECT status FROM agents').get()).toEqual({status:'busy'})
    }finally{f.db.close()}
  })
  test('runtime stop compatibility helper cannot rewrite runtime or profile history',async()=>{
    const f=fixture()
    try {
      await markAgentRuntimeStopped(f,'runtime-a')
      expect(await markAgentOfflineIfNoOtherLiveRuntime(f,{agentId:'aun',runtimeInstanceId:'runtime-a'})).toBe(false)
      expect(f.calls).toHaveLength(0)
      expect(f.db.query('SELECT status FROM agent_runtime_instances').get()).toEqual({status:'running'})
      expect(f.db.query('SELECT status FROM agents').get()).toEqual({status:'busy'})
    }finally{f.db.close()}
  })
})
