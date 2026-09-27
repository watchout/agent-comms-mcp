import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { Client } from 'pg'
import { AdmissionError, admissionStatus, admissionTransition, prepareAdmission, validateAdmissionConfig,
  verifyAuthorityRef, BoundedReceiptStore, currentBoundedOwner, recoverBoundedReceipt, type AuthorityRef } from '../../core/queue-admission'

// Protected commands read published source through the existing authenticated
// host. No token is put in argv/output or inherited by a worker/fixture child.
async function readPublishedBody(ref: AuthorityRef): Promise<string> {
  const url = new URL(ref.url)
  const [owner, repo] = url.pathname.slice(1).split('/')
  const id = url.hash.slice('#issuecomment-'.length)
  const response = JSON.parse(execFileSync('gh', ['api', `repos/${owner}/${repo}/issues/comments/${id}`], { encoding: 'utf8', timeout: 15000, maxBuffer: 4 * 1024 * 1024 }))
  if (typeof response.body !== 'string') throw new AdmissionError('ADMISSION_AUTHORITY_BODY_MISSING')
  return response.body
}
function required(flags: Record<string, string | boolean>, key: string): string {
  if (typeof flags[key] !== 'string' || !flags[key]) throw new AdmissionError('ADMISSION_ARGUMENT_REQUIRED', `--${key} is required`)
  return flags[key] as string
}
export async function runAdmission(action: string | undefined, flags: Record<string, string | boolean>): Promise<number> {
  try {
    if (flags.force || flags.reset || flags.reopen || !['prepare', 'enroll', 'status', 'enable', 'accept', 'halt','persist-receipt'].includes(action ?? '')) throw new AdmissionError('ADMISSION_ACTION_INVALID')
    if(action==='status'&&flags.policy){
      const config=JSON.parse(readFileSync(required(flags,'policy'),'utf8'))
      validateAdmissionConfig(config)
      const receipt=new BoundedReceiptStore(config.transport.receipt_dir,currentBoundedOwner(config.cohort_digest)).readReceipt(required(flags,'delivery-id'))
      if(receipt&&(receipt.policy_id!==config.policy_id||receipt.source_sha!==config.source_sha||receipt.cohort_digest!==config.cohort_digest))throw new AdmissionError('ADMISSION_RECEIPT_BINDING_MISMATCH')
      process.stdout.write(JSON.stringify({status:'DB_STATE_UNKNOWN',receipt,effect_count:0,execution_authorization:'NOT_GRANTED'})+'\n')
      return 0
    }
    if (process.env.AGENT_COM_DB === 'sqlite' || !process.env.DATABASE_URL) throw new AdmissionError('ADMISSION_STORAGE_UNSUPPORTED')
    if (action !== 'status' && flags.execute !== true && flags['dry-run'] !== true) throw new AdmissionError('ADMISSION_EXPLICIT_MODE_REQUIRED')
    if (flags.execute && flags['dry-run']) throw new AdmissionError('ADMISSION_MODE_CONFLICT')
    if (action === 'prepare') {
      const config = JSON.parse(readFileSync(required(flags, 'policy'), 'utf8'))
      validateAdmissionConfig(config)
      const result = await prepareAdmission({ databaseUrl: process.env.DATABASE_URL, config, readAuthorityBody: readPublishedBody, dryRun: flags['dry-run'] === true })
      process.stdout.write(JSON.stringify(result) + '\n'); return 0
    }
    const db = new Client({ connectionString: process.env.DATABASE_URL })
    await db.connect()
    try {
      const state = await admissionStatus(db, required(flags, 'policy-id'))
      if (!state) throw new AdmissionError('ADMISSION_POLICY_NOT_VISIBLE')
      if (action === 'status') { process.stdout.write(JSON.stringify(state) + '\n'); return 0 }
      await verifyAuthorityRef(state.policy.config.authority, readPublishedBody)
      if (required(flags, 'expected-digest') !== state.policy.config_digest
        || required(flags, 'expected-revision') !== String(state.policy.revision)) throw new AdmissionError('ADMISSION_STALE_STATE')
      if(action==='persist-receipt'){
        const result=await recoverBoundedReceipt({db,state,deliveryId:required(flags,'delivery-id'),receiptPath:required(flags,'receipt'),
          recovery:JSON.parse(readFileSync(required(flags,'recovery-ref'),'utf8')),readBody:readPublishedBody,dryRun:flags['dry-run']===true})
        process.stdout.write(JSON.stringify(result)+'\n');return 0
      }
      let input: Record<string, unknown> = {}
      if (action === 'enroll' || action === 'accept') {
        input = JSON.parse(readFileSync(required(flags, action === 'enroll' ? 'control-ref' : 'evidence'), 'utf8'))
        const ordinal = Number(required(flags, 'ordinal'))
        if (![1, 2].includes(ordinal) || input.ordinal !== ordinal) throw new AdmissionError('ADMISSION_ORDINAL_INVALID')
        await verifyAuthorityRef({ url: String(input.authority_url), sha256: String(input.authority_sha256) }, readPublishedBody)
        if (action === 'enroll' && input.message_id !== required(flags, 'message-id')) throw new AdmissionError('ADMISSION_MESSAGE_BINDING_MISMATCH')
      }
      if (action === 'halt') input.reason = required(flags, 'reason')
      if (flags['dry-run']) { process.stdout.write(JSON.stringify({ status: 'UNEXECUTED', dry_run: true, action, effect_count: 0 }) + '\n'); return 0 }
      const result = await admissionTransition(db, state, action!, input)
      process.stdout.write(JSON.stringify(result) + '\n'); return 0
    } finally { await db.end() }
  } catch (error) {
    process.stderr.write(JSON.stringify({ ok: false, code: error instanceof AdmissionError ? error.code : 'ADMISSION_COMMAND_FAILED' }) + '\n')
    return 1
  }
}
