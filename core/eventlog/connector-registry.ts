/**
 * Data-only authority admission contract surface.
 *
 * Runtime verification, persistence, DbAdapter ownership, and live handles are
 * intentionally lexical to registered-loader.ts.  A deep import of this file
 * cannot install verifier truth or obtain an authority writer.
 */

export {
  AUTHORITY_SUBJECT_EVENT_TYPES,
  PROTECTED_AUTHORITY_EVENT_TYPES,
  authorityAdmissionDigest,
  authorityAdmissionId,
  authorityAdmissionReceiptEventId,
  authoritySubjectConflictMaterialDigest,
  authoritySubjectPayloadDigest,
  buildAuthorityAdmissionReceipt,
  decodeAuthorityAdmissionMaterial,
  decodeAuthorityAdmissionReceipt,
  isProtectedAuthorityEventType,
  type AuthorityAdmissionMaterialV2,
  type AuthorityAdmissionReceiptV1,
  type AuthorityAdmissionVerificationKind,
  type AuthoritySubjectEventType,
  type ProtectedAuthorityEventType,
} from './transport-contract'
