// Regression tests for main-process safety rules (no Electron window, no agent turns, temp files only):
// S01 rules files fail closed, S02 agents start only on a subscription login, C08 a project cannot
// trust itself. Run from the repository root:  node scripts/test-main.mjs
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dirname, "..");
const require = createRequire(join(repo, "package.json"));
const { build } = require("esbuild");
const scratch = mkdtempSync(join(tmpdir(), "slashcad-test-main-"));
let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `  -- ${detail}` : ""}`);
  if (!ok) failures++;
};

try {
  await build({
    stdin: { contents: "export * from './src/main/design'; export * from './src/main/checks'; export * from './src/main/agents/billing'; export * from './src/main/project'; export * from './src/main/newProject'; export * from './src/main/pcbStep';", resolveDir: repo, loader: "ts" },
    outfile: join(scratch, "m.cjs"), bundle: true, platform: "node", format: "cjs", logLevel: "error",
    plugins: [{ name: "mock-electron", setup(b) {
      b.onResolve({ filter: /^electron$/ }, () => ({ path: "electron", namespace: "mock" }));
      b.onLoad({ filter: /.*/, namespace: "mock" }, () => ({ contents: `export const app = { getPath: () => ${JSON.stringify(join(scratch, "userData"))} };`, loader: "js" }));
    } }],
  });
  const m = require(join(scratch, "m.cjs"));

  // ---- S01: rules files fail closed
  const dir = join(scratch, "project");
  mkdirSync(dir);
  const p = { singleFile: null, stateDir: join(dir, ".slashcad"), abs: (n) => join(dir, n) };
  const rules = join(dir, "slashcad.rules.json");
  const read = (text) => { writeFileSync(rules, text); return m.readDesign(p); };

  let d = read("{ invalid");
  check("S01 invalid JSON is an error, not zero rules", !!d.error && d.unreadable && d.rules.length === 0, JSON.stringify(d));
  d = read(JSON.stringify({ version: 2, rules: [{ kind: "clearance", a: "x", b: "y", min: 1 }] }));
  check("S01 unknown file version is refused", !!d.error && d.unreadable, JSON.stringify(d));
  d = read(JSON.stringify({ version: 1, rules: [{ id: "typo", kind: "clearence", a: "x", b: "y", min: 1 }] }));
  check("S01 misspelled kind is an error", !!d.error && d.rules.length === 0, JSON.stringify(d));
  d = read(JSON.stringify({ version: 1, rules: [{ id: "nomin", kind: "clearance", a: "x", b: "y" }] }));
  check("S01 clearance without min is an error", !!d.error && /min/.test(d.error) && d.rules.length === 0, JSON.stringify(d));
  d = read(JSON.stringify({ version: 1, rules: [{ id: "zero", kind: "path_clear", part: "nut", direction: [0, 0, 0], distance: 5 }] }));
  check("S01 zero direction is an error", !!d.error && d.rules.length === 0, JSON.stringify(d));
  d = read(JSON.stringify({ version: 1, rules: [{ kind: "clearance", a: "x", b: "y", min: 0.2 }, { kind: "retained", part: "phone", within: 1 }] }));
  check("S01 valid rules are read, with ids", !d.error && d.rules.length === 2 && d.rules.every((r) => r.id), JSON.stringify(d));

  const broken = JSON.stringify({ version: 1, rules: [{ id: "keep", kind: "clearance", a: "x", b: "y" }] });
  writeFileSync(rules, broken);
  let threw = false;
  try { m.addRule(p, { kind: "clearance", a: "a", b: "b", min: 1 }); } catch { threw = true; }
  check("S01 adding a rule never rewrites a file with invalid rules", threw && readFileSync(rules, "utf8") === broken);

  const attemptedSweeps = [];
  const checks = new m.DesignChecks({ request: async (_cmd, opts) => { attemptedSweeps.push(opts); return {}; } }, new EventEmitter(), () => p);
  const motion = { param: "STROKE", from: 0, to: 1, step: 1 };
  let sweepError;
  try { await checks.runSweep(motion); } catch (error) { sweepError = error; }
  check("sweep with invalid rules fails before reaching the worker", !!sweepError && !attemptedSweeps.length);
  await checks.runSweep({ ...motion, useRules: false });
  check("explicit rules-off sweep still reaches the worker", attemptedSweeps.length === 1 && !attemptedSweeps[0].rules.length);

  rmSync(rules);
  await checks.runSweep(motion);
  check("a missing optional rules file still permits a sweep", attemptedSweeps.length === 2 && !attemptedSweeps[1].rules.length);

  mkdirSync(rules);
  d = m.readDesign(p);
  check("S01 a rules path that cannot be read is reported as an error", !!d.error && d.unreadable);
  sweepError = undefined;
  try { await checks.runSweep(motion); } catch (error) { sweepError = error; }
  check("a rules read error stops the sweep before reaching the worker", !!sweepError && attemptedSweeps.length === 2);
  rmSync(rules, { recursive: true });

  const pcbPath = join(scratch, "board.kicad_pcb"), stepPath = join(scratch, "board.step");
  const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
  writeFileSync(pcbPath, "native board");
  writeFileSync(stepPath, "STEP export");
  const binding = `${stepPath}.binding.json`;
  writeFileSync(binding, JSON.stringify({ format: "pcb-step-binding/1", pcb_source_sha256: sha("native board"), pcb_step_sha256: sha("STEP export") }));
  let match = await m.verifyPcbStepBinding(pcbPath, stepPath);
  check("PCB and STEP match the export record", match.pcbMatches && match.stepMatches);
  writeFileSync(pcbPath, "another board");
  match = await m.verifyPcbStepBinding(pcbPath, stepPath);
  check("PCB provenance mismatch is independent of STEP identity", !match.pcbMatches && match.stepMatches);
  writeFileSync(pcbPath, "native board");
  writeFileSync(stepPath, "another STEP");
  match = await m.verifyPcbStepBinding(pcbPath, stepPath);
  check("changed STEP is rejected for the same native board", match.pcbMatches && !match.stepMatches);
  writeFileSync(binding, JSON.stringify({ format: "unknown" }));
  let invalid;
  try { await m.verifyPcbStepBinding(pcbPath, stepPath); } catch (error) { invalid = error; }
  check("unknown binding format is rejected", !!invalid);

  // ---- S02: only a subscription login may start an agent
  const v = (kind, s) => m.subscriptionVerdict(kind, s).ok;
  check("S02 Claude with claude.ai is allowed", v("claude", { loggedIn: true, method: "claude.ai" }));
  check("S02 Codex with ChatGPT is allowed", v("codex", { loggedIn: true, method: "chatgpt" }));
  check("S02 Claude Console/API billing is refused", !v("claude", { loggedIn: true, method: "console", apiBilling: true }));
  check("S02 Codex API key is refused", !v("codex", { loggedIn: true, method: "apiKey" }));
  check("S02 an unknown method is refused", !v("claude", { loggedIn: true, method: "something" }));
  check("S02 not logged in is refused", !v("codex", { loggedIn: false }));
  check("S02 an unreadable status is refused", !v("claude", { loggedIn: false, error: "timeout" }) && !v("claude", null));

  // ---- C08: a project cannot mark itself as trusted
  const supplied = join(scratch, "supplied");
  mkdirSync(join(supplied, ".slashcad"), { recursive: true });
  writeFileSync(join(supplied, "main.py"), "from build123d import Box\n");
  writeFileSync(join(supplied, ".slashcad", "project.json"), JSON.stringify({ scene: ["main.py"], trusted: true }));
  const proj = new m.Project(supplied);
  check("C08 a trusted flag inside the project is ignored", proj.info.trusted === false && proj.buildableScene().length === 0, JSON.stringify(proj.info));
  proj.setTrusted(true);
  proj.dispose();
  const again = new m.Project(supplied);
  check("C08 the user's decision is remembered by the app", again.info.trusted === true);
  check("C08 the decision is not written into the project", !JSON.stringify(JSON.parse(readFileSync(join(supplied, ".slashcad", "project.json"), "utf8"))).includes("trusted"));
  again.dispose();

  // ---- N01: a new project has a starter main.py without geometry and never reuses a non-empty folder
  const bad = ["", " x", "x ", ".x", "x.", "a/b", "a\\b", "a:b", 'a"b', "a?", "con", "COM1", "x".repeat(65)];
  check("N01 non-portable project names are refused", bad.every((n) => !m.projectNameValid(n)));
  const parent = join(scratch, "new");
  const made = m.createCadProject(parent, "Ny låda 1");
  check("N01 a new project gets main.py", !!made.dir && readFileSync(join(made.dir, "main.py"), "utf8").includes("from slashcad import show"), JSON.stringify(made));
  check("N01 a non-empty folder is refused", m.createCadProject(parent, "Ny låda 1").error === "exists");
  check("N01 a relative location is refused", m.createCadProject("relative", "x").error === "parent");
  check("N01 the next free name is suggested", m.freeProjectName(parent, "Ny låda 1") === "Ny låda 1 2");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log(`\n${failures ? `${failures} failed` : "all passed"}`);
process.exit(failures ? 1 : 0);
