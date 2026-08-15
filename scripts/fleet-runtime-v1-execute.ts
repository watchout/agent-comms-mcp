#!/usr/bin/env bun
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import type { FleetRuntimeRequest } from '../core/fleet-runtime-v1-adapter'
import {
  ConcreteFleetRuntimeV1LocalSystem,
  FleetRuntimeLocalProviderError,
  executeLocalFleetRuntimeV1,
} from '../core/fleet-runtime-v1-local-provider'

interface CommandArgs {
  requestPath?: string
  stateDirectory?: string
  format?: string
  executeProtectedEffects: boolean
  help: boolean
}

export function fleetRuntimeV1Usage(): string {
  return `FLEET_RUNTIME_V1 local provider

Usage:
  bun scripts/fleet-runtime-v1-execute.ts --request <ABSOLUTE_REQUEST_JSON> --state-dir <ABSOLUTE_STATE_DIR> --format json [--execute-protected-effects]

Safety:
  Protected effects are denied by default. Without --execute-protected-effects,
  the command validates the request through the audited adapter and returns a
  deterministic typed block receipt before reservation or filesystem mutation.
  The protected flag is still insufficient unless the request binds the exact
  registered aun-runtime-executor / runtime_recovery_executor identity.
`
}

export function parseFleetRuntimeV1Args(argv: readonly string[]): CommandArgs {
  const parsed: CommandArgs = { executeProtectedEffects: false, help: false }
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    const value = () => {
      const next = argv[++index]
      if (!next) throw new Error(`${argument} requires a value`)
      return next
    }
    if (argument === '--request') parsed.requestPath = value()
    else if (argument === '--state-dir') parsed.stateDirectory = value()
    else if (argument === '--format') parsed.format = value()
    else if (argument === '--execute-protected-effects') parsed.executeProtectedEffects = true
    else if (argument === '--help' || argument === '-h') parsed.help = true
    else throw new Error(`unknown argument: ${argument}`)
  }
  return parsed
}

function absoluteNormalized(value: string | undefined, label: string): string {
  if (!value || !isAbsolute(value) || value !== resolve(value)) {
    throw new Error(`${label} must be an absolute normalized path`)
  }
  return value
}

function readRequest(path: string): FleetRuntimeRequest {
  if (!existsSync(path) || lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) {
    throw new Error('--request must name a real regular JSON file, never a symlink')
  }
  return JSON.parse(readFileSync(path, 'utf8')) as FleetRuntimeRequest
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

export async function main(argv = Bun.argv.slice(2)): Promise<number> {
  try {
    const args = parseFleetRuntimeV1Args(argv)
    if (args.help) {
      process.stdout.write(fleetRuntimeV1Usage())
      return 0
    }
    if (args.format !== 'json') throw new Error('--format json is required')
    const requestPath = absoluteNormalized(args.requestPath, '--request')
    const stateDirectory = absoluteNormalized(args.stateDirectory, '--state-dir')
    const result = await executeLocalFleetRuntimeV1({
      request: readRequest(requestPath),
      stateDirectory,
      executeProtectedEffects: args.executeProtectedEffects,
      system: new ConcreteFleetRuntimeV1LocalSystem(),
    })
    printJson(result)
    return result.schema_version === 'fleet-runtime-v1/typed-block-receipt/v1' ? 2 : 0
  } catch (error) {
    const code = error instanceof FleetRuntimeLocalProviderError
      ? error.code
      : error && typeof error === 'object' && 'code' in error
        ? String((error as { code: unknown }).code)
        : 'INVALID_COMMAND'
    printJson({
      schema_version: 'fleet-runtime-v1/provider-command-error/v1',
      result: 'BLOCK',
      code,
      detail: error instanceof Error ? error.message : String(error),
      protected_effect_count: 0,
    })
    return 1
  }
}

if (import.meta.main) process.exit(await main())
