# @vespeneventures/auth

One ESM package for authorization primitives, delegated-agent guards, and
optional Clerk adapters. Import only the subpath your application uses: the
provider-neutral root and agent modules do not load Clerk, React, Next.js, or
server-only webhook code.

## Migration

This package is deprecated. New authorization work belongs in
[`@vespeneventures/bouncer`](../bouncer) at `^0.1.0`, the Program C role for
who an actor is and what they are allowed to do. Existing published `auth`
versions remain available while consumers migrate, but no forwarding stub will
ship: replace imports deliberately and use the bouncer package's documented
provider boundaries.

```bash
npm install @vespeneventures/auth
```

For the Clerk web adapter, install its framework peers in the consuming
application:

```bash
npm install @vespeneventures/auth @clerk/nextjs next react react-dom
```

## Imports

| Import | Use |
| --- | --- |
| `@vespeneventures/auth` | Provider-neutral roles, sessions, membership reconciliation, and safe redirect policy. |
| `@vespeneventures/auth/agent` | Delegated-agent lifecycle, tool-scope, and monetary-authority guards. |
| `@vespeneventures/auth/providers/clerk` | Server-side raw-body webhook verification and minimal lifecycle mapping. |
| `@vespeneventures/auth/providers/clerk/web` | Client-safe Clerk provider and sign-in exports. |
| `@vespeneventures/auth/providers/clerk/web/client` | Explicit client-safe alias for the Clerk web exports. |
| `@vespeneventures/auth/providers/clerk/web/proxy` | Edge-safe Next.js middleware and route-protection helpers. |
| `@vespeneventures/auth/providers/clerk/web/server` | Route/page-only sign-in, redirect, and sign-out helpers. |

Provider adapters are isolated under `providers/<name>` so later providers can
use the same package without changing root imports. Persistence, personas,
token issuance, and product authorization policy remain application-owned.

## Provider-neutral authorization

```ts
import { defineRoleHierarchy, viewerHasAccess } from "@vespeneventures/auth";

const roles = defineRoleHierarchy(["viewer", "editor", "owner"]);
const mayEdit = viewerHasAccess({ subjectId: "user-42", role: "editor" }, "editor", roles);
```

Unknown or missing roles fail closed. `isAuthorized` authorizes only a literal
`true` returned by the application's predicate and denies malformed, absent,
or expired sessions.

For external membership events, normalize the provider payload and reconcile
it inside the consumer's transaction:

```ts
import { reconcileExternalMembership } from "@vespeneventures/auth";

const result = await reconcileExternalMembership({
  queryAdapter,
  repository,
  event: {
    eventId: "evt-42",
    type: "updated",
    provider: "identity-service",
    providerMembershipId: "membership-42",
    role: "editor",
    occurredAt: "2026-08-11T12:00:00.000Z",
    version: 8,
  },
});
```

The repository takes a transaction-scoped lock for each external identity,
including an identity without a membership row. It claims delivery IDs,
retains ordering cursors after deletion, makes retries idempotent, and only
allows an `updated` provider event to replace an existing role. Caller-owned
fields on a stored membership are preserved.

For post-auth navigation, use a fixed allowlist:

```ts
import { createAllowedOriginPolicy, resolveSafeRedirect } from "@vespeneventures/auth";

const policy = createAllowedOriginPolicy(["https://app.example.test"]);
const destination = resolveSafeRedirect("/settings", policy, "https://app.example.test");
```

`resolveSafeRedirect` rejects malformed, cross-origin, protocol-relative,
backslash, non-HTTP(S), and credential-bearing targets. Relative paths require
an explicit allowed base origin.

`createAllowedOriginPolicy` tolerates and collapses duplicate origins
(preserving first-occurrence order) instead of throwing — an allowlist built
from configuration commonly contains repeats (two env vars falling back to
the same default literal, merged lists, and so on), and a set of allowed
origins is inherently a set. It still throws for genuinely invalid entries:
non-string, malformed, empty, credential-bearing, or path/query-bearing
origins.

`resolveSafeRedirect`'s `baseOrigin` parameter is mandatory whenever `target`
is a path-style target (starts with `/`). These two failure modes are
deliberately different:

- **Omitting `baseOrigin` entirely** for a path-style target is a caller
  programming error — the function throws a `TypeError`.
- **A rejected target** — including a `baseOrigin` that is present but not
  itself allowlisted, or any other unsafe/attacker-controlled target — is a
  security outcome, not a bug, and returns `undefined`, exactly as before.
  `resolveSafeRedirect` never throws on attacker-controlled input.

Before this distinction existed, both cases returned the identical
`undefined` sentinel, which made "I forgot to pass `baseOrigin`" and "this
redirect target is unsafe" indistinguishable at the call site.

