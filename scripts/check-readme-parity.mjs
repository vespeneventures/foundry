#!/usr/bin/env node
// check-readme-parity — a README is a promise about the package's public
// surface, and nothing in the toolchain checks that promise against reality.
//
//   node scripts/check-readme-parity.mjs <packageDir> [--json]
//
// Exit 0 = README matches reality. Exit 1 = findings. Exit 2 = cannot run.
//
// WHY THIS GATE EXISTS
// ---------------------
// An audit of this repo found two independent ways a README silently drifts
// from the code it documents, both of which are invisible to every other
// check here (typecheck, build, the safety/collision gates) because none of
// them read prose:
//
//   1. UNDOCUMENTED EXPORTS. package-a/src/index.ts exports `AreaChart` — an
//      entire chart component — plus four helpers/constants, none of which
//      appear anywhere in the README. A consumer reading the README has no
//      way to discover AreaChart exists. Exports get added to `index.ts` in
//      the same commit as the feature; nothing forces the README table to be
//      touched in that same commit, so it silently falls behind.
//
//   2. WRONG PACKAGE NAME IN EXAMPLES. A README's copy-pasteable
//      `import`/`npm install` lines are written by hand and are not checked
//      by anything the way source is. If a package is ever renamed, those
//      lines keep naming the old package: `npm install` fetches one thing
//      and the following `import` resolves nothing. The example reads as
//      authoritative precisely because it looks executable, so a stale one
//      is worse than no example at all.
//
// A third check (documented-but-nonexistent exports) is the mirror image of
// #1: it catches a README that describes something that used to exist, or
// was renamed, or was never real to begin with. Same root cause — the
// README and the export list are two independently-maintained lists of the
// same thing — different direction of drift.
//
// WHY EVERYTHING IS DERIVED, NOT HARDCODED
// ------------------------------------------
// This file ships in a public repo and is itself scanned by
// check-public-safety.mjs, which refuses any file containing the private
// scope/org name as a literal. That constraint turns out to produce a better
// script anyway: the scope and package name are read from package.json at
// run time, so this gate keeps working unchanged if the scope is ever
// renamed (see scripts/set-scope.mjs) or if a third package is added.

import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith("--")));
const positional = argv.filter((a) => !a.startsWith("--"));
const pkgDirArg = positional[0];

function die(msg, code = 2) {
  console.error(`check-readme-parity: ${msg}`);
  process.exit(code);
}

if (!pkgDirArg) {
  die("usage: check-readme-parity.mjs <packageDir> [--json]");
}

const pkgDir = resolve(pkgDirArg);
const manifestPath = join(pkgDir, "package.json");
const indexPath = join(pkgDir, "src", "index.ts");
const readmePath = join(pkgDir, "README.md");

if (!existsSync(manifestPath)) die(`no package.json at ${manifestPath}`);
if (!existsSync(indexPath)) die(`no src/index.ts at ${indexPath}`);
if (!existsSync(readmePath)) die(`no README.md at ${readmePath}`);

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
} catch (error) {
  die(`package.json does not parse: ${error.message}`);
}

const packageName = manifest.name;
if (typeof packageName !== "string" || !packageName.startsWith("@") || !packageName.includes("/")) {
  die(`package.json "name" (${JSON.stringify(packageName)}) is not a scoped name of the form "@scope/name"`);
}
const scope = packageName.slice(0, packageName.indexOf("/")); // e.g. "@scope"

const indexSrc = readFileSync(indexPath, "utf8");
const readmeSrc = readFileSync(readmePath, "utf8");
const readmeLines = readmeSrc.split("\n");

// --------------------------------------------------------------- CHECK A/C shared: parse exports

// Strip comments before scanning for `export` statements. Prose inside a
// block comment (package-b/src/index.ts opens with a long doc comment that
// mentions several export names in backticked prose) must not be mistaken
// for an actual export statement — it never contains the literal sequence
// `export {`/`export type {`/`export const` etc., but stripping comments
// first removes any doubt and matches what a reader would consider "real
// code" rather than documentation.
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

const code = stripComments(indexSrc);

// name -> { isType: boolean }. A name can only be introduced once by a
// well-formed index.ts, so last-write-wins is fine.
const exportsByName = new Map();

function recordExport(rawName, isType) {
  const name = rawName.trim();
  if (!name) return;
  exportsByName.set(name, { isType });
}

// Split a `{ ... }` export-list body on top-level commas and record each
// member. `blockIsType` is true for `export type { A, B }`; individual
// members can additionally be marked `type X` inside an otherwise-value
// block (`export { A, type B } from "./x.js"`), which is per-member type-only
// regardless of the block.
function recordExportList(body, blockIsType) {
  for (const rawMember of body.split(",")) {
    const member = rawMember.trim();
    if (!member) continue;
    let isType = blockIsType;
    let spec = member;
    if (/^type\s+/.test(spec)) {
      isType = true;
      spec = spec.replace(/^type\s+/, "");
    }
    // `A as B` — the name a consumer imports (and what a README should
    // mention) is the alias, B, not the original local name A.
    const asMatch = spec.match(/^(.+?)\s+as\s+(.+)$/);
    const exportedName = asMatch ? asMatch[2].trim() : spec.trim();
    recordExport(exportedName, isType);
  }
}

