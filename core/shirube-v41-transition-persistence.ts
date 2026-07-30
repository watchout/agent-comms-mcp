import type { DbAdapter } from './db'
import {
  canonicalJson,
  digestObject,
  type AunAdmissionStore,
  type AunAdmissionTransactionPort,
  type AuthoritativeReceiptEnvelope,
  type ControllerStore,
  type ControllerTransactionPort,
  type LocalConsumptionRecord,
  type PlanBinding,
  type ResultConsumptionRecord,
  type RuntimePlanState,
  type TransitionBinding,
  type TransitionReceiptWire,
  type TransitionTelemetry,
} from './shirube-v41-transition-controller'

type JsonValue = Record<string, any>

function json<T>(value: T | string): T {
  return typeof value === 'string' ? JSON.parse(value) as T : value
}

function planState(row: JsonValue): RuntimePlanState {
  return {
    root_goal_run_id: row.root_goal_run_id,
    plan_id: row.plan_id,
    plan_digest: row.plan_digest,
    generation: Number(row.generation),
    graph_id: row.graph_id,
    node_id: row.node_id,
    parent_graph_id: row.parent_graph_id,
    parent_node_id: row.parent_node_id,
    state_digest: row.state_digest,
    subject_tuple: json(row.subject_tuple),
    actor_agent_id: row.actor_agent_id,
    active_function: row.active_function,
    dispatch_state: row.dispatch_state,
    graph_state: json(row.graph_state),
    controller_adapter_id: row.controller_adapter_id,
    controller_instance_id: row.controller_instance_id,
    controller_version: row.controller_version,
  }
}

function receiptWire(row: JsonValue): TransitionReceiptWire {
  return json(row.receipt_wire)
}

/**
 * Creates the controller-side persistence boundary. Nothing imports this file
 * from the running queue path; activation is a later, separately authorized
 * operation.
 */
export function createShirubeV41ControllerStore(db: DbAdapter): ControllerStore {
  return {
    transaction: (fn) => db.transaction(async (tx) => {
      await tx.execute('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE')
      let locked: RuntimePlanState | null = null
      const port: ControllerTransactionPort = {
        async lockPlanState(binding: PlanBinding) {
          const row = await tx.queryOne<JsonValue>(
            `SELECT * FROM shirube_v41_plan_states
              WHERE root_goal_run_id = $1 AND plan_id = $2
                AND plan_digest = $3 AND generation = $4
              FOR UPDATE`,
            [binding.root_goal_run_id, binding.plan_id, binding.plan_digest, binding.generation],
          )
          locked = row ? planState(row) : null
          return locked
        },
        async loadResultConsumption(resultDigest) {
          const row = await tx.queryOne<JsonValue>(
            `SELECT result_digest, state_digest, delivery_class, receipt_wire
               FROM shirube_v41_result_consumptions WHERE result_digest = $1`,
            [resultDigest],
          )
          if (!row) return null
          return {
            result_digest: row.result_digest,
            state_digest: row.state_digest,
            delivery_class: row.delivery_class,
            receipt_wire: row.receipt_wire === null ? null : json(row.receipt_wire),
          } as ResultConsumptionRecord
        },
        async reserveReceiptRevision() {
          const row = await tx.queryOne<{ revision: string | number }>(
            `UPDATE shirube_v41_controller_adapters
                SET next_receipt_revision = next_receipt_revision + 1
              WHERE controller_adapter_id = $1 AND lifecycle_state = 'active'
              RETURNING next_receipt_revision - 1 AS revision`,
            [locked?.controller_adapter_id],
          )
          if (!row || !Number.isSafeInteger(Number(row.revision))) throw new Error('V41_RECEIPT_REVISION_FAILED')
          return Number(row.revision)
        },
        async persistReceipt(wire: TransitionReceiptWire, telemetry: TransitionTelemetry) {
          const payload = wire.receipt_payload
          const transitionRecord = {
            plan_digest: payload.plan_binding.plan_digest,
            generation: payload.plan_binding.generation,
            graph_id: payload.plan_binding.graph_id,
            node_id: payload.plan_binding.node_id,
            result_digest: payload.transition_binding.result_digest,
            from_state_digest: payload.transition_binding.from_state_digest,
            to_state_digest: payload.transition_binding.to_state_digest,
          }
          const inserted = await tx.execute(
            `INSERT INTO shirube_v41_transition_receipts
               (receipt_id, authoritative_store_revision, controller_adapter_id,
                payload_sha256, receipt_wire, canonical_wire, plan_digest, generation,
                lifecycle_state, committed_transition_record, telemetry)
             VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,'ISSUED',$9::jsonb,$10::jsonb)
             ON CONFLICT (receipt_id) DO NOTHING`,
            [payload.receipt_identity.receipt_id, payload.receipt_identity.authoritative_store_revision,
              payload.receipt_identity.controller_adapter_id, wire.payload_sha256, canonicalJson(wire),
              canonicalJson(wire), payload.plan_binding.plan_digest, payload.plan_binding.generation,
              canonicalJson(transitionRecord), canonicalJson(telemetry)],
          )
          if (inserted.rowCount !== 1) throw new Error('V41_RECEIPT_IMMUTABLE_CONFLICT')
        },
        async compareAndSwapState(fromDigest, nextState) {
          if (!locked) return false
          const updated = await tx.execute(
            `UPDATE shirube_v41_plan_states
                SET state_digest = $1, dispatch_state = $2, graph_state = $3::jsonb,
                    graph_id = $4, node_id = $5, parent_graph_id = $6, parent_node_id = $7,
                    subject_tuple = $8::jsonb, actor_agent_id = $9, active_function = $10,
                    updated_at = now()
              WHERE root_goal_run_id = $11 AND plan_id = $12
                AND plan_digest = $13 AND generation = $14 AND state_digest = $15`,
            [nextState.state_digest, nextState.dispatch_state, canonicalJson(nextState.graph_state),
              nextState.graph_id, nextState.node_id, nextState.parent_graph_id, nextState.parent_node_id,
              canonicalJson(nextState.subject_tuple), nextState.actor_agent_id, nextState.active_function,
              locked.root_goal_run_id, locked.plan_id, locked.plan_digest, locked.generation, fromDigest],
          )
          if (updated.rowCount === 1) locked = structuredClone(nextState)
          return updated.rowCount === 1
        },
        async persistResultConsumption(record) {
          const inserted = await tx.execute(
            `INSERT INTO shirube_v41_result_consumptions
               (result_digest, state_digest, delivery_class, receipt_wire)
             VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT (result_digest) DO NOTHING`,
            [record.result_digest, record.state_digest, record.delivery_class,
              record.receipt_wire === null ? null : canonicalJson(record.receipt_wire)],
          )
          if (inserted.rowCount !== 1) throw new Error('V41_RESULT_IMMUTABLE_CONFLICT')
        },
        async insertControllerOutbox(wire) {
          const payload = wire.receipt_payload
          const inserted = await tx.execute(
            `INSERT INTO shirube_v41_transition_outbox
               (idempotency_key, receipt_id, payload_sha256, receipt_wire, delivery_state)
             VALUES ($1,$2,$3,$4::jsonb,'pending')
             ON CONFLICT (idempotency_key) DO NOTHING`,
            [payload.delivery_binding.idempotency_key, payload.receipt_identity.receipt_id,
              wire.payload_sha256, canonicalJson(wire)],
          )
          if (inserted.rowCount !== 1) throw new Error('V41_OUTBOX_IMMUTABLE_CONFLICT')
        },
      }
      return fn(port)
    }),
  }
}

