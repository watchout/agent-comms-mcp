#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import https from "node:https";
import path from "node:path";
import {
  isMain,
  parseArgs,
} from "./lib.mjs";

export const EXTERNAL_GATE_SUBJECT_SCHEMA = "shirube-external-gate-subject/v1";
export const EXTERNAL_GATE_SUBJECT_GENERATION_SCHEMA = "shirube-external-gate-subject-generation/v1";

const SHA_PATTERN = /^[a-f0-9]{40}$/i;
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MAX_HANDOFF_BYTES = 1024 * 1024;

export async function generateExternalGateSubject(options = {}) {
  const repo = stringOption(options.repo ?? options["actual-repo"]);
  const pr = positiveInteger(options.pr ?? options["target-pr"]);
  const handoffPath = stringOption(options.handoff ?? options["handoff-ref"]);
  const outputPath = path.resolve(stringOption(options.output) ?? "shirube-external-gate-subject.yaml");
  const tokenEnv = stringOption(options["github-token-env"]) ?? "GITHUB_TOKEN";
  const prFixture = stringOption(options["pr-fixture"]);
  const checkedOutHead = stringOption(options["checked-out-head"]);

  if (!repo || !REPO_PATTERN.test(repo)) throw new Error("--repo must be owner/name");
  if (!pr) throw new Error("--pr must be a positive integer");
  if (!handoffPath) throw new Error("--handoff is required");

  const handoffBytes = readFileSync(handoffPath);
  if (handoffBytes.byteLength === 0 || handoffBytes.byteLength > MAX_HANDOFF_BYTES) {
    throw new Error(`Exact handoff must be 1..${MAX_HANDOFF_BYTES} bytes`);
  }
  const handoff = parseStructuredBytes(handoffBytes);
  const cellId = handoffCellId(handoff);
  if (!cellId) throw new Error("The exact handoff bytes do not declare cell_id");

  const pullRequest = prFixture
    ? JSON.parse(readFileSync(prFixture, "utf8"))
    : await fetchJson({
        apiPath: `/repos/${repo}/pulls/${pr}`,
        token: requiredToken(tokenEnv),
        userAgent: "shirube-external-gate-subject-producer",
      });
  const observedRepo = pullRequest?.base?.repo?.full_name ?? pullRequest?.head?.repo?.full_name;
  const observedPr = positiveInteger(pullRequest?.number);
  const observedHead = String(pullRequest?.head?.sha ?? "").toLowerCase();
  if (normalizeRepo(observedRepo) !== normalizeRepo(repo) || observedPr !== pr) {
    throw new Error(`GitHub PR identity disagrees with requested target: ${observedRepo}#${observedPr}`);
  }
  if (!SHA_PATTERN.test(observedHead)) throw new Error("GitHub PR response is missing a valid exact head SHA");
  if (checkedOutHead && checkedOutHead.toLowerCase() !== observedHead) {
    throw new Error(`Checked-out target head ${checkedOutHead} differs from GitHub API head ${observedHead}`);
  }

  const subject = {
    schema_version: EXTERNAL_GATE_SUBJECT_SCHEMA,
    cell_id: cellId,
    repo,
    PR: pr,
    head: observedHead,
    gate_type: "PR_exact_head_audit",
    control_input_digest: sha256(handoffBytes),
    producer_observation: {
      api_origin: "api.github.com",
      api_version: "2022-11-28",
      target_pr_api_url: pullRequest.url ?? `https://api.github.com/repos/${repo}/pulls/${pr}`,
      observed_at: new Date().toISOString(),
    },
  };
  const bytes = Buffer.from(`${JSON.stringify(subject, null, 2)}\n`, "utf8");
  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, bytes, { flag: "wx" });

  return {
    schema_version: EXTERNAL_GATE_SUBJECT_GENERATION_SCHEMA,
    verdict: "PASS",
    target: { repo, PR: pr, head: observedHead },
    handoff: {
      path: handoffPath,
      cell_id: cellId,
      utf8_bytes: handoffBytes.byteLength,
      sha256: subject.control_input_digest,
    },
    subject,
    subject_path: outputPath,
    subject_utf8_bytes: bytes.byteLength,
    subject_sha256: sha256(bytes),
    caller_overrides_accepted: false,
    target_branch_mutated: false,
  };
}

function handoffCellId(handoff) {
  return firstPresent(
    handoff?.cell?.id,
    handoff?.cell?.["CELL-ID"],
    handoff?.cell?.cell_id,
    handoff?.cell_id,
    handoff?.CELL_ID,
    handoff?.control_handoff?.cell_id,
  );
}

function firstPresent(...values) {
  return values.find((value) => typeof value === "string" && value.trim().length > 0)?.trim() ?? null;
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function stringOption(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeRepo(value) {
  return String(value ?? "").trim().toLowerCase();
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseStructuredBytes(bytes) {
  const text = bytes.toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    const json = execFileSync("ruby", [
      "-ryaml",
      "-rjson",
      "-rdate",
      "-e",
      "body=YAML.safe_load(STDIN.read, permitted_classes:[Date,Time], aliases:false); puts JSON.generate(body)",
    ], { input: text, encoding: "utf8", maxBuffer: MAX_HANDOFF_BYTES * 2 });
    return JSON.parse(json);
  }
}

function requiredToken(name) {
  const token = process.env[name];
  if (!token) throw new Error(`${name} is not set`);
  return token;
}

function fetchJson({ apiPath, token, userAgent }) {
  return new Promise((resolve, reject) => {
    const request = https.request({
      hostname: "api.github.com",
      path: apiPath,
      method: "GET",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": userAgent,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`GitHub API ${response.statusCode}: ${body || response.statusMessage}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(new Error(`GitHub API returned invalid JSON: ${error.message}`));
        }
      });
    });
    request.on("error", reject);
    request.end();
  });
}

function usage() {
  process.stderr.write("Usage: node generate-external-gate-subject.mjs --repo <owner/name> --pr <number> --handoff <path> --output <path> [--checked-out-head <sha>] [--github-token-env <name>] [--pr-fixture <path>] --format json\n");
}

if (isMain(import.meta.url)) {
  const { options } = parseArgs(process.argv.slice(2));
  generateExternalGateSubject(options)
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => {
      usage();
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
