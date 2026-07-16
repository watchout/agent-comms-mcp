import { readFileSync } from 'node:fs'
import {
  assertV2NativeMeshExecutionFence,
  v2NativeMeshScopeSha256,
  type V2NativeMeshExecutionFence,
} from '../../core/eventlog/v2-native-ingress'

export interface V2NativeMeshValidateResult {
  code: number
  result: Record<string, unknown>
}

/** S0-only, read-only scope validation.  This command cannot activate a mesh. */
export function validateV2NativeMeshScopeFile(options: {
  mode?: string
  scopeFile?: string
  expectedHead?: string
  databaseIdentity?: string
  runtimeSnapshotSha256?: string
  activate?: boolean
}): V2NativeMeshValidateResult {
  try {
    if (options.mode !== 'validate') throw new Error('only the S0 validate mode is admitted')
    if (options.activate) throw new Error('live activation is not authorized by the S0 command')
    if (!options.scopeFile) throw new Error('--scope-file is required')
    if (!options.expectedHead) throw new Error('--expected-head is required')
    if (!options.databaseIdentity) throw new Error('--database-identity is required')
    if (!options.runtimeSnapshotSha256) throw new Error('--runtime-snapshot-sha256 is required')
    const fence: V2NativeMeshExecutionFence = {
      stage_id: 'S0_IMPLEMENTATION',
      exact_implementation_head: options.expectedHead,
      database_identity: options.databaseIdentity,
      runtime_snapshot_sha256: options.runtimeSnapshotSha256,
    }
    const scope = assertV2NativeMeshExecutionFence(
      JSON.parse(readFileSync(options.scopeFile, 'utf8')),
      fence,
    )
    return {
      code: 0,
      result: {
        ok: true,
        mode: 'S0_VALIDATE_ONLY',
        mutation_performed: false,
        activation_performed: false,
        provider_invocations: 0,
        external_send_attempts: 0,
        V1_invocations: 0,
        run_id: scope.run_id,
        stage_id: scope.stage_id,
        scope_sha256: v2NativeMeshScopeSha256(scope),
        frozen_agent_ids: scope.frozen_enabled_set.map(agent => agent.agent_id),
      },
    }
  } catch (error) {
    return {
      code: 2,
      result: {
        ok: false,
        mode: 'S0_VALIDATE_ONLY',
        mutation_performed: false,
        activation_performed: false,
        error: error instanceof Error ? error.message : String(error),
      },
    }
  }
}