function consumption(row: JsonValue): LocalConsumptionRecord {
  return {
    controller_adapter_id: row.controller_adapter_id,
    receipt_id: row.receipt_id,
    payload_sha256: row.payload_sha256,
    idempotency_key: row.idempotency_key,
    handoff_digest: row.handoff_digest,
    destination_kind: row.destination_kind,
    destination_actor_agent_id: row.destination_actor_agent_id,
    destination_active_function: row.destination_active_function,
    destination_owner_principal_id: row.destination_owner_principal_id,
    destination_owner_authority_key: row.destination_owner_authority_key,
    owner_decision_schema: row.owner_decision_schema,
    protected_decision_key: row.protected_decision_key,
    queue_id: String(row.queue_id),
    message_id: row.message_id,
    provenance: json(row.provenance),
    provenance_digest: row.provenance_digest,
  }
}

const CONSUMPTION_SELECT = `controller_adapter_id, receipt_id, payload_sha256,
  idempotency_key, handoff_digest, destination_kind,
  destination_actor_agent_id, destination_active_function,
  destination_owner_principal_id, destination_owner_authority_key,
  owner_decision_schema, protected_decision_key, queue_id, message_id,
  provenance, provenance_digest`

/** AUN-side local-first admission. The queue and projection writes share one DB transaction. */
export function createShirubeV41AunAdmissionStore(db: DbAdapter): AunAdmissionStore {
  return {
    transaction: (fn) => db.transaction(async (tx) => {
      await tx.execute('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE')
      const port: AunAdmissionTransactionPort = {
        async authenticateControllerAdapter(adapterId, authenticatedCaller) {
          const row = await tx.queryOne<{ ok: boolean }>(
            `SELECT TRUE AS ok FROM shirube_v41_controller_adapters
              WHERE controller_adapter_id = $1 AND authenticated_caller = $2 AND lifecycle_state = 'active'`,
            [adapterId, authenticatedCaller],
          )
          return row?.ok === true
        },
        async loadLocalConsumption(adapterId, receiptId) {
          const row = await tx.queryOne<JsonValue>(
            `SELECT ${CONSUMPTION_SELECT} FROM shirube_v41_receipt_consumptions
              WHERE controller_adapter_id = $1 AND receipt_id = $2`, [adapterId, receiptId],
          )
          return row ? consumption(row) : null
        },
        async loadIdempotencyConsumption(adapterId, idempotencyKey) {
          const row = await tx.queryOne<JsonValue>(
            `SELECT ${CONSUMPTION_SELECT} FROM shirube_v41_receipt_consumptions
              WHERE controller_adapter_id = $1 AND idempotency_key = $2`, [adapterId, idempotencyKey],
          )
          return row ? consumption(row) : null
        },
        async loadAuthoritativeReceipt(receiptId, payloadSha256) {
          const row = await tx.queryOne<JsonValue>(
            `SELECT r.receipt_wire, r.canonical_wire, r.authoritative_store_revision,
                    r.lifecycle_state, p.dispatch_state, p.state_digest,
                    r.committed_transition_record
               FROM shirube_v41_transition_receipts r
               JOIN shirube_v41_plan_states p
                 ON p.plan_digest = r.plan_digest AND p.generation = r.generation
              WHERE r.receipt_id = $1 AND r.payload_sha256 = $2`,
            [receiptId, payloadSha256],
          )
          if (!row) return null
          return {
            wire: receiptWire(row),
            wire_bytes: row.canonical_wire,
            lookup_observed_store_revision: Number(row.authoritative_store_revision),
            lifecycle_state: row.lifecycle_state,
            dispatch_state: row.dispatch_state,
            current_state_digest: row.state_digest,
            committed_transition_record: json(row.committed_transition_record),
          } as AuthoritativeReceiptEnvelope
        },
        async registeredDestination(transition: TransitionBinding) {
          return tx.queryOne<JsonValue>(
            `SELECT destination_kind, destination_actor_agent_id, destination_active_function,
                    destination_owner_principal_id, destination_owner_authority_key,
                    owner_decision_schema, protected_decision_key
               FROM shirube_v41_destination_registry
              WHERE destination_kind = $1
                AND destination_actor_agent_id IS NOT DISTINCT FROM $2
                AND destination_active_function IS NOT DISTINCT FROM $3
                AND destination_owner_principal_id IS NOT DISTINCT FROM $4
                AND destination_owner_authority_key IS NOT DISTINCT FROM $5
                AND owner_decision_schema IS NOT DISTINCT FROM $6
                AND protected_decision_key IS NOT DISTINCT FROM $7
                AND lifecycle_state = 'active'`,
            [transition.destination_kind, transition.destination_actor_agent_id,
              transition.destination_active_function, transition.destination_owner_principal_id,
              transition.destination_owner_authority_key, transition.owner_decision_schema,
              transition.protected_decision_key],
          )
        },
        async insertQueueAndProjection(wire) {
          const transition = wire.receipt_payload.transition_binding
          const agentId = transition.destination_kind === 'AGENT_FUNCTION'
            ? transition.destination_actor_agent_id!
            : transition.destination_owner_principal_id!
          const messageId = `shirube-v41:${wire.receipt_payload.receipt_identity.receipt_id}:${wire.payload_sha256.slice(0, 16)}`
          const payload = canonicalJson({ schema: 'shirube-v4.1/transition-delivery/v1', transition_receipt: wire })
          const row = await tx.queryOne<{ id: string | number }>(
            `INSERT INTO message_queue (agent_id, message_id, payload, status)
             VALUES ($1,$2,$3,'pending')
             ON CONFLICT (message_id) DO NOTHING RETURNING id`,
            [agentId, messageId, payload],
          )
          if (!row) throw new Error('V41_QUEUE_INSERT_CONFLICT')
          const queueId = String(row.id)
          const projected = await tx.execute(
            `INSERT INTO shirube_v41_queue_projections
               (controller_adapter_id, receipt_id, payload_sha256, queue_id, message_id, projection_digest)
             VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (controller_adapter_id, receipt_id) DO NOTHING`,
            [wire.receipt_payload.receipt_identity.controller_adapter_id,
              wire.receipt_payload.receipt_identity.receipt_id, wire.payload_sha256,
              queueId, messageId, digestObject({ queue_id: queueId, message_id: messageId, payload_sha256: wire.payload_sha256 })],
          )
          if (projected.rowCount !== 1) throw new Error('V41_PROJECTION_INSERT_CONFLICT')
          return { queue_id: queueId, message_id: messageId }
        },
        async persistLocalConsumption(record) {
          const inserted = await tx.execute(
            `INSERT INTO shirube_v41_receipt_consumptions
               (${CONSUMPTION_SELECT})
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16)
             ON CONFLICT (controller_adapter_id, receipt_id) DO NOTHING`,
            [record.controller_adapter_id, record.receipt_id, record.payload_sha256,
              record.idempotency_key, record.handoff_digest, record.destination_kind,
              record.destination_actor_agent_id, record.destination_active_function,
              record.destination_owner_principal_id, record.destination_owner_authority_key,
              record.owner_decision_schema, record.protected_decision_key, record.queue_id,
              record.message_id, canonicalJson(record.provenance), record.provenance_digest],
          )
          if (inserted.rowCount !== 1) throw new Error('V41_CONSUMPTION_INSERT_CONFLICT')
        },
      }
      return fn(port)
    }),
  }
}
