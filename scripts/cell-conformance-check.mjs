#!/usr/bin/env node
// Deterministic cell-conformance gate.
//
// Purpose: take the mechanically decidable half of a cell audit away from a seat, so a
// stopped seat delays only semantic judgement instead of stopping everything. This is
// the AI-native rule 7 shape — hard rules are script-enforced control points, and the
// LLM is not the enforcement layer.
//
// The reason this exists rather than reusing what agent-comms-mcp already has: that
// repo's Layer 0 checks `body.includes("Allowed paths")`. It requires the heading to be
// present. It never parses the declared paths and never compares them to the diff, and
// the declaration lives in the PR body, which the PR author writes. So the scope control
// that looks strongest on paper is, today, a check that a heading exists.
//
// Two rules follow from that, and this checker is built around them:
//
//   1. Scope is read from the CONTROL SOURCE, never from the PR. A PR that declares its
//      own allowed paths and is then checked against them is approving itself.
//   2. Undeterminable is not a pass. Missing scope, unreadable config, unparseable
//      declaration — all fail closed and route to a human.
//
// Honest limits, stated here so nobody sells this as more than it is:
//   - test co-change proves a test FILE changed, not that the change is tested
//   - body shape proves a section exists and is non-empty, not that its content is true
//   Both are cheap and worth having. Neither is a substitute for semantic review.
//
// Usage:
//   cell-conformance-check.mjs --config <path> --changed-files <path> --scope <path>
//                              [--pr-body <path>] [--format json|text]
//
// Exit: 0 all checks pass, 1 at least one fails, 2 usage or unreadable input.

import { readFileSync } from "node:fs";

const args = parseArgs(process.argv.slice(2));
const format = args.format ?? "text";
if (format !== "json" && format !== "text") usage("--format must be json or text");

const config = readJson(args.config, "--config");
const scope = readJson(args.scope, "--scope");
const changedFiles = readLines(args["changed-files"], "--changed-files");
const prBody = args["pr-body"] ? readText(args["pr-body"], "--pr-body") : null;

requireShape(config, "cell-conformance-config/v1", "config");
requireShape(scope, "cell-scope/v1", "scope");

const results = [];

// ── 1. every changed path is inside the scope declared at the control source ──────────
{
  const allowed = Array.isArray(scope.allowed_paths) ? scope.allowed_paths : null;
  if (!allowed || allowed.length === 0) {
    fail("scope", "the control source declares no allowed_paths; scope cannot be verified");
  } else if (changedFiles.length === 0) {
    fail("scope", "no changed files were supplied; scope cannot be verified");
  } else {
    const outside = changedFiles.filter((f) => !allowed.some((g) => globMatch(g, f)));
    if (outside.length > 0) {
      fail("scope", `${outside.length} changed path(s) fall outside the declared scope`, outside.slice(0, 20));
    } else {
      pass("scope", `all ${changedFiles.length} changed path(s) are inside ${allowed.length} declared allowed_paths`);
    }
  }
}

// ── 2. protected surfaces ─────────────────────────────────────────────────────────────
{
  const protectedGlobs = Array.isArray(config.protected_globs) ? config.protected_globs : null;
  if (!protectedGlobs) {
    fail("protected_surfaces", "config declares no protected_globs; cannot determine whether a protected surface was touched");
  } else {
    const touched = changedFiles.filter((f) => protectedGlobs.some((g) => globMatch(g, f)));
    if (touched.length > 0) {
      // Touching one is not automatically wrong — it is automatically a human's call.
      fail("protected_surfaces", `${touched.length} changed path(s) touch a protected surface; this cell requires owner review regardless of the other checks`, touched.slice(0, 20));
    } else {
      pass("protected_surfaces", `no changed path matches any of ${protectedGlobs.length} protected globs`);
    }
  }
}

// ── 3. test co-change (weak by construction; see the header) ──────────────────────────
{
  const srcGlobs = config.src_globs ?? [];
  const testGlobs = config.test_globs ?? [];
  if (srcGlobs.length === 0 || testGlobs.length === 0) {
    fail("test_cochange", "config declares no src_globs or no test_globs; cannot evaluate");
  } else {
    const srcTouched = changedFiles.filter((f) => srcGlobs.some((g) => globMatch(g, f)));
    const testTouched = changedFiles.filter((f) => testGlobs.some((g) => globMatch(g, f)));
    if (srcTouched.length === 0) {
      pass("test_cochange", "no source path changed, so no test co-change is required");
    } else if (testTouched.length === 0) {
      fail("test_cochange", `${srcTouched.length} source path(s) changed and no test path changed`, srcTouched.slice(0, 20));
    } else {
      pass("test_cochange", `${srcTouched.length} source and ${testTouched.length} test path(s) changed (file-level signal only, not proof of coverage)`);
    }
  }
}

