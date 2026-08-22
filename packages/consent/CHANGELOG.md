# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.2] - 2026-08-19

### Changed

- **`prepublishOnly` now runs the name-collision check before building.** A hand-run `npm publish` from this package's directory previously built and published without `check-name-collision.mjs` ever executing — npm only runs `prepublishOnly` for a directory-type publish, and this manifest declared just `npm run build`. See [issue #273](https://github.com/vespeneventures/foundry/issues/273). No runtime behavior changed.

## [0.1.1] - 2026-08-14

### Changed

- **Documented effective install behaviour on the GitHub Packages
  registry.** `react` and `react-dom` are correctly declared
  `optional: true` in `peerDependenciesMeta` for the `./web` subpath, but
  `npm.pkg.github.com`'s packument omits that field entirely, so an
  installer resolving against this registry treats both as required the
  moment this package is installed at all, whether or not `./web` is ever
  imported. No `peerDependenciesMeta` block changed; see the README's
  "Requirements" section and
  [issue #226](https://github.com/vespeneventures/foundry/issues/226) for
  the full evidence and decision.

## [0.1.0] - 2026-08-13

### Added

- Initial release: a provider-neutral consent record core.
- `ConsentState` (`absent` / `denied` / `granted`), `ConsentPolicyVersion`,
  `ConsentRecord`, `ConsentCategory`, `GpcSignal`.
- `evaluateConsent()` — pure evaluation of a stored record against the
  current policy version, including a required, no-default
  `invalidateDenialOnPolicyBump` policy for the denial-invalidation open
  question left in issue #178.
- `decideConsentChange()` — pure grant/deny/withdraw decision core, kept
  separate from I/O, mirroring `decideInboundAdmission` in `@vespeneventures/butler`.
- `recordReopened()` and `recordPolicySuperseded()` — pure audit-event
  builders for reopening a preference center and for a policy bump
  invalidating a stored answer.
- `ConsentStoragePort` and `ConsentAuditLedger` — host-implemented storage
  and audit ports; no concrete implementation ships.
- Hand-rolled runtime type guards: `isConsentCategory`, `isConsentPolicyVersion`,
  `isGpcSignal`, `isConsentAction`.
- `./web` subpath: `ConsentGate` (an SSR-safe gate component with a tested
  server/first-client-render parity contract) and `useConsentPreferences`
  (a preference-management hook with `grant`/`deny`/`withdraw`, all sharing
  one call shape). `react`/`react-dom` are optional peers of this subpath
  only.
