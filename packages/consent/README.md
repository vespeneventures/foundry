# @vespeneventures/consent

A provider-neutral consent record core: versioned policies, a three-state
consent model (`absent` / `denied` / `granted`), Global Privacy Control (GPC)
signal representation, and audit events — plus host-implemented storage and
audit ports. No cookie library, no localStorage adapter, no database client,
no analytics or tag-manager integration, and no jurisdiction logic. An
optional `./web` subpath adds an SSR-safe gate component and preference-
management hooks, built entirely on this package's pure functions.

## Migration

This package is deprecated. Its responsibilities split deliberately: move a
person's consent record and current standing instructions to
[`@vespeneventures/butler`](../butler) at `^0.1.0`, and move enforcement plus
owed delivery to [`@vespeneventures/giver`](../giver) at `^0.1.1`. Existing
published `consent` versions remain available while consumers migrate, but no
forwarding stub will ship; make each responsibility explicit at the new
boundary.

```bash
npm install @vespeneventures/consent
```

## This package does not make you compliant

**This package makes a consent record auditable. It does not make a product
compliant with GDPR, CPRA, or any other regime.** It carries no jurisdiction
logic, no legal wording, and no opinion about what a given jurisdiction
requires. Whether a GPC signal legally constitutes a request, whether a
policy-version bump must re-prompt someone who already declined, what
categories your product needs, and what your banner says are all decisions
this package deliberately leaves to you and your counsel. See "Non-goals"
below.

## Why a record, not a boolean

A stored consent that is just `true`/`false` cannot say which policy version
someone answered, so a later policy change has nothing to compare against —
old and current answers become indistinguishable. It also cannot represent
"never asked" as anything other than the same falsy value as "asked and
refused," which silently treats absence of a signal as a passing one — the
same failure mode this workspace already calls out for gate exit codes (see
[CONTRIBUTING.md](../../CONTRIBUTING.md)'s "Gate CLIs exit `0` clean..."
entry). `ConsentState` has exactly three variants —
`{ kind: "absent" }`, `{ kind: "denied", policyVersion, decidedAt }`,
`{ kind: "granted", policyVersion, decidedAt }` — and there is no boolean or
two-state representation anywhere in this package's public API.

## Usage

```ts
import { decideConsentChange, evaluateConsent, type ConsentPolicyVersion, type ConsentStoragePort } from "@vespeneventures/consent";

const currentPolicyVersion: ConsentPolicyVersion = { policyId: "cookie-policy", version: "3" };

// storage is implemented by the host — see "Boundaries" below.
declare const storage: ConsentStoragePort;

const stored = await storage.read("sub-123", "marketing");
const evaluation = evaluateConsent(stored, currentPolicyVersion, {
  // No default — see "The denial-invalidation question" below.
  invalidateDenialOnPolicyBump: false,
});

if (evaluation.status === "absent" || evaluation.status === "stale") {
  // Ask the subject. Once they answer:
  const { record, auditEvent } = decideConsentChange(
    "sub-123",
    stored,
    { kind: "grant", category: "marketing", policyVersion: currentPolicyVersion },
    new Date().toISOString(),
  );
  await storage.write(record);
  await auditLedger.record(auditEvent); // auditLedger: ConsentAuditLedger, also host-implemented
}
```

`decideConsentChange` is pure — no I/O, no `Date.now()` inside it, no
reliance on ambient state. Given the same `current`, `action`, and `now` it
always returns the same `record` and `auditEvent`; the caller's
`ConsentStoragePort` and `ConsentAuditLedger` perform the actual writes. This
mirrors the split `packages/butler` uses for
`decideInboundAdmission`/`admitInboundEvent`.

## The three consent states, and why "stale" is a fourth thing

`ConsentEvaluation` (the output of `evaluateConsent`) has four statuses, not
three, because "does this stored record still speak for the current policy"
is a different question from "what did the subject answer":

| Status | Meaning |
| --- | --- |
| `absent` | No record exists, or the stored record's own state is `absent`. |
| `granted` | A stored `granted` record whose `policyVersion` matches the current policy version. |
| `denied` | A stored `denied` record whose `policyVersion` matches the current policy version — or, if `invalidateDenialOnPolicyBump` is `false`, an older one too. |
| `stale` | A stored answer that no longer speaks for the current policy version and should be asked again. Carries `previousPolicyVersion`, the version it actually answered. |

