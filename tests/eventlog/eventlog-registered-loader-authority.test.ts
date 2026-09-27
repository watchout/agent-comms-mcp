import { describe, expect, test } from 'bun:test'
import {
  authorityAdmissionReceiptEventId,
  buildAuthorityAdmissionReceipt,
  canonicalJson,
  decodeAuthorityAdmissionReceipt,
  sha256Utf8,
  type AuthorityAdmissionMaterialV2,
} from '../../core/eventlog'

const vectorCommon = {
  connector_instance_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  registry_generation: 1,
  capability_digest: 'c'.repeat(64),
  loader_catalog_digest: 'd'.repeat(64),
  loader_identity_digest: 'e'.repeat(64),
  verifier_contract_version: 'registered-loader/v1',
}

describe('authority receipt compatibility', () => {
  test('three canonical AuthorityAdmissionMaterialV2 receipt vectors reproduce exactly', () => {
    const vectors: Array<{
      material: AuthorityAdmissionMaterialV2
      id: string
      digest: string
      eventId: string
      admissionBytes: number
      digestBytes: number
      eventIdBytes: number
    }> = [
      {
        material: {
          ...vectorCommon,
          registration_id: '11111111-1111-4111-8111-111111111111',
          subject_event_id: 'loaded-connector-registration:1e6b04aeae60053b2b470fa64a74c822adb24539ba1fc7029f056b73f0816278',
          subject_event_type: 'authority.loaded_connector_registered',
          subject_conflict_material_digest: '1'.repeat(64),
          subject_payload_digest: '4'.repeat(64),
          verification_kind: 'loaded_build_and_fixture',
          build_test_attestation_digest: 'a'.repeat(64),
          policy_source_digest: null,
        },
        id: '2d0e98eba0c5ec3a90332ebb6d7f88fab8bbd58be19473f7f5778bdeca26363e',
        digest: 'a109805ea79ad281bc8981c9f93f8817c3742cb283bc765df7b4ba6d0d2ee728',
        eventId: 'authority-admission:335ce123d0f3ec6e585becea3bd8c42de48e0aab45fe1dd6f9ce09526dcc8705',
        admissionBytes: 1041,
        digestBytes: 1191,
        eventIdBytes: 414,
      },
      {
        material: {
          ...vectorCommon,
          registration_id: '22222222-2222-4222-8222-222222222222',
          subject_event_id: 'zero-effect-producer-registration:bcf87564e318a0ea2d4c3812c8e868e77e8facd6eeeba9d2008aee910070d5f1',
          subject_event_type: 'authority.zero_effect_producer_registered',
          subject_conflict_material_digest: '2'.repeat(64),
          subject_payload_digest: '5'.repeat(64),
          verification_kind: 'zero_effect_producer',
          build_test_attestation_digest: 'b'.repeat(64),
          policy_source_digest: null,
        },
        id: 'af22eef3983bec8a805b997c59b67a93714cf548ea8ae63c50d96ad240569dd1',
        digest: 'd564638dc2c443cbb2e3bccfd4b93cb67d5d80fa2177cd2d9212aacdcf94a56d',
        eventId: 'authority-admission:6ba7e250da4ca25a7502c3c842fa31ed23e3e646740df3b1c3699e17ce59f4c7',
        admissionBytes: 1045,
        digestBytes: 1195,
        eventIdBytes: 422,
      },
      {
        material: {
          ...vectorCommon,
          registration_id: '33333333-3333-4333-8333-333333333333',
          subject_event_id: 'retry-budget-issuer-registration:0467a083f6d86aa8f6e72e8d2dd5ac5a348b20476fb9732126ef48f3b026b602',
          subject_event_type: 'authority.retry_budget_issuer_registered',
          subject_conflict_material_digest: '3'.repeat(64),
          subject_payload_digest: '6'.repeat(64),
          verification_kind: 'retry_budget_issuer_and_policy',
          build_test_attestation_digest: 'c'.repeat(64),
          policy_source_digest: 'f'.repeat(64),
        },
        id: 'b0c2e1cd0ef4760691d456c68ba9ccf67e011c2a37528165f0f7440ecc5dadf6',
        digest: '37005c2b73c6fc08487ae4c61043c2cb74e858b4a67f368953a32cbf616125a8',
        eventId: 'authority-admission:72ccfd53bd2c68183dbf94829e1dab86906e1c6da06b76c0d52b24c6be588f7d',
        admissionBytes: 1115,
        digestBytes: 1265,
        eventIdBytes: 420,
      },
    ]
    for (const vector of vectors) {
      const receipt = buildAuthorityAdmissionReceipt(vector.material)
      expect(receipt.admission_id).toBe(vector.id)
      expect(receipt.admission_digest).toBe(vector.digest)
      expect(authorityAdmissionReceiptEventId(receipt)).toBe(vector.eventId)
      const { admission_digest: _, ...withoutDigest } = receipt
      const eventKey = {
        admission_id: receipt.admission_id,
        subject_event_id: receipt.subject_event_id,
        subject_event_type: receipt.subject_event_type,
        registry_generation: receipt.registry_generation,
        admission_digest: receipt.admission_digest,
      }
      expect(Buffer.byteLength('aun-authority-admission-id/v1\n' + canonicalJson(vector.material))).toBe(vector.admissionBytes)
      expect(Buffer.byteLength('aun-authority-admission-receipt-material/v1\n' + canonicalJson(withoutDigest))).toBe(vector.digestBytes)
      expect(Buffer.byteLength('aun-authority-admission-receipt-event-id/v1\n' + canonicalJson(eventKey))).toBe(vector.eventIdBytes)
      expect(sha256Utf8('aun-authority-admission-id/v1\n\n' + canonicalJson(vector.material))).not.toBe(vector.id)
    }
  })

  test('receipt decoding rejects extras, unsafe numbers, and recomputed-looking mutations', () => {
    const material: AuthorityAdmissionMaterialV2 = {
      ...vectorCommon,
      registration_id: '11111111-1111-4111-8111-111111111111',
      subject_event_id: 'loaded-connector-registration:1e6b04aeae60053b2b470fa64a74c822adb24539ba1fc7029f056b73f0816278',
      subject_event_type: 'authority.loaded_connector_registered',
      subject_conflict_material_digest: '1'.repeat(64),
      subject_payload_digest: '4'.repeat(64),
      verification_kind: 'loaded_build_and_fixture',
      build_test_attestation_digest: 'a'.repeat(64),
      policy_source_digest: null,
    }
    const receipt = buildAuthorityAdmissionReceipt(material)
    expect(() => decodeAuthorityAdmissionReceipt({ ...receipt, extra: true })).toThrow()
    expect(() => decodeAuthorityAdmissionReceipt({ ...receipt, registry_generation: Number.MAX_SAFE_INTEGER + 1 })).toThrow()
    expect(() => decodeAuthorityAdmissionReceipt({ ...receipt, admission_id: '0'.repeat(64) })).toThrow()
  })
})
