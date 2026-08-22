# Decisions

The identity decisions below are made, not placeholders, so a future reader
doesn't have to reconstruct the reasoning from git history.

## 1. The publishing scope — `@vespeneventures`

**Status:** set in [`package-scope.json`](../package-scope.json).

`vespeneventures` owns this repository's packages, with no relationship to a
package published by a different producer. Foundry is the only repository under
this owner authorized to publish packages. A private account-control-plane
repository may coexist, but it does not publish packages or weaken Foundry's
owner-wide name-collision gate.

Changing the scope, if it's ever needed, is still one command:

```bash
node scripts/set-scope.mjs --scope @yourscope
```

which rewrites every package name and every import in docs and doc comments,
and `node scripts/set-scope.mjs --check` runs in CI so a hand-edited package
name can't drift from the declaration.

## 2. The registry — GitHub Packages

**Status:** both the scope and the registry (`https://npm.pkg.github.com`) are
declared together in [`package-scope.json`](../package-scope.json) — one file,
one source of truth for both.

The trade-off, accepted deliberately rather than defaulted into:

- Installing needs a GitHub personal access token with `read:packages` — a
  GitHub Packages platform behavior that applies to every registry read
  regardless of visibility, not a permissions choice made here. Package
  visibility is a separate, per-package decision (see
  [docs/PUBLISHING.md](PUBLISHING.md#package-visibility)), not a consequence
  of the registry choice itself.
- Public npmjs would make "anyone can install this, no token required"
  literally true. It was planned, worked on, and then **cancelled** — see
  [issue #213](https://github.com/vespeneventures/foundry/issues/213), which
  supersedes the migration issue (#194) and the credentialless acceptance
  criteria in its umbrella program (#196). Both are closed as not planned.

  GitHub Packages is therefore the canonical adoption lane, not a staging
  step on the way somewhere else. Consumers authenticate through whichever
  plane owns their package credentials.

  The reasoning, since "we changed our mind" is not a reason: the first
  step of that migration was verifying and, if unclaimed, **claiming
  `@vespeneventures` on npmjs** — a first-come registration on a shared
  public namespace, with no supported way to return a name to unclaimed and
  no recourse for a dispute except npm support. Every later step was
  recoverable; that one was not. What it bought was credential-free install
  for a reader with no relationship to this org, and no such reader was
  waiting: every actual consumer already authenticates through a plane that
  holds package credentials. Paying an irreversible cost for a hypothetical
  adopter is exactly the trade this repository's own conventions tell it not
  to make — see `CONTRIBUTING.md`'s "Supported configurations: the default
  answer is also no."

  This is recorded rather than deleted because the question recurs. A reader
  who notices the token requirement will wonder whether it is an oversight;
  it is not, and the answer should be one link away rather than a
  rediscovery. The bar to revisit is the same one any speculative capability
  faces here: a real consumer that needs it, not one that might.

- Each consuming plane owns its scope mapping, token reference, and local or CI
  injection. Foundry documents the protocol but never stores consumer
  credentials or account-specific installation manifests.
- Publishing remains a separate protected lane. The workflow uses its
  job-scoped `GITHUB_TOKEN` for uploads and a read-only package-index
  credential for the owner-wide collision query; a consumer read credential
  is not a publish credential.
- Existing GitHub Packages names and versions remain published. They are not
  deleted, yanked, copied to a second registry, or reused for a different
  package.

### A standing property of that registry: optional peers install as required

**Status:** documented, not worked around. [Issue #226](https://github.com/vespeneventures/foundry/issues/226)
confirmed, with a control query, that the GitHub Packages packument omits
`peerDependenciesMeta` for every version it serves — `peerDependencies`
comes back complete, `peerDependenciesMeta` comes back empty, from the same
authenticated request. The tarball's own `package.json` is correct; the loss
happens when GitHub Packages assembles the metadata document an installer
actually reads, before any tarball is fetched.

This was always possible the moment #213 (above) made GitHub Packages the
canonical, non-transitional registry: it is a property of *this* registry,
not of publishing from this repository in general, and choosing this
registry means living with what it does and doesn't serve. While the
registry question was still open, a gap like this would have been a reason
to keep looking; settled, it is a consequence to record next to the choice
that produced it, not a reason to revisit #213 itself.

Six packages currently express optionality through `peerDependenciesMeta` —
`ui`, `auth`, `surface`, `consent`, `comms`, and `governance` — and all six
are affected identically: every consumer installing from this registry gets
every declared peer as a hard requirement, regardless of which subpath it
actually imports. The declarations themselves are not changing. They are
correct in the tarball, they are what a reader of the package's own
`package.json` sees, and they become correct for installers too the day
GitHub Packages starts serving the field. What changed instead is the
documentation: each affected package's README now states its own effective
install behaviour on this registry, and [docs/ADOPTION.md](ADOPTION.md)
records it where adoption expectations are set. See issue #226 for the full
evidence, the options considered, and why splitting packages or moving
peers into `dependencies` were not taken.

### Why the name-collision gate runs before every publish, unconditionally

GitHub Packages namespaces npm packages by **owner account**, not by
repository. Publishing a name an account already owns under a *different*
repository does not fail — it silently appends a version to that existing
package and moves its `latest` dist-tag. The failure is silent at publish
time, which is exactly the kind of mistake that's cheap to prevent and
expensive to notice after the fact.

Foundry is the only repository under this owner authorized to publish packages,
but non-publishing account-control-plane repositories may coexist.
`scripts/check-name-collision.mjs` still runs before every publish because a
gate that only runs when someone remembers it is "probably fine" is not a gate.
See `docs/PUBLISHING.md` for what it checks and why it is ordered first.

## 3. The GitHub organization — a new, dedicated org

**Status:** `vespeneventures`, the owner of Foundry's packages and public
neutral producer. Private, non-publishing account-control-plane repositories
may coexist under the same owner.

Every published package carries `repository`, `bugs`, and `homepage` URLs
pointing at its own repository, so the org name is unavoidably public
metadata — this is the org a reader is meant to see. The denylist for this
repository (see `SECURITY.md`) has no rule that matches this org's own name,
so no neutralize/exception entry is needed for it to describe itself.

## 4. Deleting the `contract` metadata schema

**Status:** removed. `@vespeneventures/contract` and the `contract` block
it defined — previously required in every package's `package.json` — no
longer exist in this repository.

`contract` asked every package to self-report six fields in a block inside
its own `package.json`, and validated that block's shape. An audit found
that all six fields were mechanically derivable from data already present
in the same `package.json`: the real `dependencies` and `peerDependencies`
fields, the package's own directory, its own name. The block was applied to
144 packages by a script that made zero judgment calls — it filled in the
same six fields the same mechanical way everywhere — and across all 144
packages, `contract`'s own validation produced zero findings.

Zero findings from 144 mechanically-generated blocks is not evidence the
packages were sound. It is evidence the check was validating its own
output. A gate that is satisfied by deriving its answers from the exact
thing it is checking is a tautology — it can never fail, and a check that
can never fail is not a check.

The fix was not a stricter schema. It was deleting the schema and computing
every one of its questions from data that was always real: whether a
package's dependency actually resolves is now answered by reading its own
`dependencies`/`peerDependencies`, not a separately-maintained declaration
of the same fact. `@vespeneventures/catalog` answers exactly that question,
from exactly that data — see its README. Every package remaining in this
repository shares the same thesis: a check runs against what is actually on
disk or actually installed, never against what a manifest claims about
itself.

A previously-published version, `@vespeneventures/contract@0.1.0`, still
exists on the registry — see [docs/PUBLISHING.md](PUBLISHING.md) for why a
published name can never be reused, deleted from the tree or not.

## 5. Deleting `web-charts` and `web-storage`

**Status:** removed. Both packages previously published from this
repository have been deleted from the tree.

They are removed for now, not retired as a judgment about their design —
they may be recreated later. Their removal is a scope decision, not a
finding about the mechanism the remaining four packages exist to enforce.

---

## 6. Retiring `domain-model`

**Status:** retired from the registry after the supported consumers migrated
to `@vespeneventures/domain@0.2.0`.

The original package name was retained temporarily only as a compatibility
re-export. It has now been removed from this repository and the registry; it
is not republished. The lifecycle record retains the replacement and migration
evidence so historical package state remains auditable without leaving an
installable compatibility surface.

---

## 7. Consolidating `tokens` and `voice`

**Status:** `@vespeneventures/tokens` and `@vespeneventures/voice` are
deprecated registry artifacts. Their source packages were consolidated into
`@vespeneventures/ui` and `@vespeneventures/copy`, respectively, on
2026-08-11.

The former packages remain published while consumers migrate, because a
registry release cannot be safely erased from the history an installer may
already resolve. New work uses the replacement packages and their focused
subpaths: `@vespeneventures/ui` for tokens and styles, and
`@vespeneventures/copy` or `@vespeneventures/copy/voice` for the voice
contract. The consumer migration checklist in
[docs/PIPELINE.md](PIPELINE.md#consumer-integration-checklist) is the durable
handoff; no compatibility re-export is retained in this workspace.

---

## 8. Consolidating package-process surfaces under `governance`

**Status:** the supported package-process surface is
`@vespeneventures/governance@^0.2.0`. Its `./catalog`, `./gates`,
`./release`, `./repository`, and `./review` subpaths own the corresponding
public contracts and CLIs.

`@vespeneventures/catalog`, `@vespeneventures/gates`,
`@vespeneventures/release`, `@vespeneventures/repository`, and
`@vespeneventures/review` remain as deprecated compatibility packages while
consumers migrate. They preserve their existing root imports, the review
GitHub subpath, and the `foundry-check`, `repository-check`, and
`review-check` command names by delegating to the matching governance
subpath. They are registry migration artifacts, not additional supported
package choices.

This keeps package lifecycle, discovery, gates, release proof, repository
profiles, and review evidence in one package-process ownership boundary while
preserving installed-consumer compatibility. The legacy names must not be
unpublished or reused; their retirement requires the documented consumer
migration and later lifecycle evidence.

---

## 9. Recutting the workspace surface into six job-shaped packages

**Status:** the supported workspace-facing surface is six packages, each named
for the human job it would otherwise be: `controller`, `inspector`, `builder`,
`locksmith`, `integrator`, and `observer`. The product-facing tier — `auth`,
`comms`, `consent`, `copy`, `domain`, `ledger`, `strategy`, `surface`, `ui` —
is unchanged by this decision.

This supersedes decision 8 in one direction only: `governance` remains the
package-process authority, but it is renamed and merged into `controller`, and
the five compatibility packages that decision preserved are retired rather than
carried forward again.

### Why a job, and not a thing

A package named for a thing has no natural metric, so nothing ever says whether
it is working. A package named for a job has one by construction. Each of the
six states its metric in its own README, and each judges in at least three
states so that "could not evaluate" can never be reported as "fine".

### The three failures this cut is derived from

Each is measurable in this repository's own history, not argued from taste.

**One job with no owner.** Secret handling was split across three packages —
resolution contracts, scanning, and environment state — with the reconciling
half belonging to nobody. Nothing in the catalogue rotated a key. `locksmith`
exists because a five-package cut was tested and would have split key custody
back across integration and environment state, reproducing this deliberately.

**One job with several names.** `catalog`, `gates`, `release`, `repository` and
`review` are five published names for one concern, all five deprecated shims
re-exporting subpaths of a sixth, all five with zero consumers, and nothing in
the catalogue ever reported the situation. Decision 8 created them for a real
reason — installed-consumer compatibility during a rename — and that reason
expired without anything noticing.

**A measurer that is also the measured.** `observer` is deliberately separate
from `inspector` and must never import it. Gate efficacy computed by the gate
is the system grading its own homework, which is the failure that produced a
gate printing an incomplete verdict and exiting `0`.

### On retiring the compatibility packages

The five names must not be unpublished or reused. Their published versions stay
resolvable, so a consumer pinned to one keeps working; they are deprecated with
a replacement pointer rather than deleted from the registry.

The same applies to the names this recut renames — `secrets`, `provisioning`,
`deployment`, `verify-standards`, `secret-scan`, `governance`, `conventions`
and `policy`. Each keeps its published versions and gains a lifecycle entry
naming its replacement. A rename that strands an installed consumer with no
recorded path forward is the same defect as a fix that cannot travel.

### What is deliberately recorded as unresolved

`controller` is the largest merge here and the likeliest to need re-splitting:
it unifies two mature packages whose metrics genuinely differ — whether a
verdict is well-formed, versus whether a name conforms — on the claim that both
are rules. The seam is recorded now so that a future split is a decision rather
than a discovery.

`observer` collides with an established pattern name in this ecosystem. The
collision was raised, weighed and accepted, because within this catalogue the
register is human jobs and every sibling name reads that way.

### What resolves where

This is a rename and a merge, not a rewrite — no export, argument shape, or
return type changed. Every subpath previously reachable under the absorbed
names resolves, unchanged in shape, under its new package:

- `governance` becomes the `controller` root plus `./catalog`, `./gates`,
  `./release`, `./repository`, `./review`, `./review/github`, `./artifacts`,
  `./cleanup`, and `./composition`
- `conventions` becomes `./conventions`, `./conventions/documents/*`, and
  `./conventions/adapters/*`
- `policy` becomes `./policy`
- `secrets` becomes the `locksmith` root, alongside the four verbs it lacked
- `provisioning` becomes the `builder` root; `deployment` becomes
  `./deployment`
- `verify-standards` becomes the `inspector` root; `secret-scan` becomes
  `./secret-scan`

### No forwarding stubs

An intermediate version of this recut kept `governance` and `policy` as thin
published stubs forwarding to the matching `controller` subpath, because seven
packages in this workspace still imported them directly. Five of those seven
were the compatibility packages retired above; the remaining two — `ledger` and
the package that became `inspector` — were repointed at `controller` instead.

With no in-workspace consumer left, a stub would be kept only for its own sake,
and that is precisely the debt this decision exists to remove: decision 8
created five such stubs for a real reason, the reason expired, and nothing
noticed for months. The published versions of every absorbed name stay
resolvable on the registry and carry a deprecation record naming their
replacement, which is what actually protects an installed consumer. A source
stub protects nobody who is not already served by that.


---

## 10. Recutting the expression surface into role-shaped packages

Decision 9 recut the workspace's operation surface into six job-shaped
packages. This is the same cut applied to the expression surface, and it rests
on the same rule stated more precisely:

> If the name is a thing rather than a doer, it is an artifact — and an
> artifact belongs inside a role.

`strategy`, `copy`, `ui`, `surface` and `ledger` are all things. None of them
names who is accountable for anything, so none of them can be asked a question
it alone must answer. Four roles can:

| role | from | the question only it answers |
| --- | --- | --- |
| `strategist` | `strategy` | Is it true, and is it us? |
| `writer` | `copy` | Is it well said? |
| `designer` | `ui` | Is it well made? |
| `publisher` | `surface` + `ledger` | Did we put it out to an audience, and can we prove what shipped? |

### Why four and not five

`publisher` is one package, not two. Composition without a record is
unprovable, and every time the publisher runs, the record runs — there is no
publish that legitimately skips it. That argues for one install and one
version, which one package with a `./record` subpath delivers.

The measurement that argued for two is accommodated rather than overturned:
the record shares no code with the composer and does not import it, so the two
import surfaces stay genuinely separate under one version. Fusing the
*packaging* was never the same as fusing the *dependency graph*, and only the
second would have cost anything.

### What is renamed, and what deliberately is not

The package is named for the job. The vocabulary inside it is not touched.
`strategist` keeps `readStrategy`, `StrategyBundle` and a `strategy-dir`
argument, because a role owns artifacts and renaming the role does not rename
what it reasons about. A sweep that renamed the vocabulary too would have made
the diff unreviewable while changing no behaviour.

### No forwarding stubs

Same conclusion as decision 9, for a reason that is decisive rather than
stylistic. Each donor is deprecated-and-retained: still installable for a
consumer already pinned to it, declared in
`docs/contracts/package-retention.json` with a reason and a `reviewBy`, and
carrying `forwardsToReplacement: false`.

A stub would keep the old name importable. A supersession check could then
never reach zero, so the forwarding layer would defeat the very gate built to
prove the swap completed. A gate that cannot reach its own satisfied state is
decorative.

### What this decision does not do

It does not migrate any consumer. Publishing a role-named package and
deprecating its donor changes nothing in a consuming repository until that
repository chooses to move. Adoption is separate, later, and sequenced against
one constraint learned from the operation lane: **publish first, entitle
second.** A consumer that entitles a role name before it is published, and
whose entitled set is mostly renamed packages, gets a confident
`unauthenticated` verdict — a credential diagnosis for what is really "not
published yet".

---

## 11. A gate behind a `bin`, or a declared primitive

**Status:** the rule below governs every package in `packages/`. It is declared
in [`docs/contracts/package-programs.json`](contracts/package-programs.json) —
the primitive tier is the `foundation` programme, marked `"tier": "primitive"`,
with `domain` as its first member — and graded by
`scripts/check-package-programs.mjs`, which already owned every package's
programme membership and lifecycle state. Program C's four roles are named and
their questions fixed here; all four are now published, and this decision
creates no package.

Decisions 9 and 10 wrote down half of what every package here is actually held
to: it names a doer rather than a thing, and answers one question only it can
answer. The other half was never written down and is near-universal in the code
anyway — a role package ships a gate behind a `bin`, so a consumer's own CI can
fail on it. The retained donors `auth`, `comms` and `consent` do not; their
Program C replacements own the gates. `domain` does not, because the current
contract declares it a primitive. From outside the tree those two situations
are the same thing: an absent `bin`.

> A package either belongs to a program — in which case it names a doer,
> answers one question only it answers, and ships a gate behind a `bin` — or it
> belongs to the primitive tier, in which case it declares that it ships none,
> and why.

This turns "no `bin`" from an absence into a decision, which is the principle
[`docs/contracts/package-retention.json`](contracts/package-retention.json)
already states in the other direction: "a standing exemption with no expiry is
the same failure as an absence with no declared reason, just wearing the other
sign."

### The programs, and who each addresses

A program is identified by its addressee, not by its subject matter. Three are
cut; a fourth is named so its absence is a decision rather than an oversight.

| program | addresses | packages |
| --- | --- | --- |
| operation | a repository | `controller`, `inspector`, `builder`, `locksmith`, `integrator`, `observer` (decision 9) |
| expression | an audience | `strategist`, `writer`, `designer`, `publisher` (decision 10) |
| interaction | one person | `bouncer`, `butler`, `giver`, `keeper` (issue #458) |
| transaction | an organisation under agreement | not cut, and nothing here waits on it |

### The primitive tier

A primitive has no addressee. With no addressee there is no role, with no role
there is no question only it answers, and with no such question there is
nothing for a gate to judge. `domain` is the first declared member: it defines
identifiers, typed fields, closed vocabularies and relations, and ships no
values, storage, authorization, provenance or lifecycle of its own. What a
`domain` gate would check is the consumer's model, and whether that model is
right is the consumer's judgment, not this package's.

Membership is declared, never inferred from a missing `bin`, and the two kinds
of declaration are deliberately not interchangeable. A primitive declares
`shipsNoGate` with `permanent: true`: there is no work to track. `auth` and
`consent` now declare the same field with their retirement issue because they
are deprecated donors whose Program C replacements own the gates. `comms`
remains a donor with an issue while its split is unresolved. These countdowns
remain distinct from a permanent primitive claim, and the gate refuses a
permanent claim from a package that belongs to a programme.

### Program C's four roles

| role | everything about | the question only it answers |
| --- | --- | --- |
| `bouncer` | who you are, what you can do, how that changes | Is this actor who they claim, and is this inside what they were granted? |
| `butler` | what you want — now, and standing | Do we have what this person wants, in their own confirmation, and still current? |
| `giver` | what you get — asked for, and owed | Did they get what they asked for, a reason, or a human — and everything owed, on time? |
| `keeper` | what you gave us, and what we understand from it | Does everything we hold trace to something they did, and can they see and correct it? |

Order is the request path: `bouncer`, then `butler`, then `giver`, with
`keeper` read throughout.

### The failure this rule is derived from

Measurable in this repository, not argued from taste.
`packages/comms/src/dispatcher.ts` reads:

```ts
const policy = (await config.policy?.(message)) ?? { outcome: "allow" as const };
```

`policy` is optional, so a host that never wires one dispatches everything to
everyone and nothing reports a fault. Its sibling donor argues against exactly
this shape in its own README — "silently treats absence of a signal as a
passing one" — and ships a three-state model to refuse it. The two donors
contradict each other in the tree, and no first-party code joins them.

What kept the contradiction invisible is the missing `bin`. Every package with
a gate is one invocation away from having a defect of this class surface in a
consumer's CI; these three are the only non-primitive packages here that no
consumer can check at all. The rule exists so that the next package in that
position has to say so.

### What is deliberately left unresolved

The rule requires a gate, and says nothing about how many, or what each must
judge. Decision 9's standing bar — judge in at least three states, so "could
not evaluate" can never be reported as "fine" — is unchanged and not raised
here. Nor does shipping a `bin` mean the gate works: that is what
[docs/LIFECYCLE.md](LIFECYCLE.md)'s `staged` state asks, and this rule is
deliberately the weaker, earlier question of whether a consumer could run
anything at all.

The primitive tier has exactly one declared member, which is too few to know
whether it is a tier or a special case wearing a general name. It is recorded
as a tier because the alternative, an exemption field on `domain` alone, is the
standing exemption with no expiry that the retention contract already refuses.

Where a message-transport and contact-coordinate substrate belongs is also
open. It carries messages and identities and decides nothing about what either
means, so it answers to no addressee and fails every program's test, including
interaction's. That is recorded as unowned rather than defaulted into the
nearest program.

### Why this rule has no contract file of its own

It nearly got one. This decision was first written with its own
`package-tier.json` and its own checker, in parallel with
`package-programs.json` and `check-package-programs.mjs` — two files and two
gates for one concern, which is precisely the failure decision 9 is derived
from: five published names for one job, and nothing reporting the situation.
The parallel pair was deleted rather than reconciled later, and the rule was
folded into the contract that already knew each package's programme, donors and
lifecycle state. A rule that needs a second copy of that data to be checked is a
rule that belongs next to the first copy.

## Settled

**Author attribution — keep a real name in the `"author"` field.** A real
author name is conventional in open source, and the MIT licence requires a
named copyright holder to be a valid grant. The gate's `neutralize` list is
path-scoped to `package.json`, where that field actually lives — this
document deliberately does not repeat the literal value, since a doc file is
not one of the neutralized paths and would fail the same gate it describes.