// ── 4. PR body shape — presence and non-emptiness, never substance ────────────────────
if (prBody !== null) {
  const required = config.required_body_sections ?? [];
  if (required.length === 0) {
    pass("body_shape", "config requires no body sections");
  } else {
    const missing = [];
    const empty = [];
    for (const section of required) {
      const idx = prBody.indexOf(section);
      if (idx < 0) { missing.push(section); continue; }
      // Non-empty means: something other than whitespace follows the heading before the
      // next required heading or the end of the body. A heading with nothing under it is
      // exactly the failure mode the existing includes() check cannot see.
      const rest = prBody.slice(idx + section.length);
      const nextIdx = required
        .map((s) => rest.indexOf(s))
        .filter((i) => i > 0)
        .sort((a, b) => a - b)[0] ?? rest.length;
      if (rest.slice(0, nextIdx).replace(/[\s:>*_#-]/gu, "").length === 0) empty.push(section);
    }
    if (missing.length > 0 || empty.length > 0) {
      fail("body_shape", `${missing.length} section(s) missing, ${empty.length} present but empty`, [...missing.map((s) => `missing: ${s}`), ...empty.map((s) => `empty: ${s}`)]);
    } else {
      pass("body_shape", `all ${required.length} required section(s) present and non-empty (shape only; content is a semantic judgement)`);
    }
  }
} else {
  results.push({ check: "body_shape", status: "SKIP", detail: "--pr-body not supplied" });
}

// ── report ────────────────────────────────────────────────────────────────────────────
const failed = results.filter((r) => r.status === "FAIL");
if (format === "json") {
  process.stdout.write(JSON.stringify({
    schema_version: "cell-conformance-result/v1",
    cell_id: scope.cell_id ?? null,
    control_source: scope.control_source ?? null,
    changed_file_count: changedFiles.length,
    verdict: failed.length === 0 ? "PASS" : "FAIL",
    results,
  }, null, 2) + "\n");
} else {
  process.stdout.write(`cell conformance — ${scope.cell_id ?? "<no cell_id>"}\n\n`);
  for (const r of results) {
    process.stdout.write(`  ${r.status.padEnd(4)} ${r.check}: ${r.detail}\n`);
    for (const e of r.evidence ?? []) process.stdout.write(`         - ${e}\n`);
  }
  process.stdout.write(`\nverdict: ${failed.length === 0 ? "PASS" : "FAIL"} (${failed.length} failing)\n`);
}
process.exit(failed.length === 0 ? 0 : 1);

// ── helpers ───────────────────────────────────────────────────────────────────────────
function pass(check, detail) { results.push({ check, status: "PASS", detail }); }
function fail(check, detail, evidence) { results.push({ check, status: "FAIL", detail, ...(evidence ? { evidence } : {}) }); }

function usage(message) {
  process.stderr.write(`${message}\nusage: cell-conformance-check.mjs --config P --changed-files P --scope P [--pr-body P] [--format json|text]\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) usage(`unexpected argument: ${a}`);
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) usage(`--${key} requires a value`);
    out[key] = next;
    i += 1;
  }
  for (const required of ["config", "changed-files", "scope"]) {
    if (!out[required]) usage(`--${required} is required`);
  }
  return out;
}

function readText(path, label) {
  try { return readFileSync(path, "utf8"); }
  catch (error) { usage(`${label}: cannot read ${path}: ${error.message}`); }
}
function readJson(path, label) {
  const text = readText(path, label);
  try { return JSON.parse(text); }
  catch (error) { usage(`${label}: ${path} is not valid JSON: ${error.message}`); }
}
function readLines(path, label) {
  return readText(path, label).split(/\r?\n/u).map((l) => l.trim()).filter(Boolean);
}
function requireShape(obj, expected, label) {
  if (obj?.schema_version !== expected) usage(`${label}: schema_version must be ${expected}, got ${obj?.schema_version ?? "<none>"}`);
}

// Glob subset: `**/` spans zero or more directories, `**` spans anything, `*` stays
// inside one segment, `?` is one non-separator character.
//
// Written as a single left-to-right scan rather than chained replaces. The chained
// version was wrong: `core/**` collapsed to `^core/(?:.*/)?$`, which requires the path
// to end in a slash, so it matched no file at all. A matcher small enough to reason
// about is a requirement for a gate, not a style preference.
function globMatch(glob, path) {
  let rx = "";
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") { rx += "(?:[^/]+/)*"; i += 2; }
        else { rx += ".*"; i += 1; }
      } else {
        rx += "[^/]*";
      }
    } else if (c === "?") {
      rx += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(c)) {
      rx += `\\${c}`;
    } else {
      rx += c;
    }
  }
  return new RegExp(`^${rx}$`, "u").test(path);
}
