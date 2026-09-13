import { expect } from 'bun:test'
import { boundedTest, fixture, startNormalTask, fixtureDb, fixtureResult, hostReplySender, enrollNormalTask, fixtureSha, candidateRoot, deliverFixtureProjection, seedNormalTransport } from './test_queue_bounded_admission.test'
import { admissionStatus, admissionTransition, tryBoundedClaim, selectBoundedOutbound, readAdmissionBinding, admissionBindingFromEnv, deliverBoundedOutbound, BoundedReceiptStore, currentBoundedOwner } from '../../core/queue-admission'
import { runReceivedQueueWork, finalizeDoneQueueWork } from '../../core/queue-work'
import { buildRunQueueWorkPlan, createRuntimeAdapter } from '../../bin/aun/run-queue-work'
import { buildStateDaemonRestorePlan, renderStateDaemonLaunchAgentPlist, validateQueueWorkCanaryResiduePreflight } from '../../core/state-daemon/launchagent'
import { readFileSync, writeFileSync, lstatSync, realpathSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { Client } from 'pg'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'

// Nonsecret pins from the independent gen5 DG/I, not private implementation.
const PRIVATE_PINS={
  'pack.json':'ed86b14f35b97d8483bf8052dd73765732c4568a945cb6e59bc6b8b7e99ea703',
  'design.md':'7dbaa3b040a1cb23b0312ad04d06975f2b9ed4796718ab85365988b266f30364',
  'private-inputs.json':'e9ec2528b8ea4ad71e834c3456add364a6f8189e2cb89fc356abc21025432bf1',
  'source-readbacks.json':'5a49e586b6f81137cc288c2cabe422bf2e8481f3aff787ceb0f097cf271c6c2c',
  'validation.json':'65f17c51f989164b6160b6d504d4c2385039119d4e7ed0c5645785397baf1b07',
} as const
const DESIGN_CANONICAL='880b99e5514f9791968ba8971e9d526b59173732986c12a54e8db04413f1972e'
const EXACT_BASE='0f772883db6f3b50772d3e4b82ce47795091f0a9'
const STAGE_PARSER="import hashlib, json, sys, xml.etree.ElementTree as ET\nroute, file = sys.argv[1:]\nassert route in (\"ci\", \"local17\", \"private\"), \"route_invalid\"\nprivate = [\"BA-CORE-F08\", \"BA-CORE-F10\"]\ncore = [f\"BA-CORE-F{i:02}\" for i in range(1, 12) if i not in (8, 10)]\npg17 = [f\"BA-17-F{n}-{x}\" for n in (12, 13) for x in \"ABC\"]\npg16 = [\"BA-16-MIGRATION\", \"BA-16-UNSUPPORTED\", \"BA-16-DEFAULT-CLAIM\", \"BA-16-DEFAULT-RETRY\"]\nrequired = private if route == \"private\" else core + pg17 + (pg16 if route == \"ci\" else [])\nraw = open(file, \"rb\").read()\ncases = list(ET.fromstring(raw).iter(\"testcase\"))\nfor name in required:\n    matching = [c for c in cases if c.get(\"name\") == name]\n    assert len(matching) == 1, (name, \"missing_or_duplicate\")\n    assert not any(x.tag in (\"failure\", \"error\", \"skipped\") for x in matching[0]), (name, \"not_executed_pass\")\nassert not any(x.tag in (\"failure\", \"error\") for c in cases for x in c), \"global_failure\"\nobserved = [c.get(\"name\") for c in cases if c.get(\"name\", \"\").startswith(\"BA-\")]\nassert set(observed) == set(required) and len(observed) == len(required), \"stage_identity_partition\"\nprint(json.dumps({\"route\":route,\"required_ids\":required,\"executed_pass\":len(required),\"required_failed_or_skipped\":0,\"junit_sha256\":hashlib.sha256(raw).hexdigest(),\"other_skipped\":sum(any(x.tag==\"skipped\" for x in c) for c in cases),\"scope\":\"STAGE_PROCEDURE_ONLY\",\"private_status\":\"VERIFIED_IN_SEPARATE_STAGE\" if route==\"private\" else \"PRIVATE_STAGE_REQUIRED\"}))\n"
const JOIN_CHECKER="import json, sys\nprivate, ci, local = [json.load(open(p)) for p in sys.argv[1:]]\nexpected_private = {\"BA-CORE-F08\", \"BA-CORE-F10\"}\nexpected_public = {f\"BA-CORE-F{i:02}\" for i in range(1,12) if i not in (8,10)} | {f\"BA-17-F{n}-{x}\" for n in (12,13) for x in \"ABC\"}\nexpected_ci = expected_public | {\"BA-16-MIGRATION\",\"BA-16-UNSUPPORTED\",\"BA-16-DEFAULT-CLAIM\",\"BA-16-DEFAULT-RETRY\"}\nfor rec, route, ids in ((private,\"private\",expected_private),(ci,\"ci\",expected_ci),(local,\"local17\",expected_public)):\n    stage = rec[\"stage\"]\n    assert stage[\"route\"] == route and rec[\"exit_code\"] == 0\n    assert set(stage[\"required_ids\"]) == ids and len(stage[\"required_ids\"]) == len(ids)\n    assert stage[\"executed_pass\"] == len(ids) and stage[\"required_failed_or_skipped\"] == 0\n    assert rec[\"evidence_files_recomputed\"] is True and rec[\"fixed_subcases_complete\"] is True\nfor key in (\"candidate_head\",\"candidate_tree\",\"base\",\"binary_diff_sha256\",\"test_files_sha256\",\"design_raw_sha256\",\"design_canonical_sha256\"):\n    assert private[\"subject\"][key] == ci[\"subject\"][key] == local[\"subject\"][key], key\ns = ci[\"subject\"]\nassert s[\"base\"] == \"0f772883db6f3b50772d3e4b82ce47795091f0a9\"\nassert private[\"clean_candidate\"] is True and local[\"clean_candidate\"] is True\nassert private[\"input_manifest_sha256\"] == private[\"independently_expected_input_manifest_sha256\"]\nassert private[\"input_bytes_recomputed\"] is True and private[\"checker_readback_verified\"] is True\nassert private[\"checker_id\"] != private[\"producer_id\"]\nassert ci[\"required_upstream_checks\"] == \"PASS\" and ci[\"api_readback_verified\"] is True\nassert s[\"tested_tree\"] == s[\"candidate_tree\"]\nif s[\"tested_commit\"] != s[\"candidate_head\"]:\n    assert s[\"tested_parents\"] == [s[\"base\"],s[\"candidate_head\"]]\nassert ci[\"api_pr_head\"] == s[\"candidate_head\"] and ci[\"api_pr_base\"] == s[\"base\"]\nassert ci[\"api_run_head\"] in (s[\"candidate_head\"],s[\"tested_commit\"])\nassert ci[\"api_check_suite_head\"] in (s[\"candidate_head\"],s[\"tested_commit\"])\nassert set(private[\"stage\"][\"required_ids\"]).isdisjoint(ci[\"stage\"][\"required_ids\"])\nassert len(set(private[\"stage\"][\"required_ids\"]) | set(ci[\"stage\"][\"required_ids\"])) == 21\nprint(json.dumps({\"required_distinct\":21,\"private_executed\":2,\"ci_executed\":19,\"local_public_executed\":15,\"decision_record_validation\":\"CONSISTENT\",\"execution_authorization\":\"NOT_GRANTED\",\"external_operational_truth\":\"NOT_EVALUATED\"}))\n"
const hashBytes=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex')
function regularBytes(file:string):Buffer{
  const stat=lstatSync(file)
  if(!stat.isFile()||stat.isSymbolicLink())throw Error('BA_PRIVATE_REGULAR_FILE_REQUIRED')
  return readFileSync(file)
}
function privateSupply(){
  const root=process.env.AUN_BOUNDED_PRIVATE_ROOT,control=process.env.AUN_BOUNDED_CONTROL_INPUTS
  if(!root||!root.startsWith('/private/tmp/aun-private-use.')||realpathSync(root)!==root||control!==join(root,'control')
    ||(lstatSync(root).mode&0o777)!==0o700||lstatSync(root).uid!==process.getuid?.())throw Error('BA_PRIVATE_ROOT_REQUIRED')
  for(const [file,sha]of Object.entries(PRIVATE_PINS))expect(hashBytes(regularBytes(join(control,file)))).toBe(sha)
  const manifest=JSON.parse(regularBytes(join(control,'private-inputs.json')).toString())
  for(const [sub,files]of [['shirube',manifest.shirube.files],['design-flow',manifest.design_flow.files]] as const)
    for(const f of files){if(resolve(root,sub,f.path)!==join(root,sub,f.path))throw Error('BA_PRIVATE_PATH_ESCAPE');expect(hashBytes(regularBytes(join(root,sub,f.path)))).toBe(f.sha256)}
  const requirePrivate=createRequire(join(root,'shirube','package.json'))
  const commanderPath=requirePrivate.resolve('commander')
  if(!commanderPath.startsWith(join(root,'shirube/node_modules/commander/')))throw Error('BA_COMMANDER_RESOLUTION')
  expect(JSON.parse(regularBytes(join(root,'shirube/node_modules/commander/package.json')).toString()).version).toBe(manifest.shirube.commander.version)
  const locked=JSON.parse(regularBytes(join(root,'shirube/package-lock.json')).toString()).packages['node_modules/commander']
  expect(locked).toMatchObject({version:manifest.shirube.commander.version,resolved:manifest.shirube.commander.resolved,integrity:manifest.shirube.commander.integrity})
  const pack=JSON.parse(regularBytes(join(control,'pack.json')).toString())
  const sourceMap=JSON.parse(regularBytes(join(root,'source-map.json')).toString())
  if(!Array.isArray(sourceMap)||sourceMap.length!==pack.sources.length)throw Error('BA_SOURCE_MAP_INCOMPLETE')
  for(const s of pack.sources){
    const entries=sourceMap.filter((x:any)=>x.id===s.id)
    if(entries.length!==1||entries[0].readback_command!==s.readback_command||entries[0].path!==join(root,'source-blobs',s.id))throw Error('BA_SOURCE_MAP_BINDING')
    const cmd=s.readback_command as string
    const git=/^git -C (\S+) show ([0-9a-f]{40}):([A-Za-z0-9_./-]+)$/.exec(cmd)
    const gh=/^gh api repos\/(watchout\/(?:agent-comms-mcp|iyasaka))\/issues\/comments\/(\d+) --jq \.body$/.exec(cmd)
    const binding=git?{kind:'git-object',subject:{repo:git[1],ref:git[2],path:git[3]}}
      :gh?{kind:'github-comment',subject:{repo:gh[1],comment_id:gh[2],url:s.url}}
      :cmd===`read-file ${s.path}`?{kind:'local-file',subject:{path:s.path}}
      :cmd===`curl --fail --silent --show-error --location ${s.url}`?{kind:'official-https',subject:{url:s.url}}:null
    if(!binding||entries[0].kind!==binding.kind||JSON.stringify(entries[0].subject)!==JSON.stringify(binding.subject))throw Error('BA_SOURCE_MAP_SUBJECT')
    const actual=hashBytes(regularBytes(entries[0].path))
    if(actual!==s.digest.replace(/^sha256:/,'')||actual!==entries[0].expected_sha256||actual!==entries[0].actual_sha256)throw Error('BA_SOURCE_BYTES_MISMATCH')
  }
  return {root,control,manifest,pack,sourceMap}
}
function privateSubject(){
  const inputs=privateSupply()
  const expected=JSON.parse(regularBytes(join(inputs.control,'candidate.json')).toString())
  if(process.env.AUN_BOUNDED_CANDIDATE_ROOT!==candidateRoot)throw Error('BA_CANDIDATE_PATH_MISMATCH')
  const git=(...a:string[])=>execFileSync('git',a,{cwd:candidateRoot,encoding:'utf8'}).trim()
  if(git('status','--porcelain=v1')!=='')throw Error('BA_CLEAN_CANDIDATE_REQUIRED')
  expect(expected.base).toBe(EXACT_BASE)
  expect(git('rev-parse','HEAD')).toBe(expected.candidate_head)
  expect(git('rev-parse','HEAD^{tree}')).toBe(expected.candidate_tree)
  expect(expected.candidate_head).not.toBe(EXACT_BASE)
  expect(hashBytes(execFileSync('git',['diff','--binary',`${EXACT_BASE}...HEAD`],{cwd:candidateRoot,maxBuffer:16*1024*1024}))).toBe(expected.binary_diff_sha256)
  const paths=['admission','admission_postgres','retry','use_trace'].map(n=>`tests/contract/test_queue_bounded_${n}.test.ts`)
  expect(Object.keys(expected.test_files_sha256).sort()).toEqual(paths.sort())
  for(const file of paths)expect(hashBytes(regularBytes(join(candidateRoot,file)))).toBe(expected.test_files_sha256[file])
  expect(expected.design_raw_sha256).toBe(PRIVATE_PINS['pack.json']);expect(expected.design_canonical_sha256).toBe(DESIGN_CANONICAL)
  return {...inputs,subject:expected}
}

boundedTest('BA-CORE-F08',async()=>{
  const input=privateSubject(),{root,manifest,subject}=input
  const model=await import(join(root,'shirube/src/cli/lib/goal-run-model.ts'))
  const dir=join(root,'cases',`f08-${crypto.randomUUID()}`);mkdirSync(dir,{mode:0o700})
  const entry=join(root,'shirube','goal-runtime-fixture-entry.ts')
  const entrySource="import {Command} from 'commander';\nimport {registerGoalRuntimeCommand} from './src/cli/commands/goal-runtime.ts';\nconst program=new Command();registerGoalRuntimeCommand(program);await program.parseAsync(process.argv);\n"
  writeFileSync(entry,entrySource,{mode:0o600})
  const ownerBody=regularBytes(join(root,'source-blobs','SRC-C5550656304')).toString()
  const definitions=[...ownerBody.matchAll(/^\| (USE-0[1-9]) \| ([^\n]+)$/gm)].map((m,i)=>({
    acceptanceId:m[1],ordinal:i,predicate:m[2].split('|')[0].trim(),evidenceClasses:['acceptance_readback','live_readback','rollback_readback']}))
  expect(definitions.map((d:any)=>d.acceptanceId)).toEqual(Array.from({length:9},(_,i)=>`USE-0${i+1}`))
  const origin='2026-09-09T00:00:00.000Z',until='2026-09-09T01:00:00.000Z'
  const checkpoint={eventSequence:0,lastEventId:null,lastIdempotencyKey:null,observedAt:origin}
  const targets=[{targetId:'fixture-operating',expectedVersion:subject.candidate_head},{targetId:'fixture-fallback',expectedVersion:EXACT_BASE}].map(t=>({...t,
    liveExactVersion:null,rollbackExactVersion:null,liveEvidenceRef:null,rollbackEvidenceRef:null,liveObservedAt:null,rollbackObservedAt:null,evidenceFreshUntil:null}))
  const blocker={blockerId:'fixture-input-unverified',ordinal:0,evidenceRefs:['fixture:input'],removalPredicate:'Fixture input and both target versions are verified.'}
  const rootId='GOAL-FIXTURE-AUN-940-USE09'
  const items=definitions.map((d:any,i:number)=>model.withWorkItemStateDigest({schemaVersion:'shirube-work-item/v2',workItemId:`fixture-use-${i+1}`,rootGoalRunId:rootId,parentWorkItemId:null,
    controlHandoffRef:'fixture:owner-admitted-use',handoffDigest:model.sha256Digest('fixture-handoff'),allowedOperations:['INDEPENDENT_AUDIT'],forbiddenOperations:['DEPLOY'],
    requiredOperation:'INDEPENDENT_AUDIT',requiredEvidence:['acceptance_readback'],advancesAcceptanceIds:[d.acceptanceId],removesBlockerIds:i===0?[blocker.blockerId]:[],
    unmetConditionId:d.acceptanceId,acceptanceOrdinal:i,blockerOrdinal:0,status:i===0?'RUNNING':'READY',dispatchIdempotencyKey:model.sha256Digest(`fixture-dispatch-${i}`),
    generation:0,checkpoint,terminalEvidence:[],createdAt:origin,updatedAt:origin}))
  const run=model.withGoalRunStateDigest({schemaVersion:'shirube-goal-run/v1',rootGoalRunId:rootId,objective:'Fixture of all frozen USE predicates; no delivered effect',
    objectiveDigest:model.sha256Digest('fixture-owner-outcome'),acceptanceSet:definitions,acceptanceDigest:model.computeAcceptanceDigest(definitions),
    targetManifestRef:'fixture:two-real-source-versions',targetDigest:model.computeTargetDigest(targets),status:'ACTIVE',generation:0,activeWorkItemId:items[0].workItemId,
    blockerSet:[blocker],acceptanceStates:definitions.map((d:any)=>({acceptanceId:d.acceptanceId,status:'UNMET',evidenceRefs:[]})),targetStates:targets,
    checkpoint,verifiedCompletionEvidence:[],createdAt:origin,updatedAt:origin})
  expect(model.validateGoalRun(run).ok).toBe(true)
  const records:any[]=[]
  const call=(caseDir:string,command:string,args:string[])=>{
    const argv=[entry,'goal-runtime',command,...args,'--store',join(caseDir,'store.json'),'--format','json']
    const child=Bun.spawnSync([process.execPath,...argv],{cwd:dir,env:{PATH:process.env.PATH},stdout:'pipe',stderr:'pipe',timeout:5000})
    const seq=records.length;writeFileSync(join(dir,`${seq}.stdout`),child.stdout,{mode:0o600});writeFileSync(join(dir,`${seq}.stderr`),child.stderr,{mode:0o600})
    const result=JSON.parse(child.stdout.toString());records.push({argv,exit_code:child.exitCode,stdout_sha256:hashBytes(child.stdout),stderr_sha256:hashBytes(child.stderr)})
    expect(result.effect_delivery_performed).toBe(false)
    return {result,exit:child.exitCode}
  }
  const cases=['valid','wrong_cas','missing_evidence','wrong_target','wrong_version','missing_live','missing_rollback','stale','transport_only','swapped_versions']
  for(const mode of cases){
    const caseDir=join(dir,mode);mkdirSync(caseDir,{mode:0o700});const statePath=join(caseDir,'initial.json')
    writeFileSync(statePath,JSON.stringify({goalRuns:[run],workItems:items}),{mode:0o600})
    expect(call(caseDir,'init',['--state',statePath]).exit).toBe(0)
    const store=join(caseDir,'store.json'),before=regularBytes(store)
    const first=call(caseDir,'status',[]);expect(first.exit).toBe(0)
    expect(regularBytes(store)).toEqual(before);expect(first.result.checkpoint.accepted_event_count).toBe(0)
    for(let index=0;index<9;index++){
      const status=call(caseDir,'status',[]).result
      const snapshot=JSON.parse(regularBytes(store).toString()).snapshot
      const current=snapshot.state.workItems.find((w:any)=>w.workItemId===items[index].workItemId)
      expect(current.status).toBe('RUNNING')
      const at=new Date(Date.parse(origin)+(index+1)*1000).toISOString(),eventId=`fixture-${mode}-${index}`
      const identity={rootGoalRunId:rootId,eventId,idempotencyKey:`fixture-event-key-${mode}-${index}`,eventSequence:index+1,observedAt:at}
      let evidence=targets.flatMap((target,targetIndex)=>definitions[index].evidenceClasses.map((evidenceClass:string)=>({evidenceRef:`fixture:${mode}:${index}:${target.targetId}:${evidenceClass}`,
        evidenceClass,subjectWorkItemId:current.workItemId,targetId:target.targetId,actorId:'fixture-independent-checker',activeFunction:'evidence_audit_gate',
        provenanceRef:'fixture:typed-not-live-proof',acceptanceId:definitions[index].acceptanceId,blockerId:index===0?blocker.blockerId:null,
        exactVersion:target.expectedVersion,predicateVerified:true,observedAt:at,freshUntil:until})))
      if(mode==='missing_evidence')evidence=[]
      if(mode==='wrong_target')evidence[0].targetId='fixture-foreign-target'
      if(mode==='wrong_version')evidence[0].exactVersion='f'.repeat(40)
      if(mode==='swapped_versions')evidence=evidence.map(e=>({...e,exactVersion:e.targetId===targets[0].targetId?EXACT_BASE:subject.candidate_head}))
      if(mode==='missing_live')evidence=evidence.filter(e=>e.evidenceClass!=='live_readback')
      if(mode==='missing_rollback')evidence=evidence.filter(e=>e.evidenceClass!=='rollback_readback')
      if(mode==='stale')evidence=evidence.map(e=>({...e,freshUntil:origin}))
      if(mode==='transport_only')evidence=evidence.map(e=>({...e,evidenceClass:'queue_done'}))
      const event={type:'PARENT_RETURN',...identity,terminalWorkItem:model.withWorkItemStateDigest({...current,status:'VERIFIED_TERMINAL',generation:current.generation+1,
        checkpoint:{eventSequence:identity.eventSequence,lastEventId:eventId,lastIdempotencyKey:identity.idempotencyKey,observedAt:at},terminalEvidence:evidence,updatedAt:at})}
      const eventPath=join(caseDir,`event-${index}.json`);writeFileSync(eventPath,JSON.stringify(event),{mode:0o600})
      const prior=regularBytes(store)
      const applied=call(caseDir,'apply',['--event',eventPath,'--expected-generation',String(status.root.generation),'--expected-runtime-digest',mode==='wrong_cas'?`sha256:${'0'.repeat(64)}`:status.runtime_digest])
      if(!['valid','missing_live','missing_rollback'].includes(mode)){
        expect(applied.exit).not.toBe(0);expect(regularBytes(store)).toEqual(prior);break
      }
      expect(applied.exit).toBe(0)
      const updated=JSON.parse(regularBytes(store).toString()).snapshot
      expect(updated.checkpoint.definitionLedger.acceptanceDefinitions).toEqual(definitions)
      expect(updated.state.goalRuns[0].acceptanceSet).toEqual(definitions)
      if(index<8)expect(applied.result.root.status).not.toBe('VERIFIED_COMPLETE')
      if(index===8){
        expect(applied.result.root.status==='VERIFIED_COMPLETE').toBe(mode==='valid')
        if(mode==='valid'){
          expect(updated.state.goalRuns[0].acceptanceStates.every((x:any)=>x.status==='VERIFIED_PASS')).toBe(true)
          expect(updated.state.goalRuns[0].blockerSet).toHaveLength(0)
          expect(updated.state.goalRuns[0].verifiedCompletionEvidence.map((x:any)=>[x.targetId,x.exactVersion])).toEqual(targets.map(x=>[x.targetId,x.expectedVersion]))
        }
      }
    }
  }
  // Actor strings are not authenticated by Shirube. Enforce the actual
  // AUN controller/nonmaker/delivery boundary before any business application.
  await fixture(async f=>{
    f.config.source_sha=subject.candidate_head
    const q=await startNormalTask(f)
    const adapter={runtime_id:f.config.runtime_id,capabilities:{},execution_timeout_ms:1000,invoke:async()=>fixtureResult()}
    expect((await runReceivedQueueWork(fixtureDb(f),{queueId:q.id,adapter,expectedClaimSource:'bounded-admission'})).ok).toBe(true)
    expect((await finalizeDoneQueueWork(fixtureDb(f),{queueId:q.id,replySender:hostReplySender(f)})).ok).toBe(true)
    const state=(await admissionStatus(f.control,f.config.policy_id))!,t=state.tasks[0]
    const acceptance={ordinal:1,checker:f.config.checker,source_sha:subject.candidate_head,result_digest:t.result_digest,reply_id:t.reply_id,message_id:t.message_id,
      authority_url:'fixture:private-controller',authority_sha256:fixtureSha('fixture-controller'),evidence_sha256:fixtureSha('fixture-nonmaker'),
      predicate_status:'VERIFIED_PASS',acceptance_kind:'independent_task_acceptance',shirube_event_ref:'fixture:validated-private-parent-return'}
    for(const change of [{checker:undefined},{checker:f.config.maker},{predicate_status:'ACK'},{acceptance_kind:'queue_done'}])
      await expect(admissionTransition(f.control,state,'accept',{...acceptance,...change})).rejects.toThrow('ADMISSION_ACCEPTANCE_INVALID')
    await expect(admissionTransition(f.control,state,'accept',acceptance)).rejects.toThrow('ADMISSION_DELIVERY_NOT_CONFIRMED')
    const reply=(await f.runtime.query('SELECT * FROM outbound_queue WHERE message_id=$1',[t.reply_id])).rows[0]
    await deliverFixtureProjection(f,reply)
    await admissionTransition(f.control,(await admissionStatus(f.control,f.config.policy_id))!,'accept',acceptance)
  })
  for(const f of manifest.shirube.files)expect(hashBytes(regularBytes(join(root,'shirube',f.path)))).toBe(f.sha256)
  const observed=manifest.f08_input_construction.fixed_subcases
  expect(observed).toHaveLength(11)
  writeFileSync(join(dir,'receipt.json'),JSON.stringify({fixed_subcases:observed,commands:records,entry_sha256:hashBytes(entrySource),source:subject,fixture_only:true,real_use:0},null,2),{mode:0o600})
  console.log(JSON.stringify({case:'BA-CORE-F08',subcases_executed:11,commands:records.length,private_evidence_sha256:hashBytes(regularBytes(join(dir,'receipt.json'))),real_use:false}))
})

boundedTest('BA-CORE-F10',async()=>{
  const input=privateSubject(),{root,manifest,pack,subject}=input
  const dir=join(root,'cases',`f10-${crypto.randomUUID()}`);mkdirSync(dir,{mode:0o700})
  const packageHash=createHash('sha256')
  for(const file of manifest.design_flow.files)packageHash.update(file.path).update('\0').update(regularBytes(join(root,'design-flow',file.path))).update('\0')
  expect(packageHash.digest('hex')).toBe('b5404ca3a8a59e70c79bbcd2da3524367e29743a673f46921f74bc696057ee72')
  const validator=join(root,'design-flow','scripts/validate-design-pack.mjs')
  const command=['node',validator,'--validate-pack',join(root,'control','pack.json')]
  const checked=Bun.spawnSync(command,{env:{PATH:process.env.PATH},stdout:'pipe',stderr:'pipe',timeout:10000})
  writeFileSync(join(dir,'validator.stdout'),checked.stdout,{mode:0o600});writeFileSync(join(dir,'validator.stderr'),checked.stderr,{mode:0o600})
  expect(checked.exitCode).toBe(0)
  const verdict=JSON.parse(checked.stdout.toString())
  expect(verdict.verdict).toBe('PASS');expect(verdict.pack_digest_expected).toBe(`sha256:${DESIGN_CANONICAL}`)
  expect(verdict.metrics).toMatchObject({gate_count:7,lens_count:12,trace_total:23,trace_closed:23,trace_coverage_percent:100,evidence_readbacks_verified:63})
  expect(pack.acceptance_predicates).toHaveLength(23)
  const mutate=(file:string,bad:Buffer|string,verify:()=>unknown)=>{
    const original=regularBytes(file)
    try{writeFileSync(file,bad,{mode:0o600});expect(verify).toThrow()}
    finally{writeFileSync(file,original,{mode:0o600})}
  }
  let boundaryCases=0
  for(const prior of ['prior/pack.json','prior/gen2/pack.json','prior/gen3/pack.json','prior/gen4/pack.json']){
    mutate(join(root,'control/pack.json'),regularBytes(join(root,'control',prior)),privateSupply);boundaryCases++
  }
  mutate(join(root,'control/pack.json'),'{malformed',privateSupply);boundaryCases++
  mutate(join(root,'control/private-inputs.json'),'{}',privateSupply);boundaryCases++
  mutate(join(root,'shirube',manifest.shirube.files[0].path),'// edited private input',privateSupply);boundaryCases++
  mutate(join(root,'design-flow/scripts/validate-design-pack.mjs'),'process.exit(0)',privateSupply);boundaryCases++
  mutate(join(root,'source-blobs',pack.sources[0].id),'edited raw source',privateSupply);boundaryCases++
  const sourceMap=JSON.parse(regularBytes(join(root,'source-map.json')).toString())
  mutate(join(root,'source-map.json'),JSON.stringify(sourceMap.slice(1)),privateSupply);boundaryCases++
  const forged=structuredClone(sourceMap);forged[0].path=join(root,'cases','nonexistent-source')
  mutate(join(root,'source-map.json'),JSON.stringify(forged),privateSupply);boundaryCases++
  for(const field of ['kind','subject']){
    const changed=structuredClone(sourceMap);changed[0][field]=field==='kind'?'unadmitted-kind':{path:'wrong-subject'}
    mutate(join(root,'source-map.json'),JSON.stringify(changed),privateSupply);boundaryCases++
  }
  const wrong=JSON.parse(regularBytes(join(root,'control/candidate.json')).toString());wrong.candidate_head='f'.repeat(40)
  mutate(join(root,'control/candidate.json'),JSON.stringify(wrong),privateSubject);boundaryCases++
  expect(boundaryCases).toBe(14)
  privateSubject() // Every temporary input mutation was restored byte-for-byte.
  const workflow=readFileSync(join(candidateRoot,'.github/workflows/pr-checks.yml'),'utf8')
  const embedded=workflow.match(/python3 - ci bounded-full.xml > bounded-ci-stage.json <<'PY'\n([\s\S]*?)          PY/)?.[1]
  expect(embedded?.split('\n').map(l=>l.startsWith('          ')?l.slice(10):l).join('\n')).toBe(STAGE_PARSER)
  const design=regularBytes(join(root,'control/design.md')).toString()
  expect(design).toContain(STAGE_PARSER.trimEnd());expect(design).toContain(JOIN_CHECKER.trimEnd())
  const parserFile=join(dir,'stage-check.py'),joinFile=join(dir,'join-check.py')
  writeFileSync(parserFile,STAGE_PARSER,{mode:0o600});writeFileSync(joinFile,JOIN_CHECKER,{mode:0o600})
  const privateIds=['BA-CORE-F08','BA-CORE-F10']
  const publicIds=[...Array.from({length:11},(_,i)=>`BA-CORE-F${String(i+1).padStart(2,'0')}`).filter(id=>!privateIds.includes(id)),
    ...[12,13].flatMap(n=>['A','B','C'].map(x=>`BA-17-F${n}-${x}`))]
  const ciIds=[...publicIds,'BA-16-MIGRATION','BA-16-UNSUPPORTED','BA-16-DEFAULT-CLAIM','BA-16-DEFAULT-RETRY']
  const xml=(ids:string[],child='')=>`<testsuites><testsuite>${ids.map((id,i)=>`<testcase name="${id}">${i===0?child:''}</testcase>`).join('')}</testsuite></testsuites>`
  const stages:any[]=[['ci',xml(ciIds),true],['local17',xml(publicIds),true],['private',xml(privateIds),true],
    ['ci',xml(ciIds.slice(1)),false],['ci',xml([...ciIds,ciIds[0]]),false],['ci',xml(ciIds,'<skipped/>'),false],
    ['ci',xml(ciIds,'<failure/>'),false],['ci',xml(ciIds,'<error/>'),false],['ci','<broken',false],
    ['ci',xml([...ciIds,...privateIds]),false],['private',xml(publicIds),false],['ci',xml([...ciIds,'BA-UNKNOWN']),false],['bad',xml(ciIds),false]]
  const commands:any[]=[]
  for(let i=0;i<stages.length;i++){
    const [route,data,pass]=stages[i],file=join(dir,`stage-${i}.xml`);writeFileSync(file,data,{mode:0o600})
    const argv=['python3',parserFile,route,file],r=Bun.spawnSync(argv,{env:{PATH:process.env.PATH},stdout:'pipe',stderr:'pipe',timeout:5000})
    writeFileSync(join(dir,`stage-${i}.stdout`),r.stdout,{mode:0o600});writeFileSync(join(dir,`stage-${i}.stderr`),r.stderr,{mode:0o600})
    expect(r.exitCode===0).toBe(pass);commands.push({argv,exit:r.exitCode,expected_pass:pass})
  }
  const baseRecord=(route:string,ids:string[])=>({stage:{route,required_ids:ids,executed_pass:ids.length,required_failed_or_skipped:0},exit_code:0,
    evidence_files_recomputed:true,fixed_subcases_complete:true,subject:{...subject,tested_commit:subject.candidate_head,tested_tree:subject.candidate_tree,tested_parents:[EXACT_BASE]},
    clean_candidate:true,input_manifest_sha256:PRIVATE_PINS['private-inputs.json'],independently_expected_input_manifest_sha256:PRIVATE_PINS['private-inputs.json'],
    input_bytes_recomputed:true,checker_readback_verified:true,checker_id:'fixture-independent',producer_id:'fixture-maker',
    required_upstream_checks:'PASS',api_readback_verified:true,api_pr_head:subject.candidate_head,api_pr_base:EXACT_BASE,api_run_head:subject.candidate_head,api_check_suite_head:subject.candidate_head})
  // These are deliberately synthetic comparison specimens, NOT CI evidence.
  const pristine=[baseRecord('private',privateIds),baseRecord('ci',ciIds),baseRecord('local17',publicIds)]
  const variants:Array<{name:string;pass:boolean;change:(r:any[])=>void}>=[
    {name:'direct',pass:true,change:()=>{}},
    {name:'equal-tree-merge',pass:true,change:r=>{r[1].subject.tested_commit='a'.repeat(40);r[1].subject.tested_parents=[EXACT_BASE,subject.candidate_head];r[1].api_run_head=r[1].subject.tested_commit}},
    {name:'private-not-run',pass:false,change:r=>{r[0].stage.executed_pass=0}},
    {name:'private-missing',pass:false,change:r=>{r[0]={}}},
    {name:'wrong-C',pass:false,change:r=>{r[0].subject.candidate_head='f'.repeat(40)}},
    {name:'wrong-base',pass:false,change:r=>{for(const x of r)x.subject.base='f'.repeat(40)}},
    {name:'wrong-tree',pass:false,change:r=>{r[1].subject.tested_tree='f'.repeat(40)}},
    {name:'wrong-design',pass:false,change:r=>{r[0].subject.design_raw_sha256='f'.repeat(64)}},
    {name:'wrong-input-digest',pass:false,change:r=>{r[0].input_manifest_sha256='f'.repeat(64)}},
    {name:'private-in-ci',pass:false,change:r=>{r[1].stage.required_ids.push(...privateIds)}},
    {name:'maker-only',pass:false,change:r=>{r[0].checker_id=r[0].producer_id}},
    {name:'no-private-bytes',pass:false,change:r=>{r[0].input_bytes_recomputed=false}},
    {name:'no-independent-readback',pass:false,change:r=>{r[0].checker_readback_verified=false}},
    {name:'ci-only',pass:false,change:r=>{r[0].exit_code=1}},
    {name:'local-only',pass:false,change:r=>{r[1].exit_code=1}},
    {name:'failed-upstream',pass:false,change:r=>{r[1].required_upstream_checks='FAIL'}},
    {name:'wrong-api-head',pass:false,change:r=>{r[1].api_pr_head='f'.repeat(40)}},
    {name:'wrong-merge-parent',pass:false,change:r=>{r[1].subject.tested_commit='a'.repeat(40);r[1].subject.tested_parents=[subject.candidate_head,EXACT_BASE]}},
    {name:'dirty-local',pass:false,change:r=>{r[2].clean_candidate=false}},
    {name:'unmeasured-subcases',pass:false,change:r=>{r[2].fixed_subcases_complete=false}},
  ]
  for(const v of variants){
    const records=structuredClone(pristine);v.change(records)
    const paths=records.map((r,i)=>{const p=join(dir,`${v.name}-${i}.json`);writeFileSync(p,JSON.stringify(r),{mode:0o600});return p})
    const argv=['python3',joinFile,...paths],r=Bun.spawnSync(argv,{env:{PATH:process.env.PATH},stdout:'pipe',stderr:'pipe',timeout:5000})
    writeFileSync(join(dir,`${v.name}.stdout`),r.stdout,{mode:0o600});writeFileSync(join(dir,`${v.name}.stderr`),r.stderr,{mode:0o600})
    expect(r.exitCode===0).toBe(v.pass)
    if(v.pass)expect(JSON.parse(r.stdout.toString())).toMatchObject({required_distinct:21,execution_authorization:'NOT_GRANTED',external_operational_truth:'NOT_EVALUATED'})
    commands.push({argv,exit:r.exitCode,expected_pass:v.pass,fixture_only:true})
  }
  expect(stages).toHaveLength(13);expect(variants).toHaveLength(20)
  writeFileSync(join(dir,'receipt.json'),JSON.stringify({validator_command:command,validator:verdict,boundary_cases:boundaryCases,stage_cases:13,join_cases:20,
    stage_parser_sha256:hashBytes(STAGE_PARSER),join_checker_sha256:hashBytes(JOIN_CHECKER),commands,source:subject,fixture_only:true},null,2),{mode:0o600})
  console.log(JSON.stringify({case:'BA-CORE-F10',source_count:pack.sources.length,trace:23,actual_validator:'PASS',boundary_cases:boundaryCases,stage_cases:13,join_cases:20,
    private_evidence_sha256:hashBytes(regularBytes(join(dir,'receipt.json'))),execution_authorization:'NOT_GRANTED',external_truth:'NOT_EVALUATED'}))
})

boundedTest('BA-CORE-F04',async()=>{
  await fixture(async f=>{
    f.config.runtime_id='command-json'
    let q=await startNormalTask(f)
    const before=(await admissionStatus(f.control,f.config.policy_id))!
    const configBytes=JSON.stringify(before.policy.config)
    const envBytes=JSON.stringify(f.env)
    const deployment={commit:f.config.source_sha,restoreRoot:'/fixture/not-created/restore',launchAgentsDir:'/fixture/not-created/agents',
      databaseUrl:f.env.DATABASE_URL!,extraEnv:{...f.env,STATE_DAEMON_AGENT_ALLOWLIST:'qa',STATE_DAEMON_CODEX_RUNNER_ENABLED:'0',
        STATE_DAEMON_QUEUE_WORK_SCHEDULER_ENABLED:'1',STATE_DAEMON_QUEUE_WORK_RUNTIME:'command-json',STATE_DAEMON_QUEUE_WORK_FINALIZE:'1'} as Record<string,string>}
    const plist=renderStateDaemonLaunchAgentPlist(buildStateDaemonRestorePlan(deployment))
    let invocations=0,providerCalls=0
    for(const ordinal of [1,2] as const) {
      if(ordinal===2) {
        const enrolled=await enrollNormalTask(f,2,'Verify the follow-on tests and rollback mapping for the accepted finding.')
        q=enrolled.q
        await tryBoundedClaim(f.executor,'qa',{dialect:'postgres',env:f.env,queueId:String(q.id)})
      }
      const workerEnv={...f.env,AUN_QUEUE_WORK_COMMAND:process.execPath,AUN_QUEUE_WORK_TIMEOUT_MS:'1000',
        AUN_QUEUE_WORK_ARGS_JSON:JSON.stringify(['-e',`process.stdout.write(${JSON.stringify(JSON.stringify(fixtureResult()))})`])}
      const adapter=createRuntimeAdapter(buildRunQueueWorkPlan({runtime:'command-json',env:workerEnv,cwd:candidateRoot}),workerEnv)
      const invoke=adapter.invoke.bind(adapter);adapter.invoke=async(...args)=>{invocations++;return invoke(...args)}
      expect((await runReceivedQueueWork(fixtureDb(f),{queueId:q.id,adapter,expectedClaimSource:'bounded-admission'})).ok).toBe(true)
      expect((await finalizeDoneQueueWork(fixtureDb(f),{queueId:q.id,replySender:hostReplySender(f)})).ok).toBe(true)
      for(const kind of ['original','reply']) {
        const out=await selectBoundedOutbound(f.runtime,'different-consumer',f.env)
        expect(out).not.toBeNull();expect(out.delivery_diagnostics).toContainEqual(expect.objectContaining({kind,original_message_id:q.message_id}))
        const delivered=await deliverFixtureProjection(f,out,()=>{providerCalls++})
        expect(delivered.attempts).toBe(1)
        expect(delivered.max_attempts).toBe(kind==='reply'?3:1)
      }
      const state=(await admissionStatus(f.control,f.config.policy_id))!
      const task=state.tasks.find(t=>t.ordinal===ordinal)!
      const acceptance={ordinal,checker:f.config.checker,source_sha:f.config.source_sha,result_digest:task.result_digest,reply_id:task.reply_id,
        message_id:task.message_id,authority_url:'fixture:independent-acceptance',authority_sha256:fixtureSha('fixture-independent-acceptance'),
        evidence_sha256:fixtureSha(`fixture-accepted-${ordinal}`),predicate_status:'VERIFIED_PASS',acceptance_kind:'independent_task_acceptance',
        shirube_event_ref:`fixture:validated-parent-return-${ordinal}`}
      await expect(admissionTransition(f.control,state,'accept',{...acceptance,checker:f.config.maker})).rejects.toThrow('ADMISSION_ACCEPTANCE_INVALID')
      await expect(admissionTransition(f.control,state,'accept',{...acceptance,source_sha:'f'.repeat(40)})).rejects.toThrow('ADMISSION_ACCEPTANCE_INVALID')
      await expect(admissionTransition(f.control,state,'accept',{ordinal,ok:true,reply:'ACK'})).rejects.toThrow('ADMISSION_ACCEPTANCE_INVALID')
      await admissionTransition(f.control,state,'accept',acceptance)
      const after=(await admissionStatus(f.control,f.config.policy_id))!
      expect(after.tasks.find(t=>t.ordinal===ordinal)!.stage).toBe('ACCEPTED')
      expect(JSON.stringify(after.policy.config)).toBe(configBytes)
      expect(JSON.stringify(f.env)).toBe(envBytes)
      expect(renderStateDaemonLaunchAgentPlist(buildStateDaemonRestorePlan(deployment))).toBe(plist)
      expect(plist).not.toContain('STATE_DAEMON_QUEUE_WORK_FENCE_MESSAGE_IDS')
      expect(plist).not.toContain('STATE_DAEMON_QUEUE_WORK_FENCE_QUEUE_IDS')
    }
    const complete=(await admissionStatus(f.control,f.config.policy_id))!
    expect(complete.policy.status).toBe('CLOSED')
    expect(invocations).toBe(2);expect(providerCalls).toBe(4)
    expect(complete.tasks).toHaveLength(2)
    expect(complete.tasks.every(t=>(t as any).invocation_attempts===1 && (t as any).finalizer_attempts===1)).toBe(true)
    // This is a fixture trace. No claim that the real USE trial is accepted.
  })
})

boundedTest('BA-CORE-F07',async()=>{
  await fixture(async f=>{
    f.config.runtime_id='command-json'
    const q=await startNormalTask(f)
    const deniedFile=join(f.config.transport.receipt_dir,'worker-must-not-write')
    const source=join(candidateRoot,'docs/SSOT.md')
    const result=fixtureResult()
    const nodeMajor=Number(execFileSync('node',['--version'],{encoding:'utf8'}).trim().slice(1).split('.')[0])
    expect(nodeMajor).toBeGreaterThanOrEqual(20)
    const script=`const fs=require('node:fs');
if(process.env.DATABASE_URL||process.env.GITHUB_TOKEN||process.env.PGPASSWORD||process.env.DISCORD_BOT_TOKEN)process.exit(31);
if(!fs.readFileSync(${JSON.stringify(source)},'utf8').includes('SSOT'))process.exit(32);
try{fs.writeFileSync(${JSON.stringify(deniedFile)},'forbidden');process.exit(33)}catch(e){if(e.code!=='ERR_ACCESS_DENIED')throw e}
process.stdout.write(${JSON.stringify(JSON.stringify(result))})`
    const env={...f.env,DISCORD_BOT_TOKEN:'fixture-host-only',AUN_QUEUE_WORK_COMMAND:'node',AUN_QUEUE_WORK_TIMEOUT_MS:'1500',AUN_QUEUE_WORK_ARGS_JSON:JSON.stringify([
      nodeMajor>=22?'--permission':'--experimental-permission',`--allow-fs-read=${source}`,'-e',script])}
    const adapter=createRuntimeAdapter(buildRunQueueWorkPlan({runtime:'command-json',env,cwd:candidateRoot}),env)
    let invocations=0;const invoke=adapter.invoke.bind(adapter);adapter.invoke=async(...args)=>{invocations++;return invoke(...args)}
    const run=await runReceivedQueueWork(fixtureDb(f),{queueId:q.id,adapter,expectedClaimSource:'bounded-admission'})
    if(!run.ok)throw new Error(JSON.stringify(run))
    expect(run.ok).toBe(true)
    const saved=(await admissionStatus(f.control,f.config.policy_id))!
    expect(saved.tasks[0].stage).toBe('RESULT_SAVED')
    expect((await finalizeDoneQueueWork(fixtureDb(f),{queueId:q.id,replySender:hostReplySender(f)})).ok).toBe(true)
    const state=(await admissionStatus(f.control,f.config.policy_id))!,t=state.tasks[0]
    const acceptance={ordinal:1,checker:f.config.checker,source_sha:f.config.source_sha,result_digest:t.result_digest,reply_id:t.reply_id,
      message_id:t.message_id,authority_url:'fixture:independent',authority_sha256:fixtureSha('fixture-independent'),
      evidence_sha256:fixtureSha('actual-read-only-negative-finding'),predicate_status:'VERIFIED_PASS',acceptance_kind:'independent_task_acceptance',shirube_event_ref:'fixture:validated-parent-return'}
    await expect(admissionTransition(f.control,state,'accept',acceptance)).rejects.toThrow('ADMISSION_DELIVERY_NOT_CONFIRMED')
    for(const change of [{checker:f.config.maker},{message_id:'foreign'},{reply_id:'foreign'},{result_digest:'0'.repeat(64)},
      {source_sha:'f'.repeat(40)},{predicate_status:'ACK'},{acceptance_kind:'queue_done'},{shirube_event_ref:''}])
      await expect(admissionTransition(f.control,state,'accept',{...acceptance,...change})).rejects.toThrow('ADMISSION_ACCEPTANCE_INVALID')
    const reply=(await f.runtime.query('SELECT * FROM outbound_queue WHERE message_id=$1',[t.reply_id])).rows[0]
    await deliverFixtureProjection(f,reply)
    const current=(await admissionStatus(f.control,f.config.policy_id))!
    await expect(admissionTransition(f.executor,current,'accept',acceptance)).rejects.toThrow('ADMISSION_PRINCIPAL_MISMATCH')
    await admissionTransition(f.control,current,'accept',acceptance)
    expect((await admissionStatus(f.control,f.config.policy_id))!.tasks[0].stage).toBe('ACCEPTED')
    expect(invocations).toBe(1)
    expect((await f.admin.query('SELECT count(*)::int n FROM agent_messages WHERE reply_to=$1',[q.message_id])).rows[0].n).toBe(1)
    console.log(JSON.stringify({subcase:'F07_HOST_REPLY',worker_fs_write:'ERR_ACCESS_DENIED',worker_credentials:0,invocations,logical_reply:1,independent_fixture_acceptance:true,real_use:false}))
  })
})

boundedTest('BA-CORE-F09',async()=>{
  await fixture(async f=>{
    await seedNormalTransport(f.admin)
    const old=(await f.admin.query("INSERT INTO message_queue(agent_id,payload,status) VALUES('qa','{\"historical\":true}','pending') RETURNING id")).rows[0]
    const oldBytes=(await f.admin.query('SELECT to_jsonb(q) row FROM message_queue q WHERE id=$1',[old.id])).rows[0].row
    await f.prepare();const enrolled=await enrollNormalTask(f,1)
    const binding=admissionBindingFromEnv(f.env)!
    const env={...f.env,STATE_DAEMON_AGENT_ALLOWLIST:'qa',STATE_DAEMON_QUEUE_WORK_SCHEDULER_ENABLED:'0',STATE_DAEMON_CODEX_RUNNER_ENABLED:'0'} as Record<string,string>
    const same=JSON.stringify(env)
    expect((await validateQueueWorkCanaryResiduePreflight(f.control,env)).ok).toBe(true)
    const wrongOld=await validateQueueWorkCanaryResiduePreflight(f.control,{...env,STATE_DAEMON_RESTORE_COMMIT:'1'.repeat(40)})
    expect(wrongOld.ok).toBe(false);expect(wrongOld.errors[0].message).toContain('ADMISSION_ROLLBACK_MUST_RETAIN_DENY')
    await admissionTransition(f.control,enrolled.state,'enable',{})
    await tryBoundedClaim(f.executor,'qa',{dialect:'postgres',env:f.env})
    const busy=await validateQueueWorkCanaryResiduePreflight(f.control,env)
    expect(busy.ok).toBe(false);expect(busy.errors[0].message).toContain('ADMISSION_AFFECTED_WORK_PRESENT')
    const before=(await admissionStatus(f.control,f.config.policy_id))!
    await admissionTransition(f.control,before,'halt',{reason:'fixture rollback decision'})
    // HALT is not closure of a received row and never authorizes killing it.
    expect((await validateQueueWorkCanaryResiduePreflight(f.control,{...env,STATE_DAEMON_RESTORE_COMMIT:'1'.repeat(40)})).ok).toBe(false)
    const guard=(await readAdmissionBinding(f.executor,binding)).policy.config.guard_digest
    await expect(f.runtime.query("UPDATE message_queue SET status='received' WHERE id=$1",[old.id])).rejects.toThrow('ADMISSION_DIRECT_QUEUE_WRITE_DENIED')
    await expect(f.admin.query(readFileSync(join(candidateRoot,'db/migrations/2026-09-08-queue-bounded-admission.down.sql'),'utf8'))).rejects.toThrow('ADMISSION_DOWN_REFUSED_PROTECTED_HISTORY')
    await f.admin.query('ROLLBACK')
    expect((await readAdmissionBinding(f.executor,binding)).policy.config.guard_digest).toBe(guard)
    expect((await f.admin.query('SELECT to_jsonb(q) row FROM message_queue q WHERE id=$1',[old.id])).rows[0].row).toEqual(oldBytes)
    expect(JSON.stringify(env)).toBe(same)
  })
  await fixture(async f=>{
    await seedNormalTransport(f.admin);await f.prepare();const enrolled=await enrollNormalTask(f,1)
    await admissionTransition(f.control,enrolled.state,'halt',{reason:'fixture preclaim safe rollback'})
    const env={...f.env,STATE_DAEMON_AGENT_ALLOWLIST:'qa',STATE_DAEMON_QUEUE_WORK_SCHEDULER_ENABLED:'0',STATE_DAEMON_CODEX_RUNNER_ENABLED:'0',STATE_DAEMON_RESTORE_COMMIT:'1'.repeat(40)} as Record<string,string>
    expect((await validateQueueWorkCanaryResiduePreflight(f.control,env)).ok).toBe(true)
    await expect(tryBoundedClaim(f.executor,'qa',{dialect:'postgres',env:f.env})).rejects.toThrow('ADMISSION_DENIED')
    const changed={...env,STATE_DAEMON_QUEUE_WORK_SCHEDULER_ENABLED:'1'}
    expect((await validateQueueWorkCanaryResiduePreflight(f.control,changed)).ok).toBe(false)
  })
})

boundedTest('BA-CORE-F11',async()=>{
  for(const point of ['ENROLLED','CLAIMED','INVOKING','RESULT_SAVED','REPLIED'])await fixture(async f=>{
    f.config.runtime_id='command-json'
    await seedNormalTransport(f.admin);await f.prepare()
    const {q,state:enrolled}=await enrollNormalTask(f,1)
    let state=await admissionTransition(f.control,enrolled,'enable',{})
    let invokes=0,posts=0,prepares=0
    const binding=admissionBindingFromEnv(f.env)!
    // A real second transaction owns the policy lock; the caller has a
    // bounded NOWAIT failure, not a ten-second sleeper or provider side effect.
    await f.other.query('BEGIN')
    await f.other.query('SELECT policy_id FROM queue_admission_policies WHERE policy_id=$1 FOR UPDATE',[f.config.policy_id])
    const started=Date.now()
    await expect(tryBoundedClaim(f.executor,'qa',{dialect:'postgres',env:f.env})).rejects.toThrow('ADMISSION_BUSY')
    expect(Date.now()-started).toBeLessThan(10000)
    await f.other.query('ROLLBACK')
    if(point!=='ENROLLED')await tryBoundedClaim(f.executor,'qa',{dialect:'postgres',env:f.env})
    if(point==='INVOKING'){
      state=(await admissionStatus(f.executor,f.config.policy_id))!
      await admissionTransition(f.executor,state,'invoke',{ordinal:1,claim_fence:state.tasks[0].claim_fence})
    }
    if(['RESULT_SAVED','REPLIED'].includes(point)){
      const adapter={runtime_id:'command-json',capabilities:{},execution_timeout_ms:1000,invoke:async()=>{invokes++;return fixtureResult()}}
      expect((await runReceivedQueueWork(fixtureDb(f),{queueId:q.id,adapter,expectedClaimSource:'bounded-admission'})).ok).toBe(true)
      if(point==='REPLIED')expect((await finalizeDoneQueueWork(fixtureDb(f),{queueId:q.id,replySender:hostReplySender(f)})).ok).toBe(true)
    }
    const before=(await f.admin.query('SELECT to_jsonb(q) row FROM message_queue q WHERE id=$1',[q.id])).rows[0].row
    const taskBefore=(await admissionStatus(f.executor,f.config.policy_id))!.tasks[0]
    // Test-owned DB clock boundary only; no live policy or production clock.
    await f.admin.query("UPDATE queue_admission_policies SET expires_at=clock_timestamp()-interval '1 millisecond' WHERE policy_id=$1",[f.config.policy_id])
    const adapter={prepareBoundedRequest:async()=>{prepares++;throw Error('must not prepare expired delivery')},sendBoundedRequest:async()=>{posts++;throw Error('must not post')}}
    const row=(await f.runtime.query('SELECT * FROM outbound_queue WHERE message_id=$1',[q.message_id])).rows[0]
    await expect(deliverBoundedOutbound({db:f.runtime,row,binding,adapter})).rejects.toThrow('ADMISSION_DENIED')
    const unavailable={query:async()=>{throw Error('fixture disconnected DB')}}
    await expect(deliverBoundedOutbound({db:unavailable,row,binding,adapter})).rejects.toThrow('fixture disconnected DB')
    const current=(await admissionStatus(f.control,f.config.policy_id))!
    await expect(admissionTransition(f.executor,current,'claim',{ordinal:1,runtime_id:f.config.runtime_id,source_sha:f.config.source_sha,cohort_digest:f.config.cohort_digest})).rejects.toThrow('ADMISSION_DENIED')
    await expect(admissionTransition(f.executor,current,'begin_finalize',{ordinal:1,claim_fence:taskBefore.claim_fence,result_digest:taskBefore.result_digest})).rejects.toThrow('ADMISSION_DENIED')
    expect(posts).toBe(0);expect(prepares).toBe(0)
    expect((await f.admin.query('SELECT to_jsonb(q) row FROM message_queue q WHERE id=$1',[q.id])).rows[0].row).toEqual(before)
    expect((await admissionStatus(f.control,f.config.policy_id))!.tasks[0]).toEqual(taskBefore)
    expect(invokes).toBe(['RESULT_SAVED','REPLIED'].includes(point)?1:0)
    console.log(JSON.stringify({subcase:'F11_EXPIRY',point,post_expiry_invocation:0,post_expiry_provider:0,claim_reset:0}))
  })
})
