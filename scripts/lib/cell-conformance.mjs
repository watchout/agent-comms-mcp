// Cell-conformance evaluation, as a library.
//
// Extracted so the CLI (`scripts/cell-conformance-check.mjs`) and the Layer 0 gate
// (`scripts/shirube-current-overlay-check.mjs`) decide identically. Two copies of the
// same rule drift, and a gate that disagrees with the report shown on the PR is worse
// than either alone.

export const CONFIG_SCHEMA = "cell-conformance-config/v1";
export const SCOPE_SCHEMA = "cell-scope/v1";

// Glob subset: `**/` spans zero or more directories, `**` spans anything, `*` stays
// inside one segment, `?` is one non-separator character.
//
// A single left-to-right scan rather than chained replaces. The chained version was
// wrong: `core/**` collapsed to `^core/(?:.*/)?$`, which requires the path to end in a
// slash, so it matched no file at all — a scope check that silently matches nothing
// reports every path as out of scope. Small enough to reason about is a requirement for
// a gate, not a style preference.
export function globMatch(glob, path) {
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

export function protectedPathsTouched(config, changedFiles) {
  const globs = Array.isArray(config?.protected_globs) ? config.protected_globs : null;
  if (!globs) return null; // null means "cannot determine", which is never a pass
  return changedFiles.filter((f) => globs.some((g) => globMatch(g, f)));
}

// Returns { verdict: "PASS"|"FAIL", results: [{check, status, detail, evidence?}] }
export function evaluateConformance({ config, scope, changedFiles, prBody = null }) {
  const results = [];
  const pass = (check, detail) => results.push({ check, status: "PASS", detail });
  const fail = (check, detail, evidence) => results.push({ check, status: "FAIL", detail, ...(evidence ? { evidence } : {}) });

  // 1. every changed path is inside the scope declared away from this pull request
  {
    const allowed = Array.isArray(scope?.allowed_paths) ? scope.allowed_paths : null;
    if (!allowed || allowed.length === 0) {
      fail("scope", "the control source declares no allowed_paths; scope cannot be verified");
    } else if (changedFiles.length === 0) {
      fail("scope", "no changed files were supplied; scope cannot be verified");
    } else {
      const outside = changedFiles.filter((f) => !allowed.some((g) => globMatch(g, f)));
      if (outside.length > 0) fail("scope", `${outside.length} changed path(s) fall outside the declared scope`, outside.slice(0, 20));
      else pass("scope", `all ${changedFiles.length} changed path(s) are inside ${allowed.length} declared allowed_paths`);
    }
  }

  // 2. protected surfaces
  {
    const touched = protectedPathsTouched(config, changedFiles);
    if (touched === null) {
      fail("protected_surfaces", "config declares no protected_globs; cannot determine whether a protected surface was touched");
    } else if (touched.length > 0) {
      // Touching one is not automatically wrong. It is automatically a human's call.
      fail("protected_surfaces", `${touched.length} changed path(s) touch a protected surface; this cell requires owner review regardless of the other checks`, touched.slice(0, 20));
    } else {
      pass("protected_surfaces", `no changed path matches any of ${config.protected_globs.length} protected globs`);
    }
  }

  // 3. test co-change — a file-level signal, never proof of coverage
  {
    const srcGlobs = config?.src_globs ?? [];
    const testGlobs = config?.test_globs ?? [];
    if (srcGlobs.length === 0 || testGlobs.length === 0) {
      fail("test_cochange", "config declares no src_globs or no test_globs; cannot evaluate");
    } else {
      const src = changedFiles.filter((f) => srcGlobs.some((g) => globMatch(g, f)));
      const tests = changedFiles.filter((f) => testGlobs.some((g) => globMatch(g, f)));
      if (src.length === 0) pass("test_cochange", "no source path changed, so no test co-change is required");
      else if (tests.length === 0) fail("test_cochange", `${src.length} source path(s) changed and no test path changed`, src.slice(0, 20));
      else pass("test_cochange", `${src.length} source and ${tests.length} test path(s) changed (file-level signal only, not proof of coverage)`);
    }
  }

  // 4. body shape — presence and non-emptiness, never substance
  if (prBody !== null) {
    const required = config?.required_body_sections ?? [];
    if (required.length === 0) {
      pass("body_shape", "config requires no body sections");
    } else {
      const missing = [];
      const empty = [];
      for (const section of required) {
        const idx = prBody.indexOf(section);
        if (idx < 0) { missing.push(section); continue; }
        const rest = prBody.slice(idx + section.length);
        const nextIdx = required.map((s) => rest.indexOf(s)).filter((i) => i > 0).sort((a, b) => a - b)[0] ?? rest.length;
        if (rest.slice(0, nextIdx).replace(/[\s:>*_#-]/gu, "").length === 0) empty.push(section);
      }
      if (missing.length > 0 || empty.length > 0) {
        fail("body_shape", `${missing.length} section(s) missing, ${empty.length} present but empty`,
          [...missing.map((s) => `missing: ${s}`), ...empty.map((s) => `empty: ${s}`)]);
      } else {
        pass("body_shape", `all ${required.length} required section(s) present and non-empty (shape only; content is a semantic judgement)`);
      }
    }
  } else {
    results.push({ check: "body_shape", status: "SKIP", detail: "prBody not supplied" });
  }

  return { verdict: results.some((r) => r.status === "FAIL") ? "FAIL" : "PASS", results };
}

// Whether the owner's standing authorization removes the per-head approval for a PR.
//
// Pure on purpose: the gate supplies the config it read and the PR facts, and this
// decides. Every condition must hold, and anything undeterminable is a refusal rather
// than a pass. Frozen-roadmap membership cannot be proven from a diff, so it is asserted
// by citing the decision — machine-checked for presence, and on the record if wrong.
//
// CI green is a condition of the decision but is not evaluated here: this runs inside
// one of the required checks and cannot report on its siblings. Required checks at the
// merge button enforce it.
export function evaluateStandingAuthorization({ config, changedFiles, labels, body, decisionId, decisionUrl }) {
  if (!config) {
    return { applies: false, reason: "the conformance config is absent, so protected surfaces cannot be determined" };
  }
  const touched = protectedPathsTouched(config, changedFiles);
  if (touched === null) {
    return { applies: false, reason: "the conformance config declares no protected_globs" };
  }
  if (touched.length > 0) {
    return { applies: false, reason: `changed paths touch a protected surface: ${touched.slice(0, 5).join(", ")}` };
  }
  if (labels.has("breaking-change-verified")) {
    return { applies: false, reason: "the PR is labelled breaking-change-verified" };
  }
  if (!body.includes(decisionId)) {
    return { applies: false, reason: `the PR body does not cite ${decisionId}` };
  }
  if (!body.includes(decisionUrl)) {
    return { applies: false, reason: "the PR body does not cite the published decision URL" };
  }
  return { applies: true, reason: "no protected surface touched, not a breaking change, decision cited by id and URL" };
}