A `granted` record under an older policy version is **always** `stale` —
a policy change invalidates prior consent to share/track/process data by
definition, unconditionally. There is no flag that changes this for grants.

## The denial-invalidation question

Whether a policy-version bump also invalidates a stored **`denied`** record
is a genuine open question in
[issue #178](https://github.com/vespeneventures/foundry/issues/178), and
this package deliberately does not answer it. The argument for invalidating
it: a policy change can alter what a refusal even covered (new categories,
new processors), so carrying an old "no" forward answers a question that was
never asked. The argument against: re-prompting someone who already declined,
purely because wording changed, is the dark-pattern behavior consent rules
exist to prevent in some regimes.

This is a **jurisdiction judgment, not a structural one** — exactly the kind
of decision this package's whole boundary keeps consumer-owned. `evaluateConsent`
takes a required, no-default `invalidateDenialOnPolicyBump: boolean` inside its
third `policy` argument. There is no default in either direction: omitting it
is a type error, so no consumer gets either answer by accident. **This
package does not recommend a value — that call needs someone who actually
knows the relevant regimes, not a default baked into a library.**

## GPC is represented, never interpreted

```ts
export interface GpcSignal {
  present: boolean;
  observedAt: string;
}
```

`GpcSignal` records that a Global Privacy Control signal was observed and
when. **There is no function anywhere in this package that maps a `GpcSignal`
to a consent state, a grant, or a denial.** Whether a GPC signal legally
constitutes a valid request is a jurisdiction question this package leaves
entirely to the host. A record's `gpcSignal` (if any) carries forward
automatically across `decideConsentChange` calls and onto the resulting audit
event, so an auditor can see whether a signal was present at the moment of a
decision without this package ever deciding what that presence meant.

## Audit events: what is recorded, and what must never be

```ts
export interface ConsentAuditEvent {
  subjectId: string;
  category: ConsentCategory;
  type: ConsentAuditEventType; // "granted" | "denied" | "withdrawn" | "reopened" | "policy-superseded"
  policyVersion: ConsentPolicyVersion;
  occurredAt: string;
  gpcSignal?: GpcSignal;
  previousPolicyVersion?: ConsentPolicyVersion; // "policy-superseded" only
}
```

`subjectId` is a host-owned, opaque identity reference — the same
`recipientId` pattern `packages/comms` already establishes for
`EmailMessage`. **`ConsentAuditEvent` never carries a raw personal-data
field: no email, no name, no IP address.** `src/audit-shape.check.ts` is a
compile-time contract test (`tsc`, not `vitest`) that fails the build if a
personal-data-shaped key is ever added to this type. `category` is a
consumer-defined label ("marketing", "analytics", ...), never itself
personal data.

`decideConsentChange` emits `"granted"` / `"denied"` / `"withdrawn"` events.
Two more builders cover events outside a state change: `recordReopened`
(a subject reopened their preference center — audit-worthy on its own,
independent of whether they changed anything) and `recordPolicySuperseded`
(a stored record was found `stale` by `evaluateConsent`; records both the
version that was invalidated and the version that invalidated it). Neither
performs any I/O — like `decideConsentChange`, they only build the event; a
host's `ConsentAuditLedger` records it.

## Boundaries

- **Storage is a host-implemented port.** `ConsentStoragePort` (`read`,
  `write`, `readAll`) and `ConsentAuditLedger` (`record`) are the only I/O
  surfaces this package defines. Neither ships a concrete implementation —
  no cookie library, no localStorage adapter, no database client. This
  package does not choose cookies vs. localStorage vs. a server-side session
  vs. a database row.
- **Jurisdiction logic, banner copy, and category definitions are all
  consumer-owned.** `ConsentCategory` is a plain `string` — this package does
  not enumerate categories, the way `packages/policy` "does not know what a
  'denylist' is."
- **No analytics or tag-manager vendor integrations**, for the same reason
  `packages/comms` ships no analytics wiring: this is a decision core and a
  port, not a vendor SDK.

## API

| Export | Kind | Purpose |
| --- | --- | --- |
| `evaluateConsent(...)` | function | Pure — `(record, currentPolicyVersion, policy)`. Compares a stored record against the policy version in force and returns a `ConsentEvaluation`. `record === undefined` (and only `undefined`) yields `{ status: "absent" }` — every other malformed shape is a type error, never a runtime fallback. |
| `decideConsentChange(...)` | function | Pure — `(subjectId, current, action, now)`. Builds the new `ConsentRecord` and its `ConsentAuditEvent` for a `grant`/`deny`/`withdraw` action. No I/O. |
| `recordReopened(...)` | function | Pure — `(subjectId, category, policyVersion, now, gpcSignal?)`. Builds a `"reopened"` audit event. |
| `recordPolicySuperseded(...)` | function | Pure — `(subjectId, category, previousPolicyVersion, currentPolicyVersion, now, gpcSignal?)`. Builds a `"policy-superseded"` audit event for a record `evaluateConsent` found `stale`. |
| `isConsentCategory(value)` | function | Hand-rolled runtime type guard: a non-empty string. |
| `isConsentPolicyVersion(value)` | function | Hand-rolled runtime type guard for `ConsentPolicyVersion`. |
| `isGpcSignal(value)` | function | Hand-rolled runtime type guard for `GpcSignal`. |
| `isConsentAction(value)` | function | Hand-rolled runtime type guard for `ConsentAction`. Useful for validating an untyped request body (a preference-center API route) before calling `decideConsentChange`. |
| `ConsentCategory` | type | `string`. Consumer-defined; this package enumerates none. |
| `ConsentPolicyVersion` | type | `{ policyId: string; version: string }`. |
| `ConsentState` | type | `{ kind: "absent" } \| { kind: "denied"; policyVersion; decidedAt } \| { kind: "granted"; policyVersion; decidedAt }`. |
| `GpcSignal` | type | `{ present: boolean; observedAt: string }`. |
| `ConsentRecord` | type | `{ subjectId; category; state; gpcSignal? }`. |
| `ConsentStoragePort` | type | Host-implemented: `read`, `write`, `readAll`. |
| `ConsentEvaluation` | type | `{ status: "absent" } \| { status: "stale"; previousPolicyVersion } \| { status: "granted"; policyVersion } \| { status: "denied"; policyVersion }`. |
| `ConsentEvaluationPolicy` | type | `{ invalidateDenialOnPolicyBump: boolean }` — no default; see "The denial-invalidation question". |
| `ConsentAction` | type | `{ kind: "grant" \| "deny" \| "withdraw"; category; policyVersion }`. Every variant, including `withdraw`, carries `policyVersion` — see "Divergences" below. |
| `ConsentAuditEventType` | type | `"granted" \| "denied" \| "withdrawn" \| "reopened" \| "policy-superseded"`. |
| `ConsentAuditEvent` | type | See "Audit events" above. |
| `ConsentAuditLedger` | type | Host-implemented: `record(event)`. |

## `./web` subpath

```bash
npm install @vespeneventures/consent react react-dom
```

```ts
import { ConsentGate, useConsentPreferences } from "@vespeneventures/consent/web";
```

The root package never imports React — only `./web` does, and its
`react`/`react-dom` peers are declared `optional: true` in
`peerDependenciesMeta`, matching `packages/auth`'s existing pattern for its
own framework subpaths. Importing `@vespeneventures/consent` on its own
never pulls in React at all.

### SSR contract

`ConsentGate` never fetches, reads, or resolves anything itself. `evaluation`
is a **required prop**, resolved by the host before first render — server-
side for an SSR page. There is no default and no loading state: the
component renders `children` when `evaluation.status === "granted"` and
`fallback` for every other status, including `"absent"`.

**Because `evaluation` is an injected prop rather than something the
component resolves itself, this package guarantees the server render and the
first client render are byte-identical for a given `evaluation` value** — a
consent-gated component rendering one way on the server and a different way
after hydration is a real flash-of-wrong-content bug, and there is nothing
inside `ConsentGate` that can diverge between the two renders (no
client-only effect, no client-only storage read, no intermediate state). A
host is responsible for resolving `evaluation` identically on the server and
for the first client render — typically by embedding the server-resolved
evaluation into the page and reading it back on the client rather than
re-deriving it — but `ConsentGate` itself never introduces a mismatch. A test
in `src/web/ConsentGate.test.tsx` proves this directly with `renderToString`
and `hydrateRoot`, for every `ConsentEvaluation` status, rather than only
asserting it in prose.

### Reopening

`useConsentPreferences` exposes `withdraw` as a first-class method with the
exact same call shape as `grant`/`deny` — `withdraw(category): Promise<void>`,
backed by the identical `ConsentPreferencesClient.apply` round trip. Revoking
consent is never a harder-to-reach code path than giving it.

### `./web` API

| Export | Kind | Purpose |
| --- | --- | --- |
| `ConsentGate` | component | Renders `children` when `evaluation.status === "granted"`, `fallback` otherwise. See "SSR contract" above. |
| `useConsentPreferences(options)` | hook | Reads every stored record for a subject via a host-supplied `ConsentPreferencesClient`, evaluates each of `options.categories`, and exposes `grant`/`deny`/`withdraw`. |
| `ConsentPreferencesClient` | type | Host-implemented: `read(subjectId)`, `apply(subjectId, action)` — see "Divergences" below. |
| `REACT_DECLARED_RANGE` | constant | This subpath's exact `peerDependencies.react` range (`">=18"`), asserted against the installed `react` at import time. Throws a named, actionable error if `react` is absent or out of range. |

## Divergences from issue #178's illustrative API

#178 explicitly frames its API section as illustrative, not literal. Two
real divergences worth calling out:

1. **Every `ConsentAction` variant, including `withdraw`, carries
   `policyVersion`.** The issue's illustrative `{ kind: "withdraw"; category
   }` omits it, but `ConsentAuditEvent.policyVersion` is required on every
   audit event — a `"withdrawn"` event with no version to cite would either
   have to guess one from `current` (silently wrong when `current` is
   `absent`, i.e. withdrawing something never granted) or leave the field
   out (an audit event that doesn't say which policy was in force).
   Requiring it keeps `decideConsentChange` pure and total without either
   compromise, and is honestly more correct: a preference center shows the
   current policy version at the moment someone clicks "withdraw," so citing
   it is not a stretch.
2. **`useConsentPreferences` takes a `ConsentPreferencesClient`, not just
   `(subjectId, policyVersion)`.** `ConsentStoragePort` is `Promise`-based
   host I/O, most naturally implemented server-side — a browser cannot call
   it directly as a plain async function. `ConsentPreferencesClient` is the
   client-shaped counterpart: still host-implemented and opinion-free about
   transport, but shaped for the side of the boundary that actually runs in
   a browser (typically a `fetch` to a host-owned API route that itself runs
   `decideConsentChange` and the two I/O ports server-side).

## Why one package with a `./web` subpath, not two

The core has to be importable from a server-side webhook handler, a build
step, or a non-React frontend with zero framework weight — exactly the
situation `packages/comms` already solves for by keeping React out of
anything that isn't the specific subpath that needs it. A single package
with an optional `./web` subpath achieves the same isolation a second
package would, without a second `package.json`, a second version to keep in
lockstep with the core, or a second published artifact whose only reason to
exist is one `peerDependenciesMeta` block. `packages/auth` already
demonstrates this exact shape for its own framework-specific code
(`./providers/clerk/web`) inside one package; `./web` here follows it.

## Non-goals

| Not in scope | Why |
| --- | --- |
| Jurisdiction logic (which regime applies, what it requires) | Legal, not structural; varies by consumer and counsel. |
| User-facing wording (banner copy, category descriptions) | Product and legal language, consumer-owned like every other copy in this workspace (see `@vespeneventures/copy`). |
| Whether a GPC signal legally constitutes a valid request | Jurisdiction question; this package records that a signal was present, nothing more. |
| Analytics or tag-manager vendor integrations | Out of scope for the same reason `packages/comms` ships no analytics wiring. |
| Organization-wide policy (which categories exist, default states) | Consumer-owned configuration. |
| Any claim, express or implied, of legal compliance | This package makes a record auditable; it does not make a product compliant. |
| Storage mechanism (cookies, localStorage, server-side session, database) | Host-implemented port — see "Boundaries". |

## Requirements

Node 20+. ESM only. **Zero runtime dependencies** in the root package. `./web`
declares `react`/`react-dom` as optional peers (`>=18`); importing the root
package never installs or loads either.

**Registry note: that "never installs" claim is about what the root package
imports, not about what a consumer's install command pulls in.** `react` and
`react-dom` are correctly declared `optional: true` in
`peerDependenciesMeta` — a consumer using only the provider-neutral root
(policies, evaluation, audit events) has no code-level need for either. But
that optionality does not reach an installer resolving against
`npm.pkg.github.com`: the registry's packument omits
`peerDependenciesMeta` entirely, so both peers install as required the
moment `@vespeneventures/consent` is installed at all, whether or not
`./web` is ever imported. See
[issue #226](https://github.com/vespeneventures/foundry/issues/226) for the
full evidence and why the declarations stay as-is.

## Licence

MIT
