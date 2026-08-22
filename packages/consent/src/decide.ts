import type { ConsentAction, ConsentAuditEvent, ConsentCategory, ConsentPolicyVersion, ConsentRecord, GpcSignal } from "./types.js";

/**
 * The pure decision core, kept separate from any I/O — the same separation
 * `decideInboundAdmission` uses in `packages/butler`. Produces the new
 * record and its audit event; the caller's `ConsentStoragePort` and
 * `ConsentAuditLedger` perform the actual writes.
 *
 * Pure and total: given the same `current`, `action`, and `now`, this
 * always returns the same `record` and `auditEvent`, with no I/O and no
 * reliance on ambient state (it never reads `Date.now()`, `new Date()`, or
 * anything else itself — `now` is supplied by the caller for exactly this
 * reason).
 *
 * `current`'s `gpcSignal` is carried forward onto the new record — a GPC
 * signal observed once for a subject is independent of any single grant/
 * deny/withdraw decision and is not re-supplied on every action. It is also
 * copied onto the audit event, so an auditor can see whether a GPC signal
 * was present at the moment of the decision without foundry ever
 * interpreting what that presence meant.
 */
export function decideConsentChange(
  subjectId: string,
  current: ConsentRecord | undefined,
  action: ConsentAction,
  now: string,
): { record: ConsentRecord; auditEvent: ConsentAuditEvent } {
  const gpcSignal = current?.gpcSignal;
  const record = buildRecord(subjectId, action, now, gpcSignal);
  const auditEvent: ConsentAuditEvent = {
    subjectId,
    category: action.category,
    type: auditEventType(action.kind),
    policyVersion: action.policyVersion,
    occurredAt: now,
    ...(gpcSignal !== undefined ? { gpcSignal } : {}),
  };
  return { record, auditEvent };
}

function buildRecord(subjectId: string, action: ConsentAction, now: string, gpcSignal: GpcSignal | undefined): ConsentRecord {
  const base = { subjectId, category: action.category, ...(gpcSignal !== undefined ? { gpcSignal } : {}) };
  if (action.kind === "grant") {
    return { ...base, state: { kind: "granted", policyVersion: action.policyVersion, decidedAt: now } };
  }
  if (action.kind === "deny") {
    return { ...base, state: { kind: "denied", policyVersion: action.policyVersion, decidedAt: now } };
  }
  return { ...base, state: { kind: "absent" } };
}

function auditEventType(kind: ConsentAction["kind"]): "granted" | "denied" | "withdrawn" {
  if (kind === "grant") return "granted";
  if (kind === "deny") return "denied";
  return "withdrawn";
}

/**
 * A pure audit-event builder for a subject reopening their preference
 * center, independent of whether they change anything once it's open.
 * "Reopening: withdrawal must be as easy as granting" (issue #178) is
 * enforced at the API surface by `useConsentPreferences.withdraw` sharing
 * `grant`/`deny`'s exact call shape (see `./web`); this function is the
 * audit-side counterpart — recording that the preference surface was
 * reopened at all is itself audit-worthy, separately from any decision
 * made once inside it.
 */
export function recordReopened(subjectId: string, category: ConsentCategory, policyVersion: ConsentPolicyVersion, now: string, gpcSignal?: GpcSignal): ConsentAuditEvent {
  return {
    subjectId,
    category,
    type: "reopened",
    policyVersion,
    occurredAt: now,
    ...(gpcSignal !== undefined ? { gpcSignal } : {}),
  };
}

/**
 * A pure audit-event builder for the moment `evaluateConsent` reports a
 * stored record as `"stale"` — i.e. a policy-version bump invalidated a
 * prior answer. `policyVersion` is the new, current version that caused
 * the staleness; `previousPolicyVersion` is the version the invalidated
 * record actually answered. Calling this is optional — `evaluateConsent`
 * itself performs no I/O and emits no audit event on its own — but a host
 * that wants staleness to appear in its audit trail (rather than only ever
 * being recomputed silently on read) calls this once it observes a
 * `"stale"` evaluation.
 */
export function recordPolicySuperseded(
  subjectId: string,
  category: ConsentCategory,
  previousPolicyVersion: ConsentPolicyVersion,
  currentPolicyVersion: ConsentPolicyVersion,
  now: string,
  gpcSignal?: GpcSignal,
): ConsentAuditEvent {
  return {
    subjectId,
    category,
    type: "policy-superseded",
    policyVersion: currentPolicyVersion,
    previousPolicyVersion,
    occurredAt: now,
    ...(gpcSignal !== undefined ? { gpcSignal } : {}),
  };
}