## Delegated agents

```ts
import { assertAgentCanCall, assertAgentMonetaryAuthority } from "@vespeneventures/auth/agent";

assertAgentCanCall(context, "billing.create", new Date());
assertAgentMonetaryAuthority(context, 500, "USD", "billing.create", new Date());
```

Both guards fail closed. The monetary guard first enforces lifecycle and tool
scope, including when no monetary limit is configured.

## Clerk adapters

Use the provider server subpath only in a webhook handler after obtaining the
raw request body and headers:

```ts
import { verifyAndMapClerkWebhook } from "@vespeneventures/auth/providers/clerk";

const mapped = await verifyAndMapClerkWebhook(rawBody, headers, signingSecret, {
  roleMapper: ({ providerRole }) => providerRole,
});
```

Verification happens before mapping. The mapped event retains only the fields
needed for lifecycle or membership reconciliation; raw bodies, headers,
profile fields, metadata, and signing material are not returned.
In a Fetch/Next.js route, pass `request.headers` directly and obtain `rawBody`
with `await request.text()` exactly once; do not parse and reserialize it before
verification.

In a Next.js client boundary:

```tsx
import { AuthProvider } from "@vespeneventures/auth/providers/clerk/web/client";
import type { ReactNode } from "react";

export function Providers({ children }: { children: ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>;
}
```

Use `@vespeneventures/auth/providers/clerk/web/proxy` in Next.js middleware.
Use `@vespeneventures/auth/providers/clerk/web/server` for route/page helpers.
The sign-out route applies strict redirect handling and requires a
same-origin `POST` before revoking an active session.

For local development only, `NEXT_PUBLIC_DEV_NO_AUTH=1` bypasses Clerk when
`NODE_ENV` is exactly `development`. It is ignored in tests, previews, and
production, and should never be configured for a deployed environment.

### A sanitized redirect is worthless if the widget it's handed to prefers a raw one

Validating a redirect target with `resolveSafeRedirect` only closes the hole
if the sanitized value actually reaches the browser as the destination. It is
easy to sanitize correctly and then hand the result to a UI prop that some
other, attacker-controllable input can simply outrank.

`ClerkSignInBlock` (in `@vespeneventures/auth/providers/clerk/web/client`) is
the worked example: it renders Clerk's `<SignIn>` widget, which independently
reads its own `redirect_url` query parameter from the page URL at render
time. Clerk's `forceRedirectUrl` prop takes precedence over that query
parameter, environment variables, and every other redirect source; its
`fallbackRedirectUrl` prop is used only when nothing else supplies a value —
so a raw, attacker-controllable query param wins over a `fallbackRedirectUrl`
that was populated from `resolveSafeRedirect`, silently defeating the
sanitization. `ClerkSignInBlock` passes the sanitized `redirect_url` prop as
`forceRedirectUrl` for exactly this reason.

The lesson generalizes beyond Clerk: whenever you wire `resolveSafeRedirect`'s
result into any auth UI, confirm — for that specific widget, by reading its
actual prop/parameter semantics — that the sanitized value is the one that
wins, not merely one candidate among several the widget consults.

## API

