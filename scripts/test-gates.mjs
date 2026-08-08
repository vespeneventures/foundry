#!/usr/bin/env node
// test-gates — regression tests for the publish-safety gates themselves.
//
//   node scripts/test-gates.mjs [--verbose]
//
// Exit 0 = every gate behaves as specified. Exit 1 = a gate regressed.
//
// WHY THIS EXISTS
// ---------------
// The gates are the only thing standing between an unreviewed working tree and an
// irreversible public disclosure, and until now they had no tests at all. A
// gate with no tests is a gate that rots silently: every rule here is one
// refactor away from matching nothing and still exiting 0, which looks
// identical to "clean" from CI.
//
// Each case below is a NEGATIVE test — it plants something that must be caught
// and asserts the gate catches it. A gate that passes its own positive case
// proves very little; a gate that fails to catch planted contamination is the
// only failure mode that matters.
//
// Fixtures are built in a temp directory and torn down. Nothing here writes to
// the repository, and no fixture contains a real credential — the secret-shaped
// strings are structurally valid but issued by no one.
//
// Cases marked KNOWN-GAP document behaviour that is currently wrong. They assert
// the CURRENT behaviour so the suite stays green, and they name what should
// change. Deleting a KNOWN-GAP case without fixing the underlying rule is how a
// known hole becomes an unknown one.

import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, cpSync, existsSync, chmodSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..");
const verbose = process.argv.includes("--verbose");

// Fixture packages are named under a scope that appears in no denylist term, so
// a fixture's own name can never be the thing a case trips over. The collision
// gate is the one exception — it must use the real scope, because it is
// specifically checking names under the real registry owner.
const FIXTURE_SCOPE = "@gate-fixture";

// This suite runs against a SYNTHETIC denylist, never the real one.
//
// Two reasons, and the second is the load-bearing one:
//   1. Hermetic. The tests assert the gate's MECHANISM — that an identity term
//      matches, that neutralize confines to its paths — which needs some terms,
//      not the real terms. Real terms would make these tests fail whenever the
//      denylist is edited for unrelated reasons.
//   2. This file lives in a public repository and is scanned by the very gate
//      it tests. Hardcoding real denylist terms as fixtures would commit, in
//      plaintext, exactly the strings the denylist exists to keep out — the
//      same reason the real denylist is not in this repo. (Caught the honest
//      way: an earlier draft of this file did precisely that and the gate
//      rejected it.)
//
// Properties of the REAL denylist are checked separately by
// check-denylist-quality.mjs, which reads it without ever echoing a term.
const SYNTH_DENYLIST = {
  version: "synthetic-test",
  terms: [
    { pattern: "acme-corp", why: "synthetic sibling product", severity: "high" },
    { pattern: "zeta\\.example", why: "synthetic product domain", severity: "high" },
    { pattern: "quux(-|\\.| )corp", why: "synthetic separated name", severity: "medium" },
  ],
  neutralize: [
    { pattern: "@gate-fixture/acme-corp-allowed", paths: ["allowed.md"] },
  ],
};

const SAFETY = join(scriptDir, "check-public-safety.mjs");
const ARTIFACT = join(scriptDir, "check-artifact-safety.mjs");
const COLLISION = join(scriptDir, "check-name-collision.mjs");
const CONTAM = join(scriptDir, "check-contamination-classes.mjs");
const QUALITY = join(scriptDir, "check-denylist-quality.mjs");
const SET_SCOPE = join(scriptDir, "set-scope.mjs");
const ROOT_README = join(scriptDir, "check-root-readme-parity.mjs");
const TYPECHECKED = join(scriptDir, "check-typechecked-assertions.mjs");
const COMMIT_MESSAGES = join(scriptDir, "check-commit-messages.mjs");

let passed = 0;
let skipped = 0;
const failures = [];

function run(cmd, args, opts = {}) {
  try {
    const stdout = execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
    return { code: 0, out: stdout };
  } catch (error) {
    return { code: error.status ?? 1, out: (error.stdout ?? "") + (error.stderr ?? "") };
  }
}

function check(name, condition, detail) {
  if (condition) {
    passed++;
    if (verbose) console.log(`  ok   ${name}`);
  } else {
    failures.push({ name, detail });
    console.log(`  FAIL ${name}\n         ${detail}`);
  }
}

