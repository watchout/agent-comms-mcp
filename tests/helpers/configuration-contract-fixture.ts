import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fixture,insert,repo } from './runtime-observation-nonpersistence-db-fixture'
import { PgAdapter } from '../../core/db/pg-adapter'
import { readConfigurationDesiredState } from '../../core/aun-configuration-desired-state'
import { DbConfigurationLeasePort,DbConfigurationDesiredStateStore } from '../../core/aun-configuration-reconciler'
export const restartSql=readFileSync(join(repo,'db/migrations/2026-09-21-runtime-observation-restart-contract.up.sql'),'utf8')
export const contractRef='https://github.com/watchout/agent-comms-mcp/issues/940#issuecomment-5759277196'
export async function configurationContractFixture() {
  const f=await fixture('postgres',false)
  await f.apply();await f.exec(restartSql)
  const url=new URL(process.env.AGENT_COM_TEST_DATABASE_URL!);url.pathname='/'+f.name
  const db=new PgAdapter(url.href)
  await insert(f,'agents',{agent_id:'cfg-fixture',display_name:'configuration fixture',agent_type:'bot',profile_enabled:true,
    desired_release_commit:'a'.repeat(40),desired_release_tree:'b'.repeat(40),desired_control_refs:JSON.stringify([contractRef]),
    ordinary_communication_enrollment:true})
  const desired=(await readConfigurationDesiredState(db,'cfg-fixture'))!
  const leases=new DbConfigurationLeasePort(db,'cfg-fixture',null),store=new DbConfigurationDesiredStateStore(db)
  const request=(lease:any)=>({agentId:desired.agentId,fromRevision:null,fromDigest:null,toRevision:desired.desiredRevision,toDigest:desired.desiredDigest,
    rollbackReleaseCommit:'c'.repeat(40),rollbackReleaseTree:'d'.repeat(40),exactReleaseCommit:desired.releaseCommit,exactReleaseTree:desired.releaseTree,
    exactControlRefs:desired.controlRefs,leaseId:lease.lease_id,fencingToken:lease.fencing_token,holderAgentId:'cfg-fixture',holderRuntimeInstanceId:null,restartBudget:1 as const})
  return {f,db,url,desired,leases,store,request,async close(){await db.close();await f.close()}}
}