| Export | Kind | Purpose |
| --- | --- | --- |
| `QueryAdapter` | type | Minimal SQL query capability supplied to repository operations; repositories retain result typing. |
| `TransactionalQueryAdapter` | type | A `QueryAdapter` with `transaction` for atomic units of work. |
| `WithTransactionQueryAdapter` | type | A `QueryAdapter` using the common `withTransaction` pool spelling; normalized automatically. |
| `isQueryAdapter(value)` | function | Runtime `QueryAdapter` compatibility guard. |
| `isTransactionalQueryAdapter(value)` | function | Runtime transaction-capability guard. |
| `requireTransactionalQueryAdapter(value)` | function | Returns a compatible adapter or throws before repository work begins. |
| `RoleHierarchy` | type | Ordered, closed set of application-defined roles. |
| `Viewer` | type | Provider-neutral subject and optional role. |
| `defineRoleHierarchy(roles)` | function | Validates and freezes a hierarchy from least to most privileged. |
| `getRoleRank(role, hierarchy)` | function | Returns a configured role's rank or `undefined`. |
| `isKnownRole(role, hierarchy)` | function | Checks membership in the configured role set. |
| `hasRoleAtLeast(role, requiredRole, hierarchy)` | function | Compares configured roles and fails closed for missing or unknown roles. |
| `resolveViewerRole(viewer, hierarchy)` | function | Returns a viewer role only when configured. |
| `viewerHasAccess(viewer, requiredRole, hierarchy)` | function | Evaluates a viewer's minimum-role access. |
| `Session` | type | Framework-neutral session data. |
| `SessionResolver` | type | Resolves a session from application-owned context. |
| `AuthorizationPredicate` | type | Application-defined authorization decision seam. |
| `isAuthorized(predicate, session, context)` | function | Authorizes only a literal successful predicate result. |
| `ExternalMembershipIdentity` | type | Immutable provider and membership identity. |
| `ExternalMembership` | type | Stored provider membership with caller-extensible local fields. |
| `ExternalMembershipEvent` | type | Normalized created, updated, or deleted provider event. |
| `ExternalMembershipEventClaim` | type | Provider-namespaced delivery identity used for retries. |
| `ExternalMembershipEventCursor` | type | Per-identity ordering state retained independently of a row. |
| `ExternalMembershipCreateInput` | type | Repository input for locally owned membership fields. |
| `ExternalMembershipRepository` | type | Transaction-scoped persistence seam. |
| `ReconcileExternalMembershipCommand` | type | Dependencies and event for one reconciliation. |
| `ExternalMembershipReconciliationResult` | type | Status and optional membership from reconciliation. |
| `reconcileExternalMembership(command)` | function | Atomically reconciles a normalized provider event. |
| `AllowedOriginPolicy` | type | Strict validated set of allowed origins. |
| `createAllowedOriginPolicy(origins)` | function | Creates a policy from absolute HTTP(S) origins. |
| `isAllowedOrigin(origin, policy)` | function | Tests a URL against a policy. |
| `resolveSafeRedirect(target, policy, baseOrigin?)` | function | Resolves an allowed destination or returns `undefined`. |

## Requirements

Node 20+ and ESM. The root and `/agent` subpaths have no framework or
provider runtime dependency: `svix` — needed only by the Clerk webhook
adapter (`./providers/clerk`) — is an optional peer, not a hard dependency,
so installing this package alone never pulls it in. The Clerk web subpaths
require the listed optional peers in the consuming application.

Marking a peer optional means npm gives no install-time signal if it's
missing or on an incompatible version. This package guards every optional
peer it actually imports itself, throwing a named error (never a silent
pass) that states whether the peer is absent entirely or installed but
outside its declared range, instead of letting the peer's own call
surface crash first with nothing naming a version as the cause:

- `svix` — guarded from `providers/clerk/verify.ts` (webhook signature
  verification), declared range `^1.96.0`.
- `@clerk/nextjs` and `next` — guarded from `providers/clerk/web/
  server-routes.ts` (the `./providers/clerk/web/server` subpath, reachable
  only through a genuinely Node-context file, never the browser-bundled
  `./providers/clerk/web` client subpath), declared ranges `>=7 <8` and
  `>=16 <17`. The edge-safe middleware entry
  (`./providers/clerk/web/proxy`) deliberately stays unguarded — it also
  imports `@clerk/nextjs/server` and `next/server`, but a filesystem-based
  version check there would break the Node-free edge compatibility that
  file exists to guarantee.
- `react` — guarded from `providers/clerk/web/client.tsx` (the
  `"use client"` entry), declared range `>=19 <20`, read from React's own
  exported `version` rather than a filesystem check, since this module
  runs in a browser bundle as easily as in Node — and, unlike the
  `@clerk/nextjs`/`next` guard above, never imports the filesystem-based
  resolver at all (see `src/internal/peer-version.ts` vs.
  `resolve-installed-peer-version.ts`).

`react-dom` has no guard: no file in this package imports it directly,
only your own render call does, downstream of the components this
package exports.

See `src/internal/peer-version.ts` and
`src/internal/resolve-installed-peer-version.ts` for the guard's own
contract.

**Registry note: this only guards against a wrong version, not against an
unwanted install.** All five peers — `@clerk/nextjs`, `next`, `react`,
`react-dom`, `svix` — are declared `optional: true` in
`peerDependenciesMeta`, and that is correct for the tarball this package
publishes. It is not what an installer sees from `npm.pkg.github.com`: the
registry's packument omits `peerDependenciesMeta` entirely, so all five
resolve as required regardless of which subpath a consumer actually imports.
Concretely, a consumer who installs this package only for the provider-neutral
root or `./agent` — the exact case this README opens by describing as
Clerk/React/Next-free — still gets Clerk, Next.js, React, React DOM, and
`svix` installed. The per-subpath guards above still do their job once
something is installed; they cannot make the registry stop installing peers
it was told to treat as optional. See
[issue #226](https://github.com/vespeneventures/foundry/issues/226) for the
full evidence and why the declarations stay as-is.

## Licence

MIT
