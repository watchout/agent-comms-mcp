#!/usr/bin/env node
// Deterministic cell-conformance gate, command-line front end.
//
// Purpose: take the mechanically decidable half of a cell audit away from a seat, so a
// stopped seat delays only semantic judgement instead of everything. This is the
// AI-native rule 7 shape — hard rules are script-enforced control points, and the LLM is
// not the enforcement layer.
//
// The decision logic lives in scripts/lib/cell-conformance.mjs so that this CLI and the
// Layer 0 gate decide identically.
//
// Two rules it is built around:
//   1. Scope is read from the CONTROL SOURCE, never from the pull request. A PR that
//      declares its own allowed paths and is then checked against them approves itself.
//   2. Undeterminable is not a pass. Missing scope, unreadable config, unparseable
//      declaration — all fail closed and route to a human.
//
// Honest limits, stated so nobody sells this as more than it is:
//   - test co-change proves a test FILE changed, not that the change is tested
//   - body shape proves a section exists and is non-empty, not that its content is true
//   Both are cheap and worth having. Neither replaces semantic review.
//
// Usage:
//   cell-conformance-check.mjs --config <path> --changed-files <path> --scope <path>
//                              [--pr-body <path>] [--format json|text]
//
// Exit: 0 all checks pass, 1 at least one fails, 2 usage or unreadable input.

import { readFileSync } from "node:fs";
import { CONFIG_SCHEMA, SCOPE_SCHEMA, evaluateConformance } from "./lib/cell-conformance.mjs";

const args = parseArgs(process.argv.slice(2));
const format = args.format ?? "text";
if (format !== "json" && format !== "text") usage("--format must be json or text");

const config = readJson(args.config, "--config");
const scope = readJson(args.scope, "--scope");
const changedFiles = readLines(args["changed-files"], "--changed-files");
const prBody = args["pr-body"] ? readText(args["pr-body"], "--pr-body") : null;

requireShape(config, CONFIG_SCHEMA, "config");
requireShape(scope, SCOPE_SCHEMA, "scope");

const { verdict, results } = evaluateConformance({ config, scope, changedFiles, prBody });

if (format === "json") {
  process.stdout.write(`${JSON.stringify({
    schema_version: "cell-conformance-result/v1",
    cell_id: scope.cell_id ?? null,
    control_source: scope.control_source ?? null,
    changed_file_count: changedFiles.length,
    verdict,
    results,
  }, null, 2)}\n`);
} else {
  process.stdout.write(`cell conformance — ${scope.cell_id ?? "<no cell_id>"}\n\n`);
  for (const r of results) {
    process.stdout.write(`  ${r.status.padEnd(4)} ${r.check}: ${r.detail}\n`);
    for (const e of r.evidence ?? []) process.stdout.write(`         - ${e}\n`);
  }
  const failing = results.filter((r) => r.status === "FAIL").length;
  process.stdout.write(`\nverdict: ${verdict} (${failing} failing)\n`);
}
process.exit(verdict === "PASS" ? 0 : 1);

// ── helpers ───────────────────────────────────────────────────────────────────────────
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