// `export { ... } from "..."` and `export type { ... } from "..."`, and the
// same two forms without a `from` clause (re-exports always have `from`
// here, but local named exports of already-declared bindings do not).
// Matching is non-greedy across `{...}` so multi-line export lists (used
// throughout both packages here) are captured whole.
const exportBlockRe = /export\s+(type\s+)?\{([\s\S]*?)\}(?:\s*from\s*["'][^"']*["'])?\s*;?/g;
for (const match of code.matchAll(exportBlockRe)) {
  const blockIsType = Boolean(match[1]);
  recordExportList(match[2], blockIsType);
}

// `export const F = ...` / `export function G(...)` / `export function* G`
// / `export class H`. Not used by either index.ts in this repo today (both
// are pure re-export barrels) but a barrel file gaining a direct declaration
// is a plausible future edit, and the task spec calls out this form
// explicitly as a real one to handle.
const directDeclRe = /export\s+(?:const|let|var|function\*?|class|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;
for (const match of code.matchAll(directDeclRe)) {
  recordExport(match[1], false);
}

const valueExports = [...exportsByName.entries()].filter(([, v]) => !v.isType).map(([name]) => name);
const typeExports = [...exportsByName.entries()].filter(([, v]) => v.isType).map(([name]) => name);
const allExportNames = new Set(exportsByName.keys());

// ------------------------------------------------------------------------- CHECK A

// A VALUE export is undocumented if its name does not appear ANYWHERE in the
// README text — not just the API table. Both READMEs here also mention
// exports in prose (e.g. "assignCategoricalColor(index) ... are exported"),
// so a substring search across the whole document, not just the table, is
// the right bar: it is permissive about WHERE a name is documented and
// strict about WHETHER it is documented at all.
const undocumentedValues = valueExports.filter((name) => !readmeSrc.includes(name));
const undocumentedTypes = typeExports.filter((name) => !readmeSrc.includes(name));

// ------------------------------------------------------------------------- CHECK B

// Any `@scope/something` reference on a line that looks like a copy-pasteable
// usage example (import/require/install), where "something" isn't exactly
// this package's real published name, is a broken example: the reader would
// `npm install` the right tarball and then have every `import` 404.
//
// Restricted to scope-prefixed references inside usage lines deliberately:
// a README may legitimately name another package of this scope in prose
// (describing a dependency, say), and that sentence is not something anyone
// copy-pastes into a terminal. Only import/require/install lines are checked.
const scopedNameRe = new RegExp(`${scope.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/[A-Za-z0-9._-]+`, "g");
// The `import` alternative needs a trailing boundary too, not just a leading
// one: a bare `\bimport` matches the first six letters of "important",
// "importance", "imported", etc., so ordinary prose ("...the single most
// important constraint...") sitting on the same line as an `@scope/other`
// reference was tripping this check. `(?![a-zA-Z])` requires the character
// after "import" not continue the word, while still matching real usage
// shapes: `import { x } from "..."`, `import * as x`, and `import(...)`.
const usageLineRe = /\bimport(?![a-zA-Z])|\brequire\(|(?:npm|pnpm|yarn)\s+(?:install|add|i)\b/i;

const wrongNameFindings = [];
readmeLines.forEach((line, i) => {
  if (!usageLineRe.test(line)) return;
  for (const found of line.match(scopedNameRe) ?? []) {
    if (found !== packageName) {
      wrongNameFindings.push({ line: i + 1, found, text: line.trim() });
    }
  }
});

// ------------------------------------------------------------------------- CHECK C

// Walk README.md's markdown table(s) inside the "## API" section (or any
// heading containing "API" — package-a and package-b both use "## API"
// but the check shouldn't break on a differently-worded heading) and flag
// any first-column identifier that doesn't correspond to a real export.
//
// Table rows are identified structurally (header row, then a separator row
// of only `-`/`:`/`|`/whitespace, then data rows) rather than by matching
// literal header text like "Export" — that keeps the check working whether
// the column is titled "Export", "Name", or anything else, and is what lets
// it correctly skip the header without special-casing its wording.
function findApiSectionLines() {
  const start = readmeLines.findIndex((l) => /^#{1,6}\s*.*\bAPI\b/i.test(l));
  if (start === -1) return null;
  let end = readmeLines.length;
  for (let i = start + 1; i < readmeLines.length; i++) {
    if (/^#{1,6}\s/.test(readmeLines[i])) {
      end = i;
      break;
    }
  }
  return [start + 1, end]; // exclusive of the heading itself
}

const separatorRowRe = /^\|?[\s:|-]+\|?$/;

function splitTableRow(line) {
  let body = line.trim();
  if (body.startsWith("|")) body = body.slice(1);
  if (body.endsWith("|")) body = body.slice(0, -1);
  return body.split("|").map((c) => c.trim());
}

// A cell can name one identifier (`` `ChartFrame` ``), several separated by
// " / " (`` `Grid` / `Axes` ``), or a call-shaped signature
// (`` `storageKey(spec)` `` — package-b's table style). Backticks are
// stripped per-token (splitting on "/" first) so a multi-name cell doesn't
// get mangled into "Grid` / `Axes", and only the leading identifier of each
// token is kept so `readJSON<T>(key, opts?)` resolves to `readJSON`.
function candidateIdentifiers(rawCell) {
  const out = [];
  for (let token of rawCell.split("/")) {
    token = token.trim().replace(/^`+|`+$/g, "").trim();
    if (!token) continue;
    // Prose, not an identifier: contains a space once backticks are gone
    // ("component" descriptions never land here, but a stray prose cell
    // would), or reads like a sentence fragment ("Not yet documented").
    if (/\s/.test(token)) continue;
    if (/^[A-Z][a-z]/.test(token) && / /.test(rawCell)) continue;
    const idMatch = token.match(/^[A-Za-z_$][A-Za-z0-9_$]*/);
    if (idMatch) out.push(idMatch[0]);
  }
  return out;
}

const nonexistentDocumented = [];
const apiSection = findApiSectionLines();
if (apiSection) {
  const [from, to] = apiSection;
  let sawSeparator = false;
  for (let i = from; i < to; i++) {
    const line = readmeLines[i];
    if (!line.trim().startsWith("|")) {
      sawSeparator = false; // table block ended; a later "|" line starts a new table (new header)
      continue;
    }
    if (!sawSeparator) {
      // This is a header row unless/until we see the separator row that
      // must follow it in a well-formed markdown table.
      const next = readmeLines[i + 1] ?? "";
      if (separatorRowRe.test(next.trim()) && next.includes("-")) {
        sawSeparator = true;
        // consume the separator on the next loop iteration too, harmlessly
        // (it will fail startsWith("|") check? no — it does start with "|").
        // Skip it explicitly so it is never treated as a data row.
        i++;
      }
      continue;
    }
    if (separatorRowRe.test(line.trim()) && line.includes("-")) continue; // stray separator, ignore
    const cells = splitTableRow(line);
    if (cells.length === 0) continue;
    const idsInFirstCell = candidateIdentifiers(cells[0]);
    for (const id of idsInFirstCell) {
      if (!allExportNames.has(id)) {
        nonexistentDocumented.push({ line: i + 1, name: id, text: line.trim() });
      }
    }
  }
}

// ------------------------------------------------------------------------ report

const findings = [
  ...undocumentedValues.map((name) => ({
    check: "A",
    severity: "high",
    message: `export "${name}" is not mentioned anywhere in README.md`,
  })),
  ...undocumentedTypes.map((name) => ({
    check: "A",
    severity: "low",
    message: `type "${name}" is not mentioned anywhere in README.md`,
  })),
  ...wrongNameFindings.map((f) => ({
    check: "B",
    severity: "high",
    file: "README.md",
    line: f.line,
    message: `import example uses "${f.found}", but the published package name is "${packageName}"`,
  })),
  ...nonexistentDocumented.map((f) => ({
    check: "C",
    severity: "medium",
    file: "README.md",
    line: f.line,
    message: `README documents "${f.name}", which is not an export of src/index.ts`,
  })),
];

const hasFailure = findings.some((f) => f.severity === "high" || f.severity === "medium");

if (flags.has("--json")) {
  console.log(
    JSON.stringify(
      {
        package: packageName,
        packageDir: pkgDirArg,
        findings,
        ok: !hasFailure,
      },
      null,
      2,
    ),
  );
  process.exit(hasFailure ? 1 : 0);
}

function printGroup(title, items) {
  if (items.length === 0) return;
  console.log(`\n${title}`);
  for (const f of items) {
    const loc = f.file ? ` (${f.file}:${f.line})` : "";
    console.log(`  [${f.severity}]${loc} ${f.message}`);
  }
}

console.log(`check-readme-parity: ${packageName}`);
printGroup("CHECK A — export coverage", findings.filter((f) => f.check === "A"));
printGroup("CHECK B — wrong package name in examples", findings.filter((f) => f.check === "B"));
printGroup("CHECK C — documented exports that don't exist", findings.filter((f) => f.check === "C"));

if (findings.length === 0) {
  console.log("\n  README matches reality: every export is documented, every example uses the real package name.");
}

console.log(
  hasFailure
    ? `\ncheck-readme-parity: FAIL — ${findings.filter((f) => f.severity !== "low").length} finding(s) at medium/high severity.`
    : `\ncheck-readme-parity: OK${findings.length ? " (informational findings only)" : ""}.`,
);

process.exit(hasFailure ? 1 : 0);