function gitInit(dir) {
  run("git", ["-C", dir, "init", "-q"]);
  run("git", ["-C", dir, "add", "-A"]);
  run("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "fixture"]);
}

const work = mkdtempSync(join(tmpdir(), "gate-tests-"));
const synthPath = join(work, "synth-denylist.json");
writeFileSync(synthPath, JSON.stringify(SYNTH_DENYLIST, null, 2));
// Every gate invocation in this suite uses the synthetic list.
const DL = ["--denylist", synthPath];

try {
  // ---------------------------------------------------------------- secrets
  console.log("\n# credential-shaped strings");
  {
    const dir = join(work, "secrets");
    mkdirSync(dir, { recursive: true });
    // Structurally valid, issued by nobody — and assembled from fragments at
    // run time so that no complete credential-shaped string is ever a literal in
    // this file. Written out whole, each of these would (correctly) trip the
    // gate on the gate's own test suite.
    const planted = [
      ["anthropic", "sk-" + "ant-" + "A".repeat(24)],
      ["openai", "sk" + "-" + "B".repeat(28)],
      ["github-pat", "ghp" + "_" + "C".repeat(28)],
      ["aws", "AKI" + "A" + "D".repeat(16)],
      ["stripe-live", "sk_" + "live_" + "E".repeat(16)],
      ["slack", "xox" + "b-" + "1".repeat(16)],
      ["db-url", "postgre" + "s://u:p@h:5432/d"],
      ["private-key", "-----BEGIN " + "RSA PRIVATE KEY" + "-----"],
    ];
    for (const [label, value] of planted) {
      writeFileSync(join(dir, `${label}.js`), `const x = ${JSON.stringify(value)};\n`);
    }
    gitInit(dir);
    const r = run("node", [SAFETY, dir, ...DL, "--require-denylist", "--json"]);
    let report;
    try { report = JSON.parse(r.out); } catch { report = { failures: [] }; }
    for (const [label] of planted) {
      const hit = (report.failures ?? []).some((f) => f.kind === "SECRET" && f.rel === `${label}.js`);
      check(`catches ${label}`, hit, `no SECRET finding for ${label}.js`);
    }
    const leaked = (report.failures ?? []).some((f) => f.kind === "SECRET" && f.text && f.text !== "<redacted>");
    check("never echoes a matched secret", !leaked, "a SECRET finding carried the raw matching line");
  }

  // -------------------------------------------------------- forbidden files
  console.log("\n# forbidden files");
  {
    const dir = join(work, "forbidden");
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(join(dir, ".claude", "settings.json"), "{}\n");
    writeFileSync(join(dir, "CLAUDE.md"), "# internal\n");
    writeFileSync(join(dir, ".env"), "TOKEN=x\n");
    writeFileSync(join(dir, ".npmrc"), "//r/:_authToken=x\n");
    writeFileSync(join(dir, "CONSUMPTION.json"), "{}\n");
    gitInit(dir);
    // .gitignore is absent so nothing is skipped as ignored.
    const r = run("node", [SAFETY, dir, ...DL, "--require-denylist", "--json"]);
    let report;
    try { report = JSON.parse(r.out); } catch { report = { failures: [] }; }
    for (const f of [".claude/settings.json", "CLAUDE.md", ".env", ".npmrc", "CONSUMPTION.json"]) {
      const hit = (report.failures ?? []).some((x) => x.kind === "forbidden-file" && x.rel === f);
      check(`refuses ${f}`, hit, `no forbidden-file finding for ${f}`);
    }
  }

  // ------------------------------------------------------------ fail-closed
  console.log("\n# fail-closed behaviour");
  {
    const dir = join(work, "failclosed");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "a.md"), "clean\n");
    gitInit(dir);

    const missing = run("node", [SAFETY, dir, "--require-denylist", "--denylist", "/nonexistent/dl.json"]);
    check("--require-denylist exits 2 when the denylist is missing", missing.code === 2, `exit was ${missing.code}`);

    const partial = run("node", [SAFETY, dir, "--denylist", "/nonexistent/dl.json"]);
    check("PARTIAL mode exits 0 but never claims a bare PASS", partial.code === 0 && /PASS \(partial\)/.test(partial.out), "expected an explicitly-partial PASS");
    check("PARTIAL mode prints a visible banner", /PARTIAL SCAN/.test(partial.out), "no PARTIAL SCAN banner");
    check("PARTIAL mode says a pass is not a clearance", /does NOT clear/i.test(partial.out), "banner did not disclaim clearance");
  }

  // ------------------------------- check-contamination-classes: fail-closed
  console.log("\n# check-contamination-classes: fail-closed walker");
  {
    const dir = join(work, "contam-failclosed");
    const clean = join(dir, "clean");
    const blocked = join(dir, "blocked");
    mkdirSync(clean, { recursive: true });
    mkdirSync(blocked, { recursive: true });
    writeFileSync(join(clean, "note.md"), "nothing to see here\n");
    writeFileSync(join(blocked, "note.md"), "nothing to see here\n");

    // Sanity anchor: a genuinely clean, fully-readable tree still passes,
    // so the two checks below actually pin the unreadable-directory case
    // and not some unrelated breakage.
    const okRun = run("node", [CONTAM, clean]);
    check("passes a clean, fully-readable directory", okRun.code === 0, `exit was ${okRun.code}: ${okRun.out.slice(0, 200)}`);

    // Make one subdirectory unreadable to reproduce the walk error the gate
    // must fail closed on (a permission error, a broken symlink loop, or any
    // other readdir failure are all the same shape: readdirSync throws).
    chmodSync(blocked, 0o000);
    let reallyBlocked = true;
    try {
      readdirSync(blocked);
      reallyBlocked = false; // e.g. running as root, which ignores the mode bits
    } catch {
      // expected — confirms the fixture actually reproduces an unreadable dir
    }

    try {
      if (reallyBlocked) {
        const r = run("node", [CONTAM, dir]);
        check("aborts (does not exit 0/1) when a directory cannot be read", r.code === 2, `exit was ${r.code}`);
        check("never reports a bare PASS over an unreadable directory", !/PASS/.test(r.out), "gate printed PASS while a directory could not be read");
        check("names the unreadable directory in its error output", r.out.includes(blocked), "no mention of the unreadable path in the error output");
      } else {
        console.log("  skip (running with privileges that bypass directory permissions — cannot reproduce EACCES)");
      }
    } finally {
      // Restore permissions before the outer temp-dir cleanup, which needs to
      // read and delete this directory too.
      chmodSync(blocked, 0o755);
    }
  }

  // --------------------------------------------------- the dist/ blind spot
  console.log("\n# the dist/ blind spot (tree mode vs artifact mode)");
  {
    const dir = join(work, "distblind");
    mkdirSync(join(dir, "packages", "probe"), { recursive: true });
    const pkgDir = join(dir, "packages", "probe");
    cpSync(join(repoRoot, "package-scope.json"), join(dir, "package-scope.json"));
    const scope = JSON.parse(execFileSync("cat", [join(repoRoot, "package-scope.json")], { encoding: "utf8" }));
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify(
        {
          // A neutral, non-denylisted scope on purpose: naming the fixture under
          // the real scope would trip the identity rule (correctly — only the two
          // sanctioned package names are neutralized) and mask what this case tests.
          name: `${FIXTURE_SCOPE}/gate-test-probe`,
          version: "1.0.0",
          private: false,
          license: "MIT",
          type: "module",
          main: "./dist/index.js",
          files: ["dist", "src", "README.md", "LICENSE"],
          publishConfig: { registry: scope.registry },
        },
        null,
        2,
      ) + "\n",
    );
    writeFileSync(join(pkgDir, "README.md"), "# probe\n");
    writeFileSync(join(pkgDir, "LICENSE"), "MIT\n");
    mkdirSync(join(pkgDir, "src"), { recursive: true });
    writeFileSync(join(pkgDir, "src", "index.ts"), "export const x = 1;\n");
    mkdirSync(join(pkgDir, "dist"), { recursive: true });
    // Contamination ONLY in build output — never in src, never in a tracked
    // file. The term is synthetic (see SYNTH_DENYLIST), so this file contains
    // no real denylisted string.
    writeFileSync(join(pkgDir, "dist", "index.js"), `export const x = 1;\n// see the acme-corp design system\n`);
    writeFileSync(join(dir, ".gitignore"), "node_modules/\ndist/\n");
    gitInit(dir);

    const tree = run("node", [SAFETY, dir, ...DL, "--require-denylist", "--allow-changelogs"]);
    check(
      "tree mode is BLIND to gitignored dist/ (documents why artifact mode exists)",
      tree.code === 0,
      `tree mode exited ${tree.code}; if this now fails, tree mode gained dist visibility — good, update this test`,
    );

    const artifact = run("node", [ARTIFACT, pkgDir, ...DL, "--require-denylist"]);
    check(
      "artifact mode CATCHES contamination that only exists in dist/",
      artifact.code === 1 && /identity/.test(artifact.out),
      `artifact mode exited ${artifact.code} without an identity finding — the blind spot is open again`,
    );
  }

  // ------------------------------------------------- artifact structure
  console.log("\n# artifact structural rules");
  {
    const dir = join(work, "structure");
    const pkgDir = join(dir, "packages", "probe");
    mkdirSync(join(pkgDir, "src"), { recursive: true });
    cpSync(join(repoRoot, "package-scope.json"), join(dir, "package-scope.json"));
    const scope = JSON.parse(execFileSync("cat", [join(repoRoot, "package-scope.json")], { encoding: "utf8" }));
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify(
        {
          name: `${FIXTURE_SCOPE}/gate-test-structure`,
          version: "1.0.0",
          private: false,
          license: "MIT",
          type: "module",
          // Deliberately wrong: ships tests, omits LICENSE, negates only .ts
          files: ["src", "README.md"],
          publishConfig: { registry: scope.registry },
        },
        null,
        2,
      ) + "\n",
    );
    writeFileSync(join(pkgDir, "README.md"), "# probe\n");
    writeFileSync(join(pkgDir, "src", "index.ts"), "export const x = 1;\n");
    writeFileSync(join(pkgDir, "src", "index.test.tsx"), "test('x', () => {});\n");
    gitInit(dir);

    const r = run("node", [ARTIFACT, pkgDir, ...DL, "--require-denylist"]);
    check("artifact mode flags a shipped test file", /test file shipped/.test(r.out), "no test-file finding");
    check("artifact mode flags a missing LICENSE", /LICENSE is absent/.test(r.out), "no missing-LICENSE finding");
    check("artifact mode fails overall on structural defects", r.code === 1, `exit was ${r.code}`);
  }

  // -------------------------------------------------------- collision gate
  console.log("\n# name-collision gate");
  {
    const dir = join(work, "collision");
    mkdirSync(dir, { recursive: true });

    // Exercised entirely through --packages-json (see check-name-collision.mjs)
    // so these cases need no gh credential. Owner, repo, and package names are
    // all synthetic under FIXTURE_SCOPE — this pins the gate's decision LOGIC,
    // not any real registry state.
    //
    // "This repo" identity is injected via GITHUB_REPOSITORY, the same
    // env var the gate trusts in real CI, rather than via a real git remote —
    // that's what makes these cases hermetic. This also means every case here
    // exercises the trust boundary directly: the gate is handed "this repo"
    // from outside the fixture package entirely, so a fixture package.json is
    // free to claim whatever repository.url it likes without affecting the
    // verdict — which is precisely the property under test.
    const thisRepo = "gate-fixture-owner/gate-fixture-repo";
    const asThisRepo = (opts = {}) => ({ ...opts, env: { ...process.env, GITHUB_REPOSITORY: thisRepo } });

    // A name known to exist under this owner from a DIFFERENT repo —
    // reproduced with synthetic names, the exact shape of the collision this
    // gate exists to catch.
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify(
        {
          name: `${FIXTURE_SCOPE}/collided-name`,
          version: "1.0.0",
          private: false,
          repository: { type: "git", url: `git+https://github.com/${thisRepo}.git` },
        },
        null,
        2,
      ) + "\n",
    );
    const collidePackages = join(dir, "packages-collision.json");
    writeFileSync(
      collidePackages,
      JSON.stringify([
        { name: "collided-name", visibility: "public", repository: { full_name: "gate-fixture-owner/some-other-repo" } },
      ]),
    );
    const collide = run("node", [COLLISION, dir, "--packages-json", collidePackages], asThisRepo());
    check("detects a cross-repo name collision", collide.code === 1 && /COLLISION/.test(collide.out), `exit ${collide.code}`);

    // The candidate's OWN package.json repository.url is spoofed to claim the
    // identity of the repo that actually owns the pre-existing colliding
    // package. Trusting that field (the pre-fix behaviour) would make this
    // look like a same-repo version bump. "This repo" must come from
    // GITHUB_REPOSITORY / git remote instead, so the spoof has no effect and
    // the gate still reports a real collision. Regression for GH issue #7.
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify(
        {
          name: `${FIXTURE_SCOPE}/spoofed-name`,
          version: "1.0.0",
          private: false,
          repository: { type: "git", url: "git+https://github.com/gate-fixture-owner/some-other-repo.git" },
        },
        null,
        2,
      ) + "\n",
    );
    const spoofedPackages = join(dir, "packages-spoofed.json");
    writeFileSync(
      spoofedPackages,
      JSON.stringify([
        { name: "spoofed-name", visibility: "public", repository: { full_name: "gate-fixture-owner/some-other-repo" } },
      ]),
    );
    const spoofed = run("node", [COLLISION, dir, "--packages-json", spoofedPackages], asThisRepo());
    check(
      "a spoofed repository.url claiming the colliding package's real owner is still flagged as a collision",
      spoofed.code === 1 && /COLLISION/.test(spoofed.out),
      `exit ${spoofed.code}: ${spoofed.out.slice(0, 300)}`,
    );

    // Same bare name, but the existing package belongs to THIS repo -> a
    // version bump, not a collision.
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify(
        {
          name: `${FIXTURE_SCOPE}/bumped-name`,
          version: "1.0.0",
          private: false,
          repository: { type: "git", url: `git+https://github.com/${thisRepo}.git` },
        },
        null,
        2,
      ) + "\n",
    );
    const bumpPackages = join(dir, "packages-bump.json");
    writeFileSync(
      bumpPackages,
      JSON.stringify([{ name: "bumped-name", visibility: "public", repository: { full_name: thisRepo } }]),
    );
    const bump = run("node", [COLLISION, dir, "--packages-json", bumpPackages], asThisRepo());
    check("treats a same-repo match as a version bump", bump.code === 0, `exit ${bump.code}: ${bump.out.slice(0, 200)}`);

    // Unused name -> safe.
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify(
        {
          name: `${FIXTURE_SCOPE}/unused-name`,
          version: "1.0.0",
          private: false,
          repository: { type: "git", url: `git+https://github.com/${thisRepo}.git` },
        },
        null,
        2,
      ) + "\n",
    );
    const unusedPackages = join(dir, "packages-unused.json");
    writeFileSync(
      unusedPackages,
      JSON.stringify([
        { name: "some-other-package", visibility: "public", repository: { full_name: "gate-fixture-owner/some-other-repo" } },
      ]),
    );
    const safe = run("node", [COLLISION, dir, "--packages-json", unusedPackages], asThisRepo());
    check("passes a name unused under the owner", safe.code === 0, `exit ${safe.code}: ${safe.out.slice(0, 200)}`);

    // The owner's packages could not be listed (fixture: a bare JSON `null`,
    // the same shape the live `gh` path produces on failure) -> must not
    // report a pass.
    const nullPackages = join(dir, "packages-null.json");
    writeFileSync(nullPackages, "null");
    const unreachable = run("node", [COLLISION, dir, "--packages-json", nullPackages], asThisRepo());
    check("fails closed when the owner's packages cannot be listed", unreachable.code === 2, `exit ${unreachable.code}`);

    // Neither GITHUB_REPOSITORY nor a git remote is available -> must not
    // report a pass. `dir` here is a bare directory with no enclosing git
    // repo, so `git remote get-url origin` fails and there is nothing left
    // to fall back to.
    const noRepoEnv = { ...process.env };
    delete noRepoEnv.GITHUB_REPOSITORY;
    const noRepo = run("node", [COLLISION, dir, "--packages-json", unusedPackages], { env: noRepoEnv });
    check(
      "fails closed when this repository's own identity cannot be determined",
      noRepo.code === 2 && /cannot determine this repository/.test(noRepo.out),
      `exit ${noRepo.code}: ${noRepo.out.slice(0, 300)}`,
    );
  }

  // -------------------------------------------------- neutralize confinement
  console.log("\n# neutralize + paths confinement");
  {
    const dir = join(work, "neutralize");
    mkdirSync(dir, { recursive: true });
    // The neutralize entry is confined to allowed.md. The same string in any
    // other file must still fail, and a neutralized line must still be scanned
    // for whatever else is on it.
    writeFileSync(join(dir, "allowed.md"), "install @gate-fixture/acme-corp-allowed here\n");
    writeFileSync(join(dir, "elsewhere.md"), "install @gate-fixture/acme-corp-allowed here\n");
    writeFileSync(join(dir, "ridealong.md"), "@gate-fixture/acme-corp-allowed and also zeta.example\n");
    gitInit(dir);
    const r = run("node", [SAFETY, dir, ...DL, "--require-denylist", "--json"]);
    let report;
    try { report = JSON.parse(r.out); } catch { report = { failures: [] }; }
    const hitIn = (f) => (report.failures ?? []).some((x) => x.rel === f);
    check("neutralize applies inside its declared path", !hitIn("allowed.md"), "the allowed path was still flagged");
    check("neutralize does NOT leak to other paths", hitIn("elsewhere.md"), "the same string passed outside its declared path");
    check(
      "a neutralized line is still scanned for everything else on it",
      hitIn("ridealong.md"),
      "a second term riding along on a neutralized line was missed — neutralize is skipping whole lines",
    );
  }

  // ------------------------------------- separator-optional matching (shape)
  console.log("\n# identity pattern shape");
  {
    const dir = join(work, "shape");
    mkdirSync(dir, { recursive: true });
    // Documents a real gap class: a pattern that requires a separator between
    // name parts catches the separated forms and misses the bare compound —
    // which is how an identity appears as a handle, an npm scope, or a URL
    // slug. Asserted here with synthetic terms; check-denylist-quality.mjs
    // asserts the real denylist has no such pattern.
    writeFileSync(join(dir, "sep.md"), "name: quux-corp\n");
    writeFileSync(join(dir, "compound.md"), "handle: quuxcorp\n");
    gitInit(dir);
    const r = run("node", [SAFETY, dir, ...DL, "--require-denylist", "--json"]);
    let report;
    try { report = JSON.parse(r.out); } catch { report = { failures: [] }; }
    check("separator-required pattern catches the separated form", (report.failures ?? []).some((f) => f.rel === "sep.md"), "separated form missed");
    check(
      "separator-required pattern MISSES the compound form (why check-denylist-quality exists)",
      !(report.failures ?? []).some((f) => f.rel === "compound.md"),
      "compound form was caught — the synthetic fixture no longer models the gap; update it",
    );
  }

  // ------------------------------- denylist quality: neutralize breadth (issue #8)
  console.log("\n# denylist quality — neutralize breadth keys off `paths`, not pattern length");
  {
    // Synthetic denylist for check-denylist-quality.mjs, never the real one.
    // Three neutralize entries, all global (unconfined) except the last:
    //   #0 - unconfined, SHORT pattern -> must still be flagged (pre-existing case).
    //   #1 - unconfined, LONG-but-still-context-free pattern -> this is the exact
    //        gap from issue #8: a length-based heuristic let a long global entry
    //        pass with zero warning. Fixed, this must be flagged too.
    //   #2 - paths-confined, equally long pattern -> confinement bounds the blast
    //        radius, so this one must NOT be flagged for breadth.
    const qDir = join(work, "quality");
    mkdirSync(qDir, { recursive: true });
    const qualityDenylist = {
      version: "synthetic-quality-test",
      terms: [{ pattern: "widget-co", why: "synthetic sibling product", severity: "medium" }],
      neutralize: [
        { pattern: "acme-corp", why: "synthetic short unconfined entry" },
        { pattern: "acme-corp-widget-manufacturing-division", why: "synthetic long unconfined entry" },
        {
          pattern: "acme-corp-widget-manufacturing-division-confined",
          why: "synthetic long confined entry",
          paths: ["allowed.md"],
        },
      ],
    };
    const qualityPath = join(qDir, "quality-denylist.json");
    writeFileSync(qualityPath, JSON.stringify(qualityDenylist, null, 2));

    const r = run("node", [QUALITY, "--denylist", qualityPath, "--json"]);
    let report;
    try {
      report = JSON.parse(r.out);
    } catch {
      report = { findings: [] };
    }
    const breadthIndices = (report.findings ?? [])
      .filter((f) => f.rule === "neutralize-breadth")
      .map((f) => f.index)
      .sort();

    check(
      "flags a SHORT unconfined neutralize entry",
      breadthIndices.includes(0),
      `expected index 0 in neutralize-breadth findings, got ${JSON.stringify(breadthIndices)}`,
    );
    check(
      "flags a LONG-but-still-context-free unconfined neutralize entry (issue #8 regression)",
      breadthIndices.includes(1),
      `expected index 1 in neutralize-breadth findings — a long global pattern must not evade the heuristic, got ${JSON.stringify(breadthIndices)}`,
    );
    check(
      "does NOT flag a paths-confined entry for breadth, regardless of pattern length",
      !breadthIndices.includes(2),
      `paths-confined entry (index 2) was flagged for breadth — confinement should bound the blast radius`,
    );
    check("check-denylist-quality exits 1 when quality findings exist", r.code === 1, `exit was ${r.code}`);
  }

  // ====================================================================
  // GH issue #3: test-gates.mjs never exercised check-commit-messages.mjs
  // or check-readme-parity.mjs at all, so a regression in either shipped
  // silently. Kept as one block at the end so a concurrent edit anywhere
  // above only needs a trivial merge.
  // ====================================================================

  const READMEPARITY = join(scriptDir, "check-readme-parity.mjs");
  const COMMITMSG = join(scriptDir, "check-commit-messages.mjs");

  function gitCommit(dir, message) {
    run("git", ["-C", dir, "add", "-A"]);
    run("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", message]);
    return run("git", ["-C", dir, "rev-parse", "HEAD"]).out.trim();
  }

  // -------------------------------------------------- check-commit-messages
  console.log("\n# check-commit-messages: identity terms in commit message text");
  {
    const dir = join(work, "commit-messages");
    mkdirSync(dir, { recursive: true });
    run("git", ["-C", dir, "init", "-q"]);
    writeFileSync(join(dir, "seed.txt"), "seed\n");
    const hash0 = gitCommit(dir, "initial commit\n\nNothing interesting here.");

    writeFileSync(join(dir, "a.txt"), "a\n");
    const leaky = gitCommit(dir, "Refactor the widget\n\nAccidentally mentions acme-corp in the body.");

    // A GitHub squash-merge-shaped Co-authored-by trailer carrying the term
    // only inside the machine-generated attribution line — must NOT trip
    // the gate (see check-commit-messages.mjs's own reasoning for the one
    // narrow exemption it makes).
    writeFileSync(join(dir, "b.txt"), "b\n");
    const trailerOnly = gitCommit(
      dir,
      "Fix the sprocket\n\nCo-authored-by: acme-corp-bot <12345+acme-corp-bot@users.noreply.github.com>",
    );

    // The same identity term, hand-written, in a Co-authored-by-shaped line
    // that is NOT the exact GitHub noreply form — must still be caught. A
    // human typing an identity into a commit message is not exempt.
    writeFileSync(join(dir, "c.txt"), "c\n");
    const handWritten = gitCommit(
      dir,
      "Polish the gizmo\n\nCo-authored-by: A Contributor <person@acme-corp-real.example>",
    );

    writeFileSync(join(dir, "d.txt"), "d\n");
    const clean = gitCommit(dir, "Docs tweak, nothing sensitive here.");

    // Each case below scans a range holding exactly ONE commit (that
    // commit's own parent..itself), rather than one shared range covering
    // all four, so each detection case is asserted in isolation. (A
    // multi-commit range used to corrupt the printed hash for every commit
    // but the newest -- `git log --format=` appends its own newline
    // terminator after every entry but the last, which landed on the FRONT
    // of the next entry's hash once split on our embedded NUL byte. That's
    // fixed now; see the combined-range hash checks below.)
    const leakyRun = run("node", [COMMITMSG, `${hash0}..${leaky}`, ...DL, "--require-denylist"], { cwd: dir });
    check("flags a commit whose message body carries a denylisted term", leakyRun.code === 1, `exit was ${leakyRun.code}: ${leakyRun.out.slice(0, 200)}`);
    check(
      `names the offending commit (${leaky.slice(0, 12)}) in the finding`,
      leakyRun.out.includes(leaky.slice(0, 12)),
      `no finding for the leaky commit: ${leakyRun.out.slice(0, 200)}`,
    );

    const trailerRun = run("node", [COMMITMSG, `${leaky}..${trailerOnly}`, ...DL, "--require-denylist"], { cwd: dir });
    check(
      "does NOT flag a commit whose only occurrence is inside a GitHub Co-authored-by trailer",
      trailerRun.code === 0,
      `the trailer-exempt commit was flagged — the exemption regressed. exit ${trailerRun.code}: ${trailerRun.out.slice(0, 200)}`,
    );

    const handWrittenRun = run("node", [COMMITMSG, `${trailerOnly}..${handWritten}`, ...DL, "--require-denylist"], { cwd: dir });
    check(
      "flags a hand-written Co-authored-by line with a real domain",
      handWrittenRun.code === 1 && handWrittenRun.out.includes(handWritten.slice(0, 12)),
      `a non-GitHub-shaped Co-authored-by line escaped the scan — the exemption is too broad. exit ${handWrittenRun.code}: ${handWrittenRun.out.slice(0, 200)}`,
    );

    const cleanRun = run("node", [COMMITMSG, `${handWritten}..${clean}`, ...DL, "--require-denylist"], { cwd: dir });
    check("does not flag a clean commit", cleanRun.code === 0, `exit was ${cleanRun.code}: ${cleanRun.out.slice(0, 200)}`);

    // Sanity: a single combined range spanning all four commits still
    // scans all of them (proves multi-commit ranges are walked in full,
    // not just the single-commit ranges exercised above) and still nets
    // exactly the two real findings (leaky + handWritten).
    const range = `${hash0}..${clean}`;
    const r = run("node", [COMMITMSG, range, ...DL, "--require-denylist"], { cwd: dir });
    check("fails when the combined range contains any offending commit", r.code === 1, `exit was ${r.code}`);
    check(
      "reports scanning all 4 commits in range",
      /scanned 4 item/.test(r.out),
      `expected "scanned 4 item(s)", got: ${r.out.slice(0, 200)}`,
    );
    const findingCount = (r.out.match(/\[high\] commit/g) ?? []).length;
    check("finds exactly the 2 real identity findings across the combined range", findingCount === 2, `expected 2 findings, got ${findingCount}: ${r.out.slice(0, 300)}`);

    // Regression for the newline-corruption bug: in this combined range
    // `clean` is the newest commit and both flagged commits (leaky,
    // handWritten) are NOT the newest, so `git log --format=`'s extra
    // newline terminator would have glued a leading "\n" onto their hash
    // after the %x00 split, corrupting the printed 12-char short hash
    // (e.g. `commit \n2ea250d75e` instead of the real 12 hex chars). Assert
    // the exact, uncorrupted label for each so this can't regress silently.
    check(
      `combined range prints the real, uncorrupted 12-char hash for non-newest flagged commit ${leaky.slice(0, 12)}`,
      r.out.includes(`commit ${leaky.slice(0, 12)}`),
      `expected "commit ${leaky.slice(0, 12)}" in the combined-range output, got: ${r.out.slice(0, 400)}`,
    );
    check(
      `combined range prints the real, uncorrupted 12-char hash for non-newest flagged commit ${handWritten.slice(0, 12)}`,
      r.out.includes(`commit ${handWritten.slice(0, 12)}`),
      `expected "commit ${handWritten.slice(0, 12)}" in the combined-range output, got: ${r.out.slice(0, 400)}`,
    );

    const titleClean = run("node", [COMMITMSG, "--title", "A perfectly ordinary PR title", ...DL, "--require-denylist"], { cwd: dir });
    check("a clean --title alone passes", titleClean.code === 0, `exit was ${titleClean.code}`);

    const titleLeaky = run("node", [COMMITMSG, "--title", "Mentions acme-corp in the title", ...DL, "--require-denylist"], { cwd: dir });
    check("a leaky --title alone fails", titleLeaky.code === 1, `exit was ${titleLeaky.code}`);

    const noDenylistEnv = { ...process.env };
    delete noDenylistEnv.PUBLIC_SAFETY_DENYLIST;
    const partial = run("node", [COMMITMSG, range], { cwd: dir, env: noDenylistEnv });
    check(
      "PARTIAL mode (no denylist) exits 0 without scanning for identity",
      partial.code === 0 && /PARTIAL/.test(partial.out),
      `exit ${partial.code}: ${partial.out.slice(0, 200)}`,
    );

    const requirePartial = run("node", [COMMITMSG, range, "--require-denylist", "--denylist", "/nonexistent/dl.json"], { cwd: dir });
    check("--require-denylist exits 2 when the denylist cannot be loaded", requirePartial.code === 2, `exit was ${requirePartial.code}`);

    const badRange = run("node", [COMMITMSG, "not-a-real-rev..also-not-real", ...DL, "--require-denylist"], { cwd: dir });
    check("a bad git rev-range fails closed (exit 2), not a silent 0-commit pass", badRange.code === 2, `exit was ${badRange.code}`);
  }

  // ------------------------- check-contamination-classes CLASS 4 (issue #27)
  // GH issue #27's own suggested-direction text asks for exactly this case:
  // "a fixture naming a retired package in a CHANGELOG should pass, while a
  // genuinely foreign scoped name should still fail." Deliberately exercised
  // against THIS repo's real history rather than a synthetic one:
  // check-contamination-classes.mjs reads its "ever published" name set from
  // git history rooted at wherever the SCRIPT FILE itself lives (see its own
  // loadHistoricalPackageNames), which is always the real checkout here, not
  // a fixture directory -- so faking that history would mean faking the
  // whole repo. @vespeneventures/icons was really published and really
  // retired (#23, #26), so it's the one real, permanent fact this fix can be
  // pinned against, the same way the "distblind"/"structure" cases above
  // already lean on this repo's real package-scope.json rather than a
  // synthetic stand-in.
  console.log("\n# check-contamination-classes CLASS 4: retired-but-real vs. genuinely foreign scoped names");
  {
    const dir = join(work, "contam-class4-retired");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@vespeneventures/probe", version: "1.0.0" }, null, 2) + "\n");
    writeFileSync(
      join(dir, "CHANGELOG.md"),
      "## 0.1.0\n- Removed `@vespeneventures/icons`; its glyphs now ship at `@vespeneventures/ui/icons`.\n",
    );
    writeFileSync(join(dir, "foreign.md"), "See `@vespeneventures/totally-made-up-thing-nobody-shipped` for details.\n");
    writeFileSync(join(dir, "install-retired.md"), "```\nnpm install @vespeneventures/icons\n```\n");

    const r = run("node", [CONTAM, dir, "--class", "4", "--json"]);
    let report;
    try {
      report = JSON.parse(r.out);
    } catch {
      report = { findings: [] };
    }
    const hit = (f) => (report.findings ?? []).some((x) => x.file === f);
    check(
      "a CHANGELOG naming a real, retired package in prose is NOT flagged",
      !hit("CHANGELOG.md"),
      `CHANGELOG.md was flagged: ${JSON.stringify(report.findings)}`,
    );
    check(
      "a genuinely foreign scoped name is still flagged (proves the fix didn't just stop checking)",
      hit("foreign.md"),
      `foreign.md was not flagged: ${JSON.stringify(report.findings)}`,
    );
    check(
      "an npm-install instruction for that SAME retired package is still flagged -- retired is not installable",
      hit("install-retired.md"),
      `install-retired.md was not flagged: ${JSON.stringify(report.findings)}`,
    );
    check("exits 1 overall (the foreign + install-instruction findings still fail the gate)", r.code === 1, `exit was ${r.code}`);
  }

  // --------------- check-contamination-classes CLASS 4: shallow clones fail closed
  // CLASS 4's git-history read for "did this repo ever publish that name" is
  // silently WRONG, not absent, on a shallow checkout: `git log` still
  // succeeds, it just can't see the commit where a retired package was ever
  // added. GitHub Actions' default checkout is shallow (fetch-depth 1) --
  // exactly the environment the previous case above never actually tested,
  // since this suite's own worktree always has full history. This case
  // builds a real shallow clone (local, via `file://`, so no network) of a
  // SYNTHETIC source repo the suite fully controls, so it pins the fix
  // against the actual failure mode rather than this worktree's incidental
  // full history.
  console.log("\n# check-contamination-classes CLASS 4: fails closed on a shallow clone, not a silent wrong answer");
  {
    const srcRepo = join(work, "class4-shallow-src");
    mkdirSync(join(srcRepo, "packages", "probe-lib"), { recursive: true });
    mkdirSync(join(srcRepo, "scripts"), { recursive: true });
    // The script reads git history rooted at wherever IT ITSELF lives (see
    // loadHistoricalPackageNames), so a real copy of it has to actually live
    // inside this synthetic repo to pick up ITS history instead of the real
    // repo's -- copying the file, not just referencing CONTAM's real path.
    cpSync(CONTAM, join(srcRepo, "scripts", "check-contamination-classes.mjs"));
    writeFileSync(
      join(srcRepo, "packages", "probe-lib", "package.json"),
      JSON.stringify({ name: `${FIXTURE_SCOPE}/probe-lib`, version: "1.0.0" }, null, 2) + "\n",
    );
    run("git", ["-C", srcRepo, "init", "-q"]);
    gitCommit(srcRepo, "add probe-lib");
    run("git", ["-C", srcRepo, "rm", "-q", "-r", "packages/probe-lib"]); // retire it
    gitCommit(srcRepo, "retire probe-lib");
    const fullScript = join(srcRepo, "scripts", "check-contamination-classes.mjs");

    const shallowClone = join(work, "class4-shallow-clone");
    run("git", ["clone", "--depth", "1", `file://${srcRepo}`, shallowClone]);
    const shallowScript = join(shallowClone, "scripts", "check-contamination-classes.mjs");

    const fixtureDir = join(work, "class4-shallow-fixture");
    mkdirSync(fixtureDir, { recursive: true });
    writeFileSync(join(fixtureDir, "package.json"), JSON.stringify({ name: `${FIXTURE_SCOPE}/probe`, version: "1.0.0" }, null, 2) + "\n");
    writeFileSync(join(fixtureDir, "CHANGELOG.md"), `## 0.2.0\n- Removed \`${FIXTURE_SCOPE}/probe-lib\`.\n`);

    function parseReport(out) {
      try {
        return JSON.parse(out);
      } catch {
        return { findings: [], indeterminate: [] };
      }
    }

    // Sanity anchor: the SAME fixture, checked by the SAME script content
    // but from the un-cloned, full-history source repo, passes clean --
    // proves clone depth is the only variable in the shallow case below,
    // not some other difference between the two invocations.
    const fullRun = run("node", [fullScript, fixtureDir, "--class", "4", "--json"]);
    const fullReport = parseReport(fullRun.out);
    check(
      "sanity: the same CHANGELOG, checked with full history, passes clean",
      fullRun.code === 0 && (fullReport.findings ?? []).length === 0 && (fullReport.indeterminate ?? []).length === 0,
      `exit ${fullRun.code}: ${fullRun.out.slice(0, 300)}`,
    );

    const shallowRun = run("node", [shallowScript, fixtureDir, "--class", "4", "--json"]);
    const shallowReport = parseReport(shallowRun.out);
    check(
      "a shallow clone (fetch-depth 1) fails CLOSED (exit 2) on the same CHANGELOG -- neither a silent pass nor a false flag",
      shallowRun.code === 2,
      `exit was ${shallowRun.code}: ${shallowRun.out.slice(0, 300)}`,
    );
    check(
      "the shallow-clone run reports the case as indeterminate, not as a confirmed finding either way",
      (shallowReport.indeterminate ?? []).some((f) => f.file === "CHANGELOG.md") && (shallowReport.findings ?? []).length === 0,
      `report: ${JSON.stringify(shallowReport).slice(0, 300)}`,
    );

    // The one case that never needed history at all -- a live install
    // instruction for a name that isn't currently live -- must still
    // resolve determinately (exit 1) even from the SAME shallow clone.
    const instructionFixture = join(work, "class4-shallow-instruction-fixture");
    mkdirSync(instructionFixture, { recursive: true });
    writeFileSync(join(instructionFixture, "package.json"), JSON.stringify({ name: `${FIXTURE_SCOPE}/probe`, version: "1.0.0" }, null, 2) + "\n");
    writeFileSync(join(instructionFixture, "install.md"), `\`\`\`\nnpm install ${FIXTURE_SCOPE}/probe-lib\n\`\`\`\n`);
    const instructionRun = run("node", [shallowScript, instructionFixture, "--class", "4", "--json"]);
    const instructionReport = parseReport(instructionRun.out);
    check(
      "an install-instruction case still resolves determinately (exit 1) from the same shallow clone -- it never needed history",
      instructionRun.code === 1 && (instructionReport.indeterminate ?? []).length === 0,
      `exit ${instructionRun.code}: ${instructionRun.out.slice(0, 300)}`,
    );
  }

  // ---------------------------------------------------- check-readme-parity
  console.log("\n# check-readme-parity: README vs. real exports");
  {
    const dir = join(work, "readme-parity");

    function writePackage(name, indexTs, readmeMd) {
      const pkgDir = join(dir, name);
      mkdirSync(join(pkgDir, "src"), { recursive: true });
      writeFileSync(
        join(pkgDir, "package.json"),
        JSON.stringify({ name: `${FIXTURE_SCOPE}/${name}`, version: "1.0.0", private: false }, null, 2) + "\n",
      );
      writeFileSync(join(pkgDir, "src", "index.ts"), indexTs);
      writeFileSync(join(pkgDir, "README.md"), readmeMd);
      return pkgDir;
    }

    function parseJson(out) {
      try {
        return JSON.parse(out);
      } catch {
        return { findings: [] };
      }
    }

    // Happy path: every export documented, table entries real, examples use
    // the real package name.
    const clean = writePackage(
      "clean",
      `export const Foo = 1;\nexport type Bar = string;\n`,
      [
        "# clean",
        "",
        "```ts",
        `import { Foo } from "${FIXTURE_SCOPE}/clean";`,
        "```",
        "",
        "## API",
        "",
        "| Export | Type |",
        "| --- | --- |",
        "| `Foo` | number |",
        "",
        "Also exports the `Bar` type.",
        "",
      ].join("\n"),
    );
    const okRun = run("node", [READMEPARITY, clean, "--json"]);
    check("passes a README that fully documents real exports", okRun.code === 0, `exit ${okRun.code}: ${okRun.out.slice(0, 300)}`);

    // CHECK A: a real VALUE export that appears nowhere in the README.
    const undocumented = writePackage(
      "undocumented",
      `export const Foo = 1;\nexport const Baz = 2;\n`,
      ["# undocumented", "", "Only mentions `Foo`.", ""].join("\n"),
    );
    const undocRun = run("node", [READMEPARITY, undocumented, "--json"]);
    const undocReport = parseJson(undocRun.out);
    check(
      "CHECK A flags a value export missing from README entirely",
      undocRun.code === 1 && (undocReport.findings ?? []).some((f) => f.check === "A" && f.severity === "high" && /Baz/.test(f.message)),
      `exit ${undocRun.code}: ${undocRun.out.slice(0, 300)}`,
    );

    // Sanity for CHECK A's severity split: an undocumented TYPE-only export
    // is still recorded as a finding (proves the scan actually inspected
    // real exports, rather than passing on zero coverage) but is "low"
    // severity and must NOT fail the gate on its own.
    const typeOnly = writePackage(
      "type-only",
      // The parser only recognises the barrel re-export shape used
      // throughout this repo's real packages (`export type { X }`), not a
      // direct `export type X = ...` alias declaration — matching
      // src/index.ts in every real package here.
      `type Ghost = string;\nexport const Foo = 1;\nexport type { Ghost };\n`,
      ["# type-only", "", "Mentions `Foo` only.", ""].join("\n"),
    );
    const typeOnlyRun = run("node", [READMEPARITY, typeOnly, "--json"]);
    const typeOnlyReport = parseJson(typeOnlyRun.out);
    check(
      "an undocumented TYPE export is recorded as a low-severity finding",
      (typeOnlyReport.findings ?? []).some((f) => f.check === "A" && f.severity === "low" && /Ghost/.test(f.message)),
      `findings: ${JSON.stringify(typeOnlyReport.findings)}`,
    );
    check("a lone low-severity finding does not fail the gate", typeOnlyRun.code === 0, `exit was ${typeOnlyRun.code}`);

    // CHECK B: a copy-pasteable import/install line naming the WRONG
    // package under the same scope.
    const wrongName = writePackage(
      "wrong-name",
      `export const Foo = 1;\n`,
      [
        "# wrong-name",
        "",
        "```ts",
        `import { Foo } from "${FIXTURE_SCOPE}/not-this-package";`,
        "```",
        "",
        "Mentions `Foo`.",
        "",
      ].join("\n"),
    );
    const wrongNameRun = run("node", [READMEPARITY, wrongName, "--json"]);
    const wrongNameReport = parseJson(wrongNameRun.out);
    check(
      "CHECK B flags an import example naming the wrong package under this scope",
      wrongNameRun.code === 1 && (wrongNameReport.findings ?? []).some((f) => f.check === "B" && /not-this-package/.test(f.message)),
      `exit ${wrongNameRun.code}: ${wrongNameRun.out.slice(0, 300)}`,
    );

    // CHECK B regression: prose containing a word like "important" that
    // starts with the literal substring "import" must NOT be mistaken for an
    // `import` statement just because a `@scope/other-package` reference sits
    // on the same line. This is the exact shape that tripped the gate in
    // packages/assets/README.md (worked around by rewording; see PR #53) —
    // a bare `\bimport` (no trailing boundary) matches "important" too.
    const proseImportant = writePackage(
      "prose-important",
      `export const Foo = 1;\n`,
      [
        "# prose-important",
        "",
        `See \`${FIXTURE_SCOPE}/other-package\`'s README, "The single most important constraint", for the fuller argument.`,
        "",
        "Mentions `Foo`.",
        "",
      ].join("\n"),
    );
    const proseImportantRun = run("node", [READMEPARITY, proseImportant, "--json"]);
    check(
      "CHECK B does not flag prose containing \"important\" alongside an unrelated @scope reference",
      proseImportantRun.code === 0,
      `exit ${proseImportantRun.code}: ${proseImportantRun.out.slice(0, 300)}`,
    );

    // CHECK C: the API table documents an export that does not exist.
    const phantom = writePackage(
      "phantom",
      `export const Foo = 1;\n`,
      [
        "# phantom",
        "",
        "Mentions `Foo`.",
        "",
        "## API",
        "",
        "| Export | Type |",
        "| --- | --- |",
        "| `Foo` | number |",
        "| `Ghost` | number |",
        "",
      ].join("\n"),
    );
    const phantomRun = run("node", [READMEPARITY, phantom, "--json"]);
    const phantomReport = parseJson(phantomRun.out);
    check(
      "CHECK C flags an API table row for an export that doesn't exist",
      phantomRun.code === 1 && (phantomReport.findings ?? []).some((f) => f.check === "C" && /Ghost/.test(f.message)),
      `exit ${phantomRun.code}: ${phantomRun.out.slice(0, 300)}`,
    );

    // Fail-closed: a package directory missing a required file must abort
    // (exit 2), never report a silent pass.
    const missing = join(dir, "missing-readme");
    mkdirSync(join(missing, "src"), { recursive: true });
    writeFileSync(join(missing, "package.json"), JSON.stringify({ name: `${FIXTURE_SCOPE}/missing-readme` }) + "\n");
    writeFileSync(join(missing, "src", "index.ts"), "export const Foo = 1;\n");
    const missingRun = run("node", [READMEPARITY, missing]);
    check("aborts (exit 2) when README.md is absent", missingRun.code === 2, `exit was ${missingRun.code}`);
  }

  // ---------------------------- set-scope: scope rename, not name capture (issue #9)
  console.log("\n# set-scope: a third-party name sharing a first-party package name (issue #9)");
  {
    // set-scope.mjs resolves its own repo root from its own file location
    // (dirname(import.meta.url) + ".."), not from a CLI argument like the
    // other gates take — so exercising it hermetically means giving it its
    // own fixture repo, with its own copy of the script, rather than pointing
    // it at a fixture directory the way SAFETY/ARTIFACT/CONTAM are pointed.
    const dir = join(work, "set-scope-names");
    mkdirSync(join(dir, "packages", "ui"), { recursive: true });
    mkdirSync(join(dir, "scripts"), { recursive: true });
    cpSync(SET_SCOPE, join(dir, "scripts", "set-scope.mjs"));
    writeFileSync(
      join(dir, "package-scope.json"),
      JSON.stringify({ scope: "@fixture-first-party", registry: "https://example.invalid" }, null, 2) + "\n",
    );
    writeFileSync(
      join(dir, "packages", "ui", "package.json"),
      JSON.stringify({ name: "@fixture-first-party/ui", version: "1.0.0" }, null, 2) + "\n",
    );
    // The whole point: a THIRD-PARTY package whose local name ("ui") happens
    // to collide with a package we own, sitting in a lockfile-shaped file —
    // exactly the shape of the real corruption (@vitest/ui, in
    // package-lock.json's own peerDependencies, rewritten to
    // @vespeneventures/ui). Nothing here carries our declared scope.
    writeFileSync(
      join(dir, "package-lock.json"),
      JSON.stringify({ packages: { "node_modules/@some-other-vendor/ui": { peerDependencies: { "@some-other-vendor/ui": "4.1.10" } } } }, null, 2) + "\n",
    );
    gitInit(dir);

    const before = readFileSync(join(dir, "package-lock.json"), "utf8");
    const check1 = run("node", [join(dir, "scripts", "set-scope.mjs"), "--check"], { cwd: dir });
    check(
      "--check does not flag a third-party name sharing a first-party package name",
      check1.code === 0,
      `expected exit 0, got ${check1.code}: ${check1.out}`,
    );

    // Also run the rewrite for real (no --check) and confirm the file on disk
    // is byte-for-byte unchanged — --check passing is not enough on its own,
    // since a bug in --check's own logic could mask a bug in the rewrite.
    run("node", [join(dir, "scripts", "set-scope.mjs")], { cwd: dir });
    const after = readFileSync(join(dir, "package-lock.json"), "utf8");
    check(
      "the rewrite itself never touches the third-party reference",
      after === before,
      "package-lock.json changed even though nothing in it carries our declared scope",
    );
    check(
      "the third-party scope is still intact",
      after.includes("@some-other-vendor/ui") && !after.includes("@fixture-first-party/ui\":") ,
      `expected @some-other-vendor/ui to survive untouched, got: ${after}`,
    );
  }

  // --------------------------- set-scope: walk skips gitignored paths (issue #25)
  console.log("\n# set-scope: walk never descends into gitignored paths, e.g. .claude/ (issue #25)");
  {
    const dir = join(work, "set-scope-gitignore");
    mkdirSync(join(dir, "packages", "probe"), { recursive: true });
    mkdirSync(join(dir, "scripts"), { recursive: true });
    cpSync(SET_SCOPE, join(dir, "scripts", "set-scope.mjs"));
    writeFileSync(join(dir, ".gitignore"), ".claude/\n");
    writeFileSync(
      join(dir, "package-scope.json"),
      JSON.stringify({ scope: "@fixture-old-scope", registry: "https://example.invalid" }, null, 2) + "\n",
    );
    writeFileSync(
      join(dir, "packages", "probe", "package.json"),
      JSON.stringify({ name: "@fixture-old-scope/probe", version: "1.0.0" }, null, 2) + "\n",
    );
    // A file sitting inside a gitignored directory — modelling another
    // agent's live, uncommitted worktree under .claude/ — that legitimately
    // carries the declared scope and so WOULD be rewritten by a scope rename
    // if the walk ever reached it. gitInit's `git add -A` will not stage
    // this: .gitignore already excludes .claude/, exactly like the real repo.
    mkdirSync(join(dir, ".claude", "worktrees", "foreign-session", "packages", "probe"), { recursive: true });
    writeFileSync(
      join(dir, ".claude", "worktrees", "foreign-session", "packages", "probe", "package.json"),
      JSON.stringify({ name: "@fixture-old-scope/probe", version: "1.0.0" }, null, 2) + "\n",
    );
    gitInit(dir);

    const r = run("node", [join(dir, "scripts", "set-scope.mjs"), "--scope", "@fixture-new-scope"], { cwd: dir });
    check("a real scope rename still exits cleanly", r.code === 0, `exit was ${r.code}: ${r.out}`);

    const tracked = readFileSync(join(dir, "packages", "probe", "package.json"), "utf8");
    check(
      "the rename still applies to a tracked, non-ignored file",
      tracked.includes("@fixture-new-scope/probe"),
      `tracked package.json was not renamed: ${tracked}`,
    );

    const foreign = readFileSync(
      join(dir, ".claude", "worktrees", "foreign-session", "packages", "probe", "package.json"),
      "utf8",
    );
    check(
      "a file inside a gitignored directory (.claude/) is left untouched",
      foreign.includes("@fixture-old-scope/probe") && !foreign.includes("@fixture-new-scope"),
      `expected the foreign worktree's file to be untouched by the rename, got: ${foreign}`,
    );

    // This case is deliberately only exercised via --scope, not bare --check:
    // with the scope-anchored regex (issue #9's fix), bare --check's tree-wide
    // rewrite maps @declaredScope/x to @declaredScope/x -- an identity
    // transform regardless of what walk() returns -- so .claude/'s contents
    // cannot affect a bare --check's outcome at all, by construction, not
    // because walk() is untested. The --scope rename is the only operation
    // where walk() reaching .claude/ has any observable effect (writing into
    // a foreign worktree), which is exactly what this case pins.
  }

  // ------------------- set-scope: bare --check must not be vacuous (regression)
  //
  // The bug this section exists to pin: with no --scope override, line ~42's
  // nextScope defaults to config.scope, and oldScope (read a few lines later)
  // is also config.scope -- the same string. The tree-wide rewrite's replace
  // then maps every match to itself, `changed` is always empty, and a version
  // of this script that relied on `changed` alone for --check's verdict would
  // report a clean pass on ANY tree, forever, including one where every
  // package name is wrong -- CI's `check:scope` step runs exactly this bare
  // form. The structural check (reading each packages/*/package.json's own
  // `name` directly) is what actually closes this.
  console.log("\n# set-scope: bare --check (no --scope) still catches a wrong-scope package name");
  {
    const dir = join(work, "set-scope-vacuous-check");
    mkdirSync(join(dir, "packages", "ui"), { recursive: true });
    mkdirSync(join(dir, "scripts"), { recursive: true });
    cpSync(SET_SCOPE, join(dir, "scripts", "set-scope.mjs"));
    writeFileSync(
      join(dir, "package-scope.json"),
      JSON.stringify({ scope: "@real", registry: "https://example.invalid" }, null, 2) + "\n",
    );
    // Wrong scope, hand-typed. This never carried the declared scope to begin
    // with, so the text-rewrite regex (anchored on @real/, issue #9's fix)
    // never even matches it -- it is invisible to the rewrite/check path by
    // construction, which is exactly why the structural check has to exist.
    writeFileSync(
      join(dir, "packages", "ui", "package.json"),
      JSON.stringify({ name: "@wrong/ui", version: "1.0.0" }, null, 2) + "\n",
    );
    gitInit(dir);

    const r = run("node", [join(dir, "scripts", "set-scope.mjs"), "--check"], { cwd: dir });
    check(
      "bare --check fails when a package's own name carries the wrong scope",
      r.code === 1,
      `expected exit 1, got ${r.code}: ${r.out}`,
    );
    check(
      "the failure names the offending package and its actual (wrong) name",
      /packages\/ui\/package\.json/.test(r.out) && /@wrong\/ui/.test(r.out),
      `expected the finding to name packages/ui/package.json and @wrong/ui, got: ${r.out}`,
    );
  }

  // --------------------------- set-scope: structural check fails closed (issue #9 review)
  console.log("\n# set-scope: the structural check fails closed, never green on \"could not check\"");
  {
    // "Could not check" (packages/ missing or empty) must exit 2, not 0 --
    // silently passing over zero packages is the same shape of bug (a check
    // that can never fail) this file was just fixed for, one layer up.
    const zeroDir = join(work, "set-scope-zero-packages");
    mkdirSync(join(zeroDir, "scripts"), { recursive: true });
    cpSync(SET_SCOPE, join(zeroDir, "scripts", "set-scope.mjs"));
    writeFileSync(
      join(zeroDir, "package-scope.json"),
      JSON.stringify({ scope: "@real", registry: "https://example.invalid" }, null, 2) + "\n",
    );
    // No packages/ directory at all.
    gitInit(zeroDir);
    const zeroResult = run("node", [join(zeroDir, "scripts", "set-scope.mjs"), "--check"], { cwd: zeroDir });
    check(
      "zero packages under packages/ exits 2, not 0",
      zeroResult.code === 2,
      `expected exit 2, got ${zeroResult.code}: ${zeroResult.out}`,
    );

    // A package.json that exists but has no "name" field: also "could not
    // check", also exit 2 -- never silently skipped as if it matched.
    const noNameDir = join(work, "set-scope-missing-name");
    mkdirSync(join(noNameDir, "packages", "ui"), { recursive: true });
    mkdirSync(join(noNameDir, "scripts"), { recursive: true });
    cpSync(SET_SCOPE, join(noNameDir, "scripts", "set-scope.mjs"));
    writeFileSync(
      join(noNameDir, "package-scope.json"),
      JSON.stringify({ scope: "@real", registry: "https://example.invalid" }, null, 2) + "\n",
    );
    writeFileSync(join(noNameDir, "packages", "ui", "package.json"), JSON.stringify({ version: "1.0.0" }, null, 2) + "\n");
    gitInit(noNameDir);
    const noNameResult = run("node", [join(noNameDir, "scripts", "set-scope.mjs"), "--check"], { cwd: noNameDir });
    check(
      'a package.json with no "name" field exits 2, not 0',
      noNameResult.code === 2,
      `expected exit 2, got ${noNameResult.code}: ${noNameResult.out}`,
    );

    // Contrast: a genuinely clean, fully-checkable tree still exits 0 — the
    // fail-closed cases above are about ambiguity, not about the gate being
    // generally trigger-happy.
    const cleanDir = join(work, "set-scope-clean-for-contrast");
    mkdirSync(join(cleanDir, "packages", "ui"), { recursive: true });
    mkdirSync(join(cleanDir, "scripts"), { recursive: true });
    cpSync(SET_SCOPE, join(cleanDir, "scripts", "set-scope.mjs"));
    writeFileSync(
      join(cleanDir, "package-scope.json"),
      JSON.stringify({ scope: "@real", registry: "https://example.invalid" }, null, 2) + "\n",
    );
    writeFileSync(
      join(cleanDir, "packages", "ui", "package.json"),
      JSON.stringify({ name: "@real/ui", version: "1.0.0" }, null, 2) + "\n",
    );
    gitInit(cleanDir);
    const cleanResult = run("node", [join(cleanDir, "scripts", "set-scope.mjs"), "--check"], { cwd: cleanDir });
    check(
      "a genuinely clean, fully-checkable tree still exits 0",
      cleanResult.code === 0,
      `expected exit 0, got ${cleanResult.code}: ${cleanResult.out}`,
    );
  }

  // ------------------------------------------ root README parity (issue #28)
  console.log("\n# check-root-readme-parity: root README vs packages/");
  {
    const dir = join(work, "root-readme");
    const packagesDir = join(dir, "packages");
    mkdirSync(join(packagesDir, "alpha"), { recursive: true });
    mkdirSync(join(packagesDir, "beta"), { recursive: true });
    writeFileSync(join(packagesDir, "alpha", "package.json"), JSON.stringify({ name: `${FIXTURE_SCOPE}/alpha`, version: "1.0.0" }, null, 2) + "\n");
    writeFileSync(join(packagesDir, "beta", "package.json"), JSON.stringify({ name: `${FIXTURE_SCOPE}/beta`, version: "1.0.0" }, null, 2) + "\n");

    function writeReadme(rows) {
      writeFileSync(
        join(dir, "README.md"),
        ["## Packages", "", "| Package | What it does |", "| --- | --- |", ...rows, ""].join("\n"),
      );
    }

    // Sanity (real coverage): a table naming every real package passes, and
    // it does so because the scan actually walked packages/alpha and
    // packages/beta and read their real names — not because the fixture has
    // nothing to check. The next case mutates this exact fixture and shows
    // the same run catches the drift, which is what proves the pass above
    // wasn't just zero coverage in disguise.
    writeReadme([`| \`${FIXTURE_SCOPE}/alpha\` | does alpha things |`, `| \`${FIXTURE_SCOPE}/beta\` | does beta things |`]);
    const complete = run("node", [ROOT_README, dir]);
    check(
      "sanity: a table naming every real package passes, proving the scan reads real packages/ content rather than passing on zero coverage",
      complete.code === 0,
      `exit ${complete.code}: ${complete.out.slice(0, 300)}`,
    );

    // Same fixture, beta's row removed — structurally the same shape as
    // issue #28's actual defect (@vespeneventures/voice and
    // @vespeneventures/strategy had no row at all).
    writeReadme([`| \`${FIXTURE_SCOPE}/alpha\` | does alpha things |`]);
    const missing = run("node", [ROOT_README, dir]);
    check(
      "catches a real package missing its README row",
      missing.code === 1 && missing.out.includes(`${FIXTURE_SCOPE}/beta`),
      `exit ${missing.code}: ${missing.out.slice(0, 300)}`,
    );

    // Mirror-image drift: a row names a package that no longer exists under
    // packages/ at all (removed from disk, never removed from the table).
    writeReadme([
      `| \`${FIXTURE_SCOPE}/alpha\` | does alpha things |`,
      `| \`${FIXTURE_SCOPE}/beta\` | does beta things |`,
      `| \`${FIXTURE_SCOPE}/retired\` | doesn't exist anymore |`,
    ]);
    const stale = run("node", [ROOT_README, dir]);
    check(
      "catches a README row naming a package that no longer exists under packages/",
      stale.code === 1 && stale.out.includes(`${FIXTURE_SCOPE}/retired`),
      `exit ${stale.code}: ${stale.out.slice(0, 300)}`,
    );

    // Fail-closed cases below. None of these may exit 0, and none may print
    // anything that reads as a pass — "could not check" and "checked and it
    // was fine" sharing an exit code is exactly how issue #28 survived.
    const passLooking = /\bOK\b|\bPASS\b/;

    const noHeading = join(work, "root-readme-no-heading");
    mkdirSync(join(noHeading, "packages", "alpha"), { recursive: true });
    writeFileSync(join(noHeading, "packages", "alpha", "package.json"), JSON.stringify({ name: `${FIXTURE_SCOPE}/alpha` }) + "\n");
    writeFileSync(join(noHeading, "README.md"), "# a README with no Packages heading at all\n");
    const rNoHeading = run("node", [ROOT_README, noHeading]);
    check("fails closed when README has no Packages heading", rNoHeading.code === 2, `exit was ${rNoHeading.code}`);
    check(
      "does not print a passing-looking result when it could not locate the table",
      !passLooking.test(rNoHeading.out),
      `output looked like a pass: ${rNoHeading.out.slice(0, 200)}`,
    );

    const noTable = join(work, "root-readme-no-table");
    mkdirSync(join(noTable, "packages", "alpha"), { recursive: true });
    writeFileSync(join(noTable, "packages", "alpha", "package.json"), JSON.stringify({ name: `${FIXTURE_SCOPE}/alpha` }) + "\n");
    writeFileSync(join(noTable, "README.md"), "## Packages\n\nprose, no table here.\n");
    const rNoTable = run("node", [ROOT_README, noTable]);
    check("fails closed when the Packages section has no parseable table (zero rows)", rNoTable.code === 2, `exit was ${rNoTable.code}`);
    check(
      "does not print a passing-looking result over zero parsed rows",
      !passLooking.test(rNoTable.out),
      `output looked like a pass: ${rNoTable.out.slice(0, 200)}`,
    );

    const noPackagesDir = join(work, "root-readme-no-packages-dir");
    mkdirSync(noPackagesDir, { recursive: true });
    writeFileSync(join(noPackagesDir, "README.md"), "## Packages\n\n| Package | What it does |\n| --- | --- |\n");
    const rNoPkgDir = run("node", [ROOT_README, noPackagesDir]);
    check("fails closed when packages/ does not exist", rNoPkgDir.code === 2, `exit was ${rNoPkgDir.code}`);

    const emptyPackagesDir = join(work, "root-readme-empty-packages-dir");
    mkdirSync(join(emptyPackagesDir, "packages"), { recursive: true });
    writeFileSync(
      join(emptyPackagesDir, "README.md"),
      "## Packages\n\n| Package | What it does |\n| --- | --- |\n| `@x/y` | thing |\n",
    );
    const rEmptyPkgDir = run("node", [ROOT_README, emptyPackagesDir]);
    check(
      "fails closed when packages/ has no real (scoped-named) package to compare against",
      rEmptyPkgDir.code === 2,
      `exit was ${rEmptyPkgDir.code}`,
    );
  }

  // ------------------------ root README parity: subpath claims (CHECK D)
  // A row's PACKAGE NAME can be exactly right (passing every check above)
  // while its PROSE lies about that package's shape. This is issue #28's
  // actual historical defect, reproduced structurally: the real
  // @vespeneventures/ui row named the right package and said
  // "`blocks` and `views` are a planned future subpath, not built yet"
  // long after both had shipped as real `exports` keys.
  console.log("\n# check-root-readme-parity: subpath claims contradicting real exports (CHECK D)");
  {
    const dir = join(work, "root-readme-subpaths");
    mkdirSync(join(dir, "packages", "gamma"), { recursive: true });
    writeFileSync(
      join(dir, "packages", "gamma", "package.json"),
      JSON.stringify(
        {
          name: `${FIXTURE_SCOPE}/gamma`,
          version: "1.0.0",
          exports: {
            ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
            "./atoms": { types: "./dist/atoms/index.d.ts", import: "./dist/atoms/index.js" },
            "./blocks": { types: "./dist/blocks/index.d.ts", import: "./dist/blocks/index.js" },
          },
        },
        null,
        2,
      ) + "\n",
    );

    function writeGammaReadme(description) {
      writeFileSync(
        join(dir, "README.md"),
        ["## Packages", "", "| Package | What it does |", "| --- | --- |", `| \`${FIXTURE_SCOPE}/gamma\` | ${description} |`, ""].join("\n"),
      );
    }

    // D1 (positive): an explicit `./name` mention that isn't a real key in
    // this package's own "exports" — the row documents a subpath that does
    // not exist, the root-README mirror of check-readme-parity's CHECK C.
    writeGammaReadme("Ships \`./atoms\` and \`./blocks\`, plus \`./nonexistent\` for legacy imports.");
    const nonexistent = run("node", [ROOT_README, dir]);
    check(
      "D1: catches an explicit ./subpath mention that is not a real exports key",
      nonexistent.code === 1 && nonexistent.out.includes("./nonexistent"),
      `exit ${nonexistent.code}: ${nonexistent.out.slice(0, 300)}`,
    );

    // D2 (negative, the historical shape): a BARE word identical to a real
    // subpath name, in the same clause as a curated "doesn't exist yet"
    // phrase, while that subpath actually IS a real key. This is the exact
    // shape of the real @vespeneventures/ui defect, reproduced with a
    // synthetic package and a synthetic subpath name.
    writeGammaReadme("Ships the \`atoms\` layer only; \`blocks\` is a planned future subpath, not built yet.");
    const falseAbsence = run("node", [ROOT_README, dir]);
    check(
      "D2: catches a bare mention of a REAL subpath negated by a curated 'not built yet' phrase (issue #28's actual historical shape)",
      falseAbsence.code === 1 && falseAbsence.out.includes('describes "blocks"'),
      `exit ${falseAbsence.code}: ${falseAbsence.out.slice(0, 300)}`,
    );

    // Precision: the negation phrase sits in a LATER clause than a
    // correctly-described real subpath in the same cell. The clause-scoped
    // match must not cross-contaminate — `atoms` is truthfully described as
    // shipped and must not be flagged just because `blocks` is falsely
    // negated two clauses later in the same row.
    check(
      "D2 is clause-scoped: a truthfully-described subpath earlier in the same cell is not flagged by a later clause's negation",
      !falseAbsence.out.includes('describes "atoms"'),
      `atoms was incorrectly flagged: ${falseAbsence.out.slice(0, 300)}`,
    );

    // Sanity (real coverage): the same real subpaths, truthfully described
    // with no negation phrase anywhere, passes — proving D1/D2 read the
    // real "exports" map and the real README prose rather than flagging
    // unconditionally once a negation-shaped fixture exists.
    writeGammaReadme("Ships \`./atoms\` and \`./blocks\`, the two layers this package has today.");
    const clean = run("node", [ROOT_README, dir]);
    check(
      "sanity: truthfully describing real subpaths with no negation phrase passes",
      clean.code === 0,
      `exit ${clean.code}: ${clean.out.slice(0, 300)}`,
    );

    // A negation phrase near a BARE word that is not a real subpath name at
    // all (ordinary prose) must never be flagged — CHECK D only fires when
    // the negated word is identical to a verified real "exports" key, never
    // as a general "this sentence sounds negative" scan.
    writeGammaReadme("The changelog format is not built yet for this package.");
    const ordinaryProse = run("node", [ROOT_README, dir]);
    check(
      "a negation phrase near ordinary prose (no real-subpath-named word involved) is not flagged",
      ordinaryProse.code === 0,
      `exit ${ordinaryProse.code}: ${ordinaryProse.out.slice(0, 300)}`,
    );
  }

  // ============================================================
  // Everything below this line is a clearly separate block appended for
  // GH issues #1 and #2. Kept isolated at the end on purpose: other work
  // also appends to this file, and a self-contained block here keeps any
  // merge conflict trivial.
  // ============================================================

  // -------------------------- denylist quality: self-scope (issue #1) -----
  console.log("\n# denylist quality — self-scope (a term matching this repo's own scope/package names)");
  {
    // A synthetic scope config + one synthetic package, structurally
    // identical to the real package-scope.json + packages/*/package.json
    // layout but under a scope that appears in no real denylist term.
    const scopeDir = join(work, "self-scope-fixture");
    mkdirSync(join(scopeDir, "packages", "gadget"), { recursive: true });
    const scopeConfigPath = join(scopeDir, "package-scope.json");
    writeFileSync(scopeConfigPath, JSON.stringify({ scope: "@widgetco-fixture", registry: "https://example.invalid" }));
    writeFileSync(
      join(scopeDir, "packages", "gadget", "package.json"),
      JSON.stringify({ name: "@widgetco-fixture/gadget", version: "1.0.0" }),
    );

    const runQuality = (denylistObj, extraArgs = []) => {
      const p = join(scopeDir, `dl-${Math.random().toString(36).slice(2)}.json`);
      writeFileSync(p, JSON.stringify(denylistObj));
      const r = run("node", [QUALITY, "--denylist", p, "--scope-config", scopeConfigPath, "--json", ...extraArgs]);
      let report;
      try {
        report = JSON.parse(r.out);
      } catch {
        report = null;
      }
      return { ...r, report };
    };

    // Violation: the term's pattern matches the fixture's own scope string.
    const scopeHit = runQuality({
      version: "t",
      terms: [{ pattern: "widgetco-fixture", why: "synthetic self-scope violation (scope string)", severity: "high" }],
    });
    check(
      "flags a term matching this repo's own configured scope",
      scopeHit.code === 1 && (scopeHit.report?.findings ?? []).some((f) => f.rule === "self-scope" && f.index === 0),
      `expected a self-scope finding at index 0, got ${JSON.stringify(scopeHit.report?.findings)}`,
    );

    // Violation, different source: the term's pattern matches a PACKAGE NAME
    // under the scope, not the bare scope string itself — proves coverage
    // isn't limited to the one obvious candidate (the incident this
    // reproduces was 59 files of package-NAME hits, not just the scope).
    const packageHit = runQuality({
      version: "t",
      terms: [{ pattern: "widgetco-fixture/gadget", why: "synthetic self-scope violation (package name)", severity: "high" }],
    });
    check(
      "flags a term matching a package name published under this repo's own scope",
      packageHit.code === 1 && (packageHit.report?.findings ?? []).some((f) => f.rule === "self-scope" && f.index === 0),
      `expected a self-scope finding at index 0, got ${JSON.stringify(packageHit.report?.findings)}`,
    );

    // Sanity (real coverage, not zero coverage): an unrelated term over the
    // SAME fixture does not trip self-scope — proving the prior two cases
    // failed because of what they matched, not because this fixture flags
    // everything indiscriminately.
    const clean = runQuality({
      version: "t",
      terms: [{ pattern: "unrelatedthing", why: "synthetic unrelated term", severity: "high" }],
    });
    check(
      "sanity: an unrelated term over the same scope fixture is NOT flagged for self-scope, and the scan finds nothing — proving the self-scope check inspects the actual candidate set rather than failing everything",
      clean.code === 0 && !(clean.report?.findings ?? []).some((f) => f.rule === "self-scope"),
      `expected no self-scope finding, got ${JSON.stringify(clean.report?.findings)}`,
    );

    // Coverage reporting (audit finding): the candidate-set size is reported
    // unconditionally, not just implied by a pass/fail. This fixture has
    // exactly one package under packages/*, so the count is pinned exactly —
    // a regression that silently drops package-name coverage (e.g. a typo'd
    // packagesDir) would still report SOME candidates (the bare scope) and
    // pass every other check here without this explicit count.
    check(
      "self-scope coverage reports the exact candidate/package counts for this fixture (1 package under packages/*)",
      clean.report?.selfScopeCoverage?.packageNamesFound === 1 &&
        clean.report?.selfScopeCoverage?.scopeAndPackageCandidates === 4,
      `expected packageNamesFound:1, scopeAndPackageCandidates:4, got ${JSON.stringify(clean.report?.selfScopeCoverage)}`,
    );

    // The documented, at-add-time override: selfScopeJustification turns the
    // match into an ACKNOWLEDGED entry rather than a failing finding.
    // Pattern covers both the separated and compound form of its own literal
    // (optional hyphen) so this case isolates the self-scope acknowledgement
    // from the unrelated separator-optional pattern-shape finding.
    const justified = runQuality({
      version: "t",
      terms: [
        {
          pattern: "widgetco-?fixture",
          why: "synthetic self-scope, deliberately justified",
          severity: "high",
          selfScopeJustification: "synthetic: deliberate, reviewed exception for this fixture",
        },
      ],
    });
    check(
      "selfScopeJustification acknowledges the match instead of failing",
      justified.code === 0 &&
        !(justified.report?.findings ?? []).some((f) => f.rule === "self-scope") &&
        (justified.report?.selfScopeAcknowledged ?? []).some((a) => a.index === 0),
      `expected an acknowledged self-scope entry and no failing finding, got ${JSON.stringify(justified.report)}`,
    );

    // ---------------------------------------------- fail-closed: self-scope
    // "Could not check" and "checked, and it was fine" must never share an
    // exit code — same standard the denylist-loading fail-closed cases hold
    // check-public-safety.mjs to.
    const missingScopeConfig = run("node", [
      QUALITY,
      "--denylist",
      (() => {
        const p = join(scopeDir, "dl-missing-scope.json");
        writeFileSync(p, JSON.stringify({ version: "t", terms: [{ pattern: "unrelatedthing", why: "x", severity: "high" }] }));
        return p;
      })(),
      "--scope-config",
      join(scopeDir, "does-not-exist.json"),
    ]);
    check(
      "fails closed (exit 2) when the scope config cannot be loaded",
      missingScopeConfig.code === 2,
      `exit was ${missingScopeConfig.code}: ${missingScopeConfig.out.slice(0, 300)}`,
    );

    const noScopeField = join(scopeDir, "no-scope-field.json");
    writeFileSync(noScopeField, JSON.stringify({ registry: "https://example.invalid" }));
    const badScopeConfig = run("node", [
      QUALITY,
      "--denylist",
      join(scopeDir, "dl-missing-scope.json"),
      "--scope-config",
      noScopeField,
    ]);
    check(
      "fails closed (exit 2) when the scope config has no `scope` string",
      badScopeConfig.code === 2,
      `exit was ${badScopeConfig.code}: ${badScopeConfig.out.slice(0, 300)}`,
    );
  }

  // ---------------------- denylist quality: self-containment (issue #2) ---
  console.log("\n# denylist quality — self-containment (a term's why/boundaryJustification leaking another term's value)");
  {
    const containDir = join(work, "self-containment-fixture");
    mkdirSync(containDir, { recursive: true });
    // Reuse the same harmless scope fixture shape from above so this block
    // never depends on the earlier one's temp files still existing.
    const scopeConfigPath = join(containDir, "package-scope.json");
    writeFileSync(scopeConfigPath, JSON.stringify({ scope: "@containment-fixture-scope", registry: "https://example.invalid" }));

    const runQuality = (denylistObj) => {
      const p = join(containDir, `dl-${Math.random().toString(36).slice(2)}.json`);
      writeFileSync(p, JSON.stringify(denylistObj));
      const r = run("node", [QUALITY, "--denylist", p, "--scope-config", scopeConfigPath, "--json"]);
      let report;
      try {
        report = JSON.parse(r.out);
      } catch {
        report = null;
      }
      return { ...r, report };
    };

    // Violation: term #1's `why` literally contains term #0's value
    // ("acmecorp" — single-word compound so this case isolates
    // self-containment from the separator-optional pattern-shape check
    // above, which is a different finding about a different property).
    const whyLeak = runQuality({
      version: "t",
      terms: [
        { pattern: "acmecorp", why: "synthetic sibling product", severity: "high" },
        { pattern: "zetaindustries", why: "this description mentions acmecorp by name, which it must not", severity: "medium" },
      ],
    });
    check(
      "flags a `why` field that contains another term's literal value",
      whyLeak.code === 1 &&
        (whyLeak.report?.findings ?? []).some((f) => f.rule === "self-containment" && f.index === 1),
      `expected a self-containment finding at index 1, got ${JSON.stringify(whyLeak.report?.findings)}`,
    );

    // Violation via the other field this rule covers: boundaryJustification.
    const boundaryLeak = runQuality({
      version: "t",
      terms: [
        { pattern: "acmecorp", why: "synthetic sibling product", severity: "high" },
        {
          pattern: "\\bzetaindustries\\b",
          why: "synthetic ordinary compound word",
          severity: "medium",
          boundaryJustification: "kept anchored on purpose — also mentions acmecorp here, which it must not",
        },
      ],
    });
    check(
      "flags a `boundaryJustification` field that contains another term's literal value",
      boundaryLeak.code === 1 &&
        (boundaryLeak.report?.findings ?? []).some((f) => f.rule === "self-containment" && f.index === 1),
      `expected a self-containment finding at index 1, got ${JSON.stringify(boundaryLeak.report?.findings)}`,
    );

    // Sanity (real coverage, not zero coverage): swapping which term's text
    // carries the leak moves the flagged index with it — proving the check
    // is actually comparing content pairwise, not hardcoded to one index.
    const swapped = runQuality({
      version: "t",
      terms: [
        { pattern: "zetaindustries", why: "this description mentions acmecorp by name, which it must not", severity: "medium" },
        { pattern: "acmecorp", why: "synthetic sibling product", severity: "high" },
      ],
    });
    check(
      "sanity: the flagged index follows the leak, not a fixed position — proving the scan inspects real content rather than passing on zero coverage",
      swapped.code === 1 && (swapped.report?.findings ?? []).some((f) => f.rule === "self-containment" && f.index === 0),
      `expected a self-containment finding at index 0, got ${JSON.stringify(swapped.report?.findings)}`,
    );

    // Clean: two terms whose text never references each other's value.
    const clean = runQuality({
      version: "t",
      terms: [
        { pattern: "acmecorp", why: "synthetic sibling product", severity: "high" },
        { pattern: "zetaindustries", why: "synthetic unrelated product, no overlap with anything else here", severity: "medium" },
      ],
    });
    check(
      "does not flag terms whose why text never contains another term's value",
      clean.code === 0 && !(clean.report?.findings ?? []).some((f) => f.rule === "self-containment"),
      `expected no self-containment finding, got ${JSON.stringify(clean.report?.findings)}`,
    );

    // ---------------------------------------------- coverage exclusion (audit)
    // Regression for the audit finding: a term whose pattern is a short
    // opaque handle (a single literal chunk under the 6-char threshold) is
    // excluded from the SOURCE side of the comparison on purpose — but that
    // exclusion must be REPORTED, never silent. Reproduced here with
    // invented values (never the real denylist): term #1 is the short
    // handle, term #2's `why` embeds it verbatim — the exact leak shape
    // issue #2 exists to catch, and the exact shape that must NOT read as
    // "self-containment ran and found nothing."
    const excludedLeak = runQuality({
      version: "t",
      terms: [
        { pattern: "qz7mx", why: "synthetic short opaque handle, sub-threshold on purpose", severity: "critical" },
        { pattern: "unrelatedfiller", why: "this description mentions the handle qz7mx by name, which it must not", severity: "high" },
      ],
    });
    check(
      "a sub-threshold term's value leaking into another term's why is NOT raised as a self-containment finding (the excluded case, not a false negative fix)",
      !(excludedLeak.report?.findings ?? []).some((f) => f.rule === "self-containment"),
      `expected no self-containment finding for the excluded source, got ${JSON.stringify(excludedLeak.report?.findings)}`,
    );
    check(
      "...but that exclusion IS reported, by index and reason, so the miss is visible rather than silent",
      (excludedLeak.report?.selfContainmentExcluded ?? []).some((e) => e.index === 0),
      `expected selfContainmentExcluded to name index 0, got ${JSON.stringify(excludedLeak.report?.selfContainmentExcluded)}`,
    );
    check(
      "the exclusion alone does not fail the run (would be noise on legitimate short terms)",
      excludedLeak.code === 0,
      `exit was ${excludedLeak.code}, expected 0 — an excluded term should not fail the run by itself`,
    );

    // The coverage line is unconditional: present even when nothing is
    // excluded, so "zero excluded" and "the field was never computed" are
    // also distinguishable.
    check(
      "selfContainmentExcluded is present (as an empty array) even when nothing is excluded",
      Array.isArray(clean.report?.selfContainmentExcluded) && clean.report.selfContainmentExcluded.length === 0,
      `expected an empty selfContainmentExcluded array, got ${JSON.stringify(clean.report?.selfContainmentExcluded)}`,
    );

    // self-scope coverage is reported unconditionally too (audited for the
    // same shape): every query in this block used a scope fixture with no
    // packages/ directory, so packageNamesFound must read 0 rather than
    // being silently absent from the report.
    check(
      "self-scope coverage counts are reported even when zero packages were found under packages/*",
      clean.report?.selfScopeCoverage?.packageNamesFound === 0 &&
        typeof clean.report?.selfScopeCoverage?.scopeAndPackageCandidates === "number",
      `expected selfScopeCoverage.packageNamesFound === 0, got ${JSON.stringify(clean.report?.selfScopeCoverage)}`,
    );
  }

  // ------------------------------------------- check-typechecked-assertions (issue #24)
  //
  // HERMETIC BY CONSTRUCTION: this gate's whole job is to shell out to a real
  // `tsc` binary, but the `safety` CI job that runs `check:gates` never runs
  // `npm ci` -- every script under scripts/ is zero-dependency Node
  // specifically so those gates can run with no install at all. Calling the
  // real toolchain from THIS suite would violate that on the spot. Every
  // case below instead points the gate at FOUNDRY_TYPECHECK_TSC_OVERRIDE, a
  // tiny stub tsc (a `#!/usr/bin/env node` script this suite writes and
  // chmods executable) that prints a scripted file list and exits with a
  // scripted code -- so what's under test is this gate's own parsing and
  // set-comparison logic, pinned against a known answer, never a real
  // compiler. A separate, single case further down (gated on a real tsc
  // actually being present, loudly SKIPped otherwise) proves the stub isn't
  // lying about what real tsc would say.
  console.log("\n# check-typechecked-assertions — inert type-level assertions (issue #24)");
  {
    const dir = join(work, "typechecked-assertions");
    mkdirSync(dir, { recursive: true });
    let stubCounter = 0;

    // A minimal but real tsconfig, shaped exactly like every package's own
    // (see packages/*/tsconfig.json): `**/*.test.ts` excluded from
    // `include`, which is the entire mechanism this gate exists to police.
    // Its CONTENT is cosmetic for the stubbed cases below (the stub, not a
    // real tsc, decides what "compiled" means for them) but it still has to
    // exist as a file, since the gate checks for that before ever invoking
    // tsc.
    const FIXTURE_TSCONFIG = JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          strict: true,
          skipLibCheck: true,
          outDir: "./dist",
          rootDir: "./src",
          noEmit: true,
        },
        include: ["src/**/*"],
        exclude: ["node_modules", "dist", "**/*.test.ts"],
      },
      null,
      2,
    );

    function makeFixturePackage(name) {
      const pkgDir = join(dir, name);
      mkdirSync(join(pkgDir, "src"), { recursive: true });
      writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: `${FIXTURE_SCOPE}/${name}`, version: "1.0.0" }));
      writeFileSync(join(pkgDir, "tsconfig.json"), FIXTURE_TSCONFIG);
      return pkgDir;
    }

    // Writes an executable stand-in for `tsc -p ... --listFilesOnly`: prints
    // `files` (already-absolute paths) one per line to stdout, then exits
    // `exitCode`. Real tsc's own --listFilesOnly output is exactly this
    // shape (a newline-separated file list, nothing else on success), so
    // this is a faithful stand-in for what this gate actually parses, not a
    // simplification of it.
    function makeStubTsc({ files = [], exitCode = 0, stderr = "" } = {}) {
      const stubPath = join(dir, `tsc-stub-${stubCounter++}.mjs`);
      const lines = [
        "#!/usr/bin/env node",
        `const files = ${JSON.stringify(files)};`,
        "for (const f of files) process.stdout.write(f + \"\\n\");",
        stderr ? `process.stderr.write(${JSON.stringify(stderr)});` : "",
        `process.exit(${exitCode});`,
        "",
      ];
      writeFileSync(stubPath, lines.join("\n"));
      chmodSync(stubPath, 0o755);
      return stubPath;
    }

    function runWithStub(pkgDir, stubPath, extraArgs = []) {
      return run("node", [TYPECHECKED, pkgDir, ...extraArgs], {
        env: { ...process.env, FOUNDRY_TYPECHECK_TSC_OVERRIDE: stubPath },
      });
    }

    // Happy path: a real `@ts-expect-error` living in a *.check.ts file (the
    // convention this gate is meant to protect). The stub reports it as
    // compiled -- exactly what real tsc would say, since *.check.ts falls
    // outside every package's own **/*.test.ts(x) exclude -- so it must
    // pass clean.
    {
      const pkgDir = makeFixturePackage("happy");
      const indexPath = join(pkgDir, "src", "index.ts");
      writeFileSync(indexPath, "export const x = 1;\n");
      mkdirSync(join(pkgDir, "src", "internal"), { recursive: true });
      const checkPath = join(pkgDir, "src", "internal", "contract.check.ts");
      writeFileSync(checkPath, '// @ts-expect-error -- fixture: a real, compiled contract check\nconst wrong: number = "not a number";\n');
      const stub = makeStubTsc({ files: [indexPath, checkPath] });
      const r = runWithStub(pkgDir, stub, ["--json"]);
      let report;
      try { report = JSON.parse(r.out); } catch { report = null; }
      check("passes a real assertion the stub reports as compiled", r.code === 0 && report?.ok === true, `exit ${r.code}: ${r.out.slice(0, 300)}`);
      check("counts the real assertion as protected, not a finding", report?.findings?.length === 0, `expected zero findings, got ${JSON.stringify(report?.findings)}`);
    }

    // The core regression: the exact same directive shape, but the stub
    // reports it as NOT compiled -- exactly what real tsc would say for a
    // *.test.ts file, since every package's tsconfig excludes it -- so it
    // must be caught.
    {
      const pkgDir = makeFixturePackage("inert");
      const indexPath = join(pkgDir, "src", "index.ts");
      writeFileSync(indexPath, "export const x = 1;\n");
      writeFileSync(
        join(pkgDir, "src", "index.test.ts"),
        [
          'import { describe, it } from "vitest";',
          'describe("x", () => {',
          '  it("is inert", () => {',
          "    // @ts-expect-error -- fixture: this directive is inert, index.test.ts is excluded from tsc",
          '    const wrong: number = "not a number";',
          "  });",
          "});",
          "",
        ].join("\n"),
      );
      // index.test.ts deliberately absent from the stub's file list -- the
      // stand-in for tsc excluding it, same as a real tsconfig would.
      const stub = makeStubTsc({ files: [indexPath] });
      const r = runWithStub(pkgDir, stub, ["--json"]);
      let report;
      try { report = JSON.parse(r.out); } catch { report = null; }
      check("catches a @ts-expect-error the stub reports as NOT compiled", r.code === 1 && report?.ok === false, `exit ${r.code}: ${r.out.slice(0, 300)}`);
      check(
        "names the exact inert file and line",
        (report?.findings ?? []).some((f) => f.file === "src/index.test.ts" && f.line === 4),
        `expected a finding at src/index.test.ts:4, got ${JSON.stringify(report?.findings)}`,
      );
    }

    // A comment that merely TALKS ABOUT the directive (backtick-quoted,
    // mid-sentence) must not be mistaken for the directive itself -- the
    // same shape as this repo's own packages/ui/src/atoms/Icon.test.tsx.
    // Regression guard for the gate's own false-positive rate. The stub's
    // file list is irrelevant here (no marker exists to misjudge either
    // way), so it just needs to be non-empty and valid.
    {
      const pkgDir = makeFixturePackage("prose");
      const indexPath = join(pkgDir, "src", "index.ts");
      writeFileSync(indexPath, "export const x = 1;\n");
      writeFileSync(
        join(pkgDir, "src", "index.test.ts"),
        [
          'import { it } from "vitest";',
          'it("mentions the directive without using it", () => {',
          "  // `@ts-expect-error` written here would be inert -- this comment",
          "  // just explains that, it is not itself a directive.",
          "  const ok: number = 1;",
          "});",
          "",
        ].join("\n"),
      );
      const stub = makeStubTsc({ files: [indexPath] });
      const r = runWithStub(pkgDir, stub, ["--json"]);
      let report;
      try { report = JSON.parse(r.out); } catch { report = null; }
      check("does not flag prose that only mentions @ts-expect-error", r.code === 0 && report?.ok === true, `exit ${r.code}: ${r.out.slice(0, 300)}`);
    }

    // Fail-closed: every way this gate can fail to determine an answer must
    // exit 2, never share an exit code with a real pass (0) or finding (1).
    const failClosedRuns = [];
    {
      // Missing tsconfig.json / missing src/ die BEFORE this gate ever looks
      // at a tsc binary (real or stubbed) -- no override needed, and these
      // stay hermetic in every environment on their own.
      const missingTsconfig = join(dir, "missing-tsconfig");
      mkdirSync(join(missingTsconfig, "src"), { recursive: true });
      writeFileSync(join(missingTsconfig, "package.json"), '{"name":"x"}');
      writeFileSync(join(missingTsconfig, "src", "index.ts"), "export const x = 1;\n");
      const r1 = run("node", [TYPECHECKED, missingTsconfig]);
      check("fails closed when tsconfig.json is missing", r1.code === 2, `exit was ${r1.code}`);
      failClosedRuns.push(r1);

      const missingSrc = join(dir, "missing-src");
      mkdirSync(missingSrc, { recursive: true });
      writeFileSync(join(missingSrc, "package.json"), '{"name":"x"}');
      writeFileSync(join(missingSrc, "tsconfig.json"), FIXTURE_TSCONFIG);
      const r2 = run("node", [TYPECHECKED, missingSrc]);
      check("fails closed when src/ is missing", r2.code === 2, `exit was ${r2.code}`);
      failClosedRuns.push(r2);

      // Stub exits non-zero, the same shape a real tsc hitting an
      // unparseable tsconfig.json would (see the real-tsc integration case
      // below for that exact scenario against the genuine binary).
      const brokenTsconfig = join(dir, "broken-tsconfig");
      mkdirSync(join(brokenTsconfig, "src"), { recursive: true });
      writeFileSync(join(brokenTsconfig, "package.json"), '{"name":"x"}');
      writeFileSync(join(brokenTsconfig, "tsconfig.json"), "not valid json");
      writeFileSync(join(brokenTsconfig, "src", "index.ts"), "export const x = 1;\n");
      const brokenStub = makeStubTsc({ exitCode: 1, stderr: "tsconfig.json(1,1): error TS1005: fixture parse failure\n" });
      const r3 = runWithStub(brokenTsconfig, brokenStub);
      check("fails closed when tsc exits non-zero (e.g. an unparseable tsconfig)", r3.code === 2, `exit was ${r3.code}`);
      failClosedRuns.push(r3);

      // Stub exits 0 but reports zero files under src/ -- the shape a real
      // tsconfig with an include pattern matching nothing would produce.
      const emptySrc = join(dir, "empty-src");
      mkdirSync(join(emptySrc, "src"), { recursive: true });
      writeFileSync(join(emptySrc, "package.json"), '{"name":"x"}');
      writeFileSync(join(emptySrc, "tsconfig.json"), FIXTURE_TSCONFIG);
      const emptyStub = makeStubTsc({ files: [] });
      const r4 = runWithStub(emptySrc, emptyStub);
      check("fails closed when tsc resolves zero files under src/", r4.code === 2, `exit was ${r4.code}`);
      failClosedRuns.push(r4);

      // The exact path CI's `safety` job exercises for real: no override,
      // and (in that job) no `node_modules/.bin/tsc` at all. Reproduced here
      // by pointing the override at a path that does not exist, which hits
      // the identical `!existsSync(tscBin)` branch the real no-install
      // environment hits -- deterministic and hermetic either way.
      const noTscBinary = join(dir, "no-tsc-binary");
      mkdirSync(join(noTscBinary, "src"), { recursive: true });
      writeFileSync(join(noTscBinary, "package.json"), '{"name":"x"}');
      writeFileSync(join(noTscBinary, "tsconfig.json"), FIXTURE_TSCONFIG);
      writeFileSync(join(noTscBinary, "src", "index.ts"), "export const x = 1;\n");
      const nonexistentTscPath = join(dir, "nonexistent", "tsc");
      const r5 = run("node", [TYPECHECKED, noTscBinary], {
        env: { ...process.env, FOUNDRY_TYPECHECK_TSC_OVERRIDE: nonexistentTscPath },
      });
      check("fails closed when the tsc binary itself is missing", r5.code === 2 && /no tsc binary/.test(r5.out), `exit ${r5.code}: ${r5.out.slice(0, 200)}`);
      failClosedRuns.push(r5);

      for (const r of failClosedRuns) {
        check("a fail-closed case never prints a bare PASS", !/^check-typechecked-assertions: OK\.$/m.test(r.out), "a fail-closed case's output looked like a pass");
      }
    }
  }

  // ---------------------------- check-typechecked-assertions: real-tsc integration
  //
  // Everything above pins this gate's OWN logic against a scripted stub. This
  // case is the other half: it proves the stub's contract (files it reports
  // as compiled are treated as protected, files it omits are treated as
  // inert) is what a REAL tsc actually does, not just what the stub claims.
  // Gated on a real tsc binary being present, since this suite otherwise has
  // to stay runnable with zero installs (see the header above this
  // sub-section). If it's absent, this SKIPs loudly -- printed unconditionally,
  // counted separately from pass/fail -- rather than being silently omitted,
  // which would be exactly the "looks green, checks nothing" failure class
  // this whole batch of issues is about.
  console.log("\n# check-typechecked-assertions — real tsc integration (proves the stub isn't lying)");
  {
    const realTscBin = join(repoRoot, "node_modules", ".bin", "tsc");
    if (!existsSync(realTscBin)) {
      skipped++;
      console.log(
        `  SKIP real-tsc integration case — no tsc binary at ${realTscBin} (this environment has no ` +
          `npm ci; exactly what CI's \`safety\` job looks like). The hermetic stub-based cases above still ` +
          `cover this gate's own logic. Re-run \`node scripts/test-gates.mjs\` after \`npm ci\` (e.g. CI's ` +
          `\`build\` job, or a normal local \`npm run check\`) to actually exercise this case.`,
      );
    } else {
      const dir = join(work, "typechecked-assertions-real");
      mkdirSync(dir, { recursive: true });

      // The real tsconfig shape every package in this repo actually ships,
      // not the stub-only fixture above -- this is what makes the case an
      // integration test of the real convention, not another unit test.
      const REAL_TSCONFIG = JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            module: "ESNext",
            moduleResolution: "Bundler",
            strict: true,
            skipLibCheck: true,
            outDir: "./dist",
            rootDir: "./src",
            noEmit: true,
          },
          include: ["src/**/*"],
          exclude: ["node_modules", "dist", "**/*.test.ts"],
        },
        null,
        2,
      );

      function makeRealFixture(name) {
        const pkgDir = join(dir, name);
        mkdirSync(join(pkgDir, "src"), { recursive: true });
        writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: `${FIXTURE_SCOPE}/${name}`, version: "1.0.0" }));
        writeFileSync(join(pkgDir, "tsconfig.json"), REAL_TSCONFIG);
        return pkgDir;
      }

      // No FOUNDRY_TYPECHECK_TSC_OVERRIDE set -- this invokes the gate's
      // default code path, the real node_modules/.bin/tsc, exactly as
      // production does.
      {
        const pkgDir = makeRealFixture("real-happy");
        writeFileSync(join(pkgDir, "src", "index.ts"), "export const x = 1;\n");
        mkdirSync(join(pkgDir, "src", "internal"), { recursive: true });
        writeFileSync(
          join(pkgDir, "src", "internal", "contract.check.ts"),
          '// @ts-expect-error -- fixture: a real, compiled contract check\nconst wrong: number = "not a number";\n',
        );
        const r = run("node", [TYPECHECKED, pkgDir, "--json"]);
        let report;
        try { report = JSON.parse(r.out); } catch { report = null; }
        check("[real tsc] passes a real assertion actually compiled by tsc", r.code === 0 && report?.ok === true, `exit ${r.code}: ${r.out.slice(0, 300)}`);
      }

      {
        const pkgDir = makeRealFixture("real-inert");
        writeFileSync(join(pkgDir, "src", "index.ts"), "export const x = 1;\n");
        writeFileSync(
          join(pkgDir, "src", "index.test.ts"),
          [
            'import { describe, it } from "vitest";',
            'describe("x", () => {',
            '  it("is inert", () => {',
            "    // @ts-expect-error -- fixture: this directive is inert, index.test.ts is excluded from tsc",
            '    const wrong: number = "not a number";',
            "  });",
            "});",
            "",
          ].join("\n"),
        );
        const r = run("node", [TYPECHECKED, pkgDir, "--json"]);
        let report;
        try { report = JSON.parse(r.out); } catch { report = null; }
        check(
          "[real tsc] catches a @ts-expect-error real tsc actually excludes",
          r.code === 1 && report?.ok === false && (report?.findings ?? []).some((f) => f.file === "src/index.test.ts"),
          `exit ${r.code}: ${r.out.slice(0, 300)}`,
        );
      }
    }
  }

  // ----------------- check-commit-messages: hash label survives a real MULTI-commit range
  //
  // The bug this guards against is invisible on a single commit — that's
  // exactly how it hid. `git log --format=%H%x01%B%x00` (the pre-fix format)
  // relies on %x00 as a record terminator, but `--format=` implies
  // `tformat:`, which always appends its OWN trailing "\n" after each
  // commit's expansion unless the format ends in %n. This one ends in %B, so
  // that automatic newline always fires — landing right after our %x00, i.e.
  // at the front of the NEXT record once split on \0. Every hash but the
  // newest commit's comes out prefixed with a stray "\n", which still slices
  // to a plausible-looking 12-character label, so nothing downstream ever
  // complains. A single-commit range never exercises the "next record"
  // boundary at all, so it can't catch this — which is precisely why this
  // case builds a real fixture repo with three commits and checks every one
  // of them, not just the tip.
  console.log("\n# check-commit-messages: reported hash label is correct across a multi-commit range");
  {
    const dir = join(work, "commit-messages-multi");
    mkdirSync(dir, { recursive: true });
    run("git", ["-C", dir, "init", "-q"]);
    run("git", ["-C", dir, "config", "user.email", "t@t"]);
    run("git", ["-C", dir, "config", "user.name", "t"]);
    // Every commit's message carries a synthetic denylist term (see
    // SYNTH_DENYLIST above) so every commit produces a finding, and every
    // finding's label is printed — that's the only way this gate ever
    // surfaces a hash to compare against reality.
    const commitMessages = [
      "first change: mentions acme-corp",
      "second change: mentions acme-corp",
      "third change: mentions acme-corp",
    ];
    for (let i = 0; i < commitMessages.length; i++) {
      writeFileSync(join(dir, `file-${i}.txt`), `content ${i}\n`);
      run("git", ["-C", dir, "add", "-A"]);
      run("git", ["-C", dir, "commit", "-qm", commitMessages[i]]);
    }
    const trueHashes = run("git", ["-C", dir, "log", "--format=%H"])
      .out.trim()
      .split("\n")
      .filter((h) => h.length > 0);
    check("fixture actually produced 3 commits", trueHashes.length === 3, `got ${trueHashes.length}: ${trueHashes.join(",")}`);

    const r = run("node", [COMMIT_MESSAGES, "HEAD", ...DL, "--require-denylist"], { cwd: dir });
    check(
      "gate reports FAIL (every commit's message matches the synthetic denylist term)",
      r.code === 1,
      `expected exit 1, got ${r.code}: ${r.out}`,
    );
    for (const trueHash of trueHashes) {
      const want = trueHash.slice(0, 12);
      check(
        `label for commit ${want} matches its real hash, not a corrupted one`,
        r.out.includes(`commit ${want}:`),
        `expected "commit ${want}:" in output, got:\n${r.out}`,
      );
    }
    // The corruption specifically glues a literal "\n" onto the front of the
    // hash — assert that never appears anywhere in a "commit " label line,
    // which is a more direct way of saying "no hash was split across two
    // printed lines."
    check(
      "no commit label contains an embedded newline",
      !/commit \n/.test(r.out),
      `found a "commit \\n..." label in output:\n${r.out}`,
    );
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log(
  `\n${failures.length ? "FAIL" : "PASS"} — ${passed} assertion(s) passed, ${failures.length} failed` +
    (skipped ? `, ${skipped} skipped (see SKIP line(s) above — not counted as passing).` : `.`),
);
process.exit(failures.length ? 1 : 0);
