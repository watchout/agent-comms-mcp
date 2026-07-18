import { readFileSync } from 'node:fs'
import {
  executeV2NativeStage,
  preflightV2NativeStage,
  type V2NativeStageExecutionPortsV1,
  type V2NativeStagePreflightInputV1,
} from '../../core/eventlog/v2-native-stage-executor'

export const V2_NATIVE_STAGE_CLI_FLAGS = [
  'binding-file',
  'binding-url',
  'binding-sha256',
  'owner-decision-body-file',
  'owner-decision-url',
  'owner-decision-body-sha256',
  'exact-implementation-sha',
  'exact-implementation-tree',
  'json',
] as const

export interface V2NativeStageCommandOptions {
  mode?: string
  bindingFile?: string
  bindingUrl?: string
  bindingSha256?: string
  ownerDecisionBodyFile?: string
  ownerDecisionUrl?: string
  ownerDecisionBodySha256?: string
  exactImplementationSha?: string
  exactImplementationTree?: string
  json?: boolean
  unknownFlags?: string[]
  extraModes?: string[]
}

export interface V2NativeStageCommandResult {
  code: number
  result: Record<string, unknown>
}

function required(value: string | undefined, flag: string): string {
  if (!value) throw new Error(`${flag} is required`)
  return value
}

function loadInput(options: V2NativeStageCommandOptions): V2NativeStagePreflightInputV1 {
  if (options.unknownFlags?.length) throw new Error(`unknown flags: ${options.unknownFlags.sort().join(',')}`)
  if (options.extraModes?.length) throw new Error(`unexpected positional arguments: ${options.extraModes.join(',')}`)
  if (!options.json) throw new Error('--json is required')
  const bindingFile = required(options.bindingFile, '--binding-file')
  const ownerDecisionBodyFile = required(options.ownerDecisionBodyFile, '--owner-decision-body-file')
  let binding: unknown
  try { binding = JSON.parse(readFileSync(bindingFile, 'utf8')) } catch (error) {
    throw new Error(`binding file is not readable strict JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  return {
    binding,
    binding_url: required(options.bindingUrl, '--binding-url'),
    binding_sha256: required(options.bindingSha256, '--binding-sha256'),
    owner_decision_body: readFileSync(ownerDecisionBodyFile, 'utf8'),
    owner_decision_url: required(options.ownerDecisionUrl, '--owner-decision-url'),
    owner_decision_body_sha256: required(options.ownerDecisionBodySha256, '--owner-decision-body-sha256'),
    exact_implementation_main_sha: required(options.exactImplementationSha, '--exact-implementation-sha'),
    exact_implementation_main_tree: required(options.exactImplementationTree, '--exact-implementation-tree'),
  }
}

export async function runV2NativeStageCommand(
  options: V2NativeStageCommandOptions,
  ports?: V2NativeStageExecutionPortsV1,
): Promise<V2NativeStageCommandResult> {
  try {
    if (options.mode !== 'preflight' && options.mode !== 'execute') throw new Error('mode must be explicit: preflight or execute')
    const input = loadInput(options)
    const plan = preflightV2NativeStage(input)
    if (options.mode === 'preflight') {
      return {
        code: 0,
        result: {
          ok: true,
          mode: 'PREFLIGHT_READ_ONLY',
          stage_id: plan.binding.stage_id,
          run_id: plan.binding.run_id,
          binding_sha256: plan.exact_binding_sha256,
          owner_decision_body_sha256: plan.authority.owner_decision_body_sha256,
          frozen_agent_ids: plan.binding.stage_members.agent_ids,
          mutation_performed: false,
          activation_performed: false,
          model_invocations: 0,
          provider_invocations: 0,
          external_send_attempts: 0,
          V1_invocations: 0,
        },
      }
    }
    if (!ports) {
      return {
        code: 3,
        result: {
          ok: false,
          mode: 'EXECUTE_FAIL_CLOSED',
          stop_reason: 'LIVE_ACTIVATION_ATTEMPTED_DURING_IMPLEMENTATION',
          error: 'stage execution ports are not bound by this implementation-only CLI process',
          binding_verified: true,
          owner_decision_verified: true,
          mutation_performed: false,
          activation_performed: false,
          model_invocations: 0,
          provider_invocations: 0,
          external_send_attempts: 0,
          V1_invocations: 0,
        },
      }
    }
    const execution = await executeV2NativeStage(input, ports)
    return {
      code: execution.ok ? 0 : 4,
      result: {
        ok: execution.ok,
        mode: 'EXECUTE_EXACT_STAGE',
        result: execution.result,
        stage_id: execution.plan.binding.stage_id,
        run_id: execution.plan.binding.run_id,
        binding_sha256: execution.plan.exact_binding_sha256,
        evidence: execution.evidence,
      },
    }
  } catch (error) {
    return {
      code: 2,
      result: {
        ok: false,
        mode: options.mode === 'execute' ? 'EXECUTE_FAIL_CLOSED' : 'PREFLIGHT_READ_ONLY',
        stop_reason: 'STAGE_BINDING_MISSING_OR_INVALID',
        error: error instanceof Error ? error.message : String(error),
        binding_verified: false,
        owner_decision_verified: false,
        mutation_performed: false,
        activation_performed: false,
        model_invocations: 0,
        provider_invocations: 0,
        external_send_attempts: 0,
        V1_invocations: 0,
      },
    }
  }
}
