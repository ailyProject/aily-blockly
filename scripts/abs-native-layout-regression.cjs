// Run after building the host and Agent. Uses a disposable app profile and the
// product import API; only the imported copy is edited. Original mirrors are hashed.
// node scripts/abs-native-layout-regression.cjs --source /path/to/project --agent /path/to/aily-agent --candidate /path/to/edit.abs [--direct-apply]
// --expect-failure records the old persisted-coordinate rejection without applying.
// --snapshots measures host full-snapshot count/time per tool call; no CPU sampling.
// --phases records native phase boundaries and host method totals (nested, not additive).
// --renderer-root selects a sealed build for alternating A/B runs without changing source.
// --warm-candidate validates a different draft first, without committing it.
// --verify-noop also applies a formatting-only edit and checks live instance reuse.
// --expect-noop-reload compares an older sealed build that still rebuilds on no-op.
// --trace captures Chromium CPU/timeline data including isolated candidate processes.
// Trace/profile runs are diagnostic, never comparable end-to-end timing samples.
// --generation-evidence compares existing isolated outputs with full host outputs;
// mismatch is recorded as a finding, never treated as partial-apply permission.
// --native-timeout once|always injects real watchdog failures, not a speed benchmark.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { createRequire } = require("node:module");
const { parseArgs } = require("node:util");
const { pathToFileURL } = require("node:url");
const { values: args } = parseArgs({
  options: {
    source: { type: "string" },
    agent: { type: "string" },
    profile: { type: "boolean", default: false },
    trace: { type: "boolean", default: false },
    snapshots: { type: "boolean", default: false },
    phases: { type: "boolean", default: false },
    "binding-evidence": { type: "boolean", default: false },
    "generation-evidence": { type: "boolean", default: false },
    "native-timeout": { type: "string" },
    "renderer-root": { type: "string" },
    heartbeat: { type: "boolean", default: false },
    "direct-apply": { type: "boolean", default: false },
    candidate: { type: "string" },
    "warm-candidate": { type: "string" },
    "verify-noop": { type: "boolean", default: false },
    "expect-noop-reload": { type: "boolean", default: false },
    "expect-failure": { type: "boolean", default: false },
    exports: { type: "string", default: "0" },
    compile: { type: "boolean", default: false },
    "npm-prefix": { type: "string" },
  },
});
if (!args.source || !args.agent || !args.candidate)
  throw Error(
    "--source, --agent and --candidate are required. Only an imported project copy is changed.",
  );
if (args['native-timeout'] && !['once', 'always'].includes(args['native-timeout'])) throw Error('Invalid --native-timeout mode');
const repeatedExports = Number(args.exports);
if (!Number.isInteger(repeatedExports) || repeatedExports < 0 || repeatedExports > 5) throw Error('--exports must be between 0 and 5');
const repo = path.resolve(__dirname, "..");
const rendererRoot = path.resolve(args['renderer-root'] || path.join(repo, 'dist/aily-blockly/browser'));
const agent = args.agent && path.resolve(args.agent);
const req = createRequire(path.join(repo, "package.json"));
const { _electron } = req("playwright");
const { createPackagedRendererServer } = req(
  "./electron/packaged-renderer-server",
);
const source = args.source && path.resolve(args.source);
// Full project imports retain evidence across runs. Refuse to exhaust the
// system disk; never silently delete older evidence or redirect to another drive.
const tempSpace = fs.statfsSync(os.tmpdir());
if (tempSpace.bavail * tempSpace.bsize < 3 * 1024 ** 3) {
  throw new Error(`At least 3 GiB of free temporary disk space is required: ${os.tmpdir()}. Free space before retrying; no test copy was created.`);
}
const root = fs.mkdtempSync(path.join(os.tmpdir(), "aily-abs-layout-"));
const appData = path.join(root, "app-data"),
  project = path.join(root, "Project Copy");
fs.mkdirSync(appData);
if (args["npm-prefix"]) {
  fs.symlinkSync(path.resolve(args["npm-prefix"]), path.join(appData, "npm-global"), "dir");
  const installedTools = path.join(path.dirname(path.resolve(args["npm-prefix"])), "tools");
  if (fs.existsSync(installedTools)) fs.symlinkSync(installedTools, path.join(appData, "tools"), "dir");
}
const config = req("./electron/config/config.json");
config.project_path = root;
config.appdata_path[process.platform] = appData;
fs.writeFileSync(path.join(appData, "config.json"), JSON.stringify(config));
const sha = (v) => createHash("sha256").update(v).digest("hex");
const mirrors = (p) =>
  Object.fromEntries(
    ["project.abi", "project.abs", "project.abs.map.json"].map((n) => [
      n,
      sha(fs.readFileSync(path.join(p, n))),
    ]),
  );
const original = source && mirrors(source);
const report = {
  root,
  source,
  project,
  original,
  rendererRoot,
  rendererIndexHash: sha(fs.readFileSync(path.join(rendererRoot, 'index.html'))),
  nativeRuntimeHash: sha(fs.readFileSync(path.join(rendererRoot, "blockly/runtime/native-candidate.js"))),
  candidatePath: path.resolve(args.candidate),
  candidateHash: sha(fs.readFileSync(args.candidate)),
  checks: [],
  calls: [],
  errors: [],
};
const save = () =>
  fs.writeFileSync(
    path.join(root, "result.json"),
    JSON.stringify(report, null, 2),
  );
let app,
  page,
  cdp,
  phase = "start";
const renderer = createPackagedRendererServer();
const mark = (p) => {
  phase = p;
  console.log("PHASE=" + p);
  save();
};
const pass = (s) => {
  report.checks.push(s);
  console.log("PASS=" + s);
  save();
};
(async () => {
  console.log("ROOT=" + root);
  await renderer.start({
    rootDirectory: rendererRoot,
  });
  const { ELECTRON_RUN_AS_NODE, ...env } = process.env;
  app = await _electron.launch({
    args: [".", "--serve", `--user-data-dir=${path.join(root, "profile")}`],
    cwd: repo,
    env: {
      ...env,
      AILY_E2E: "1",
      AILY_BUILD_PRODUCT: "blockly",
      AILY_APPDATA_PATH: appData,
      ...(args["npm-prefix"] ? { AILY_NPM_PREFIX: path.resolve(args["npm-prefix"]) } : {}),
    },
    timeout: 60000,
  });
  await app.context().route("http://localhost:4200/**", (route) =>
    route.fulfill({
      status: 302,
      headers: { location: renderer.rendererUrl("/main/guide") },
    }),
  );
  const until = Date.now() + 60000;
  while (!page && Date.now() < until) {
    for (const win of app.windows()) {
      if (
        await win
          .locator("app-main-window")
          .count()
          .catch(() => 0)
      ) {
        page = win;
        break;
      }
    }
    if (!page) await new Promise((r) => setTimeout(r, 200));
  }
  assert.ok(page, "main window");
  page.on("pageerror", (e) => {
    report.errors.push({ phase, message: e.message });
    save();
  });
  await page.goto(renderer.rendererUrl("/main/guide"));
  await page.waitForFunction(
    () => !!document.querySelector("app-header") && !!window.ng?.getComponent,
    undefined,
    { timeout: 60000 },
  );
  await page.evaluate(() => {
    const dismiss = () =>
      document.querySelector("app-onboarding .btn-skip")?.click();
    new MutationObserver(dismiss).observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
    dismiss();
    window.auditService = window.ng.getComponent(
      document.querySelector("app-header"),
    ).projectService;
  });
  mark("import-and-open");
  await page.evaluate(
    ({ source, project }) => {
      window.auditService.importProjectDirectory(source, project, false);
      window.auditOpen = { state: "pending" };
      window.auditService.projectOpen(project).then(
        (value) => (window.auditOpen = { state: "settled", value }),
        (error) =>
          (window.auditOpen = { state: "error", error: String(error) }),
      );
    },
    { source, project },
  );
  await page.waitForTimeout(1500);
  console.log(
    "OPEN_STATE=" +
      JSON.stringify(
        await page.evaluate(() => ({
          open: window.auditOpen,
          editorPresent: !!document.querySelector('app-blockly-editor'),
        })),
      ),
  );
  await page.screenshot({ path: path.join(root, "opening.png") });
  await page.waitForFunction(
    () => {
      const el = document.querySelector("app-blockly-editor");
      const c = el && window.ng.getComponent(el);
      return c?.projectService.getBlocklyProjectLoadStatus(
        c.projectService.currentProjectPath,
      )?.ready;
    },
    undefined,
    { timeout: 180000 },
  );
  report.loaded = await page.evaluate(() => {
    const c = window.ng.getComponent(
      document.querySelector("app-blockly-editor"),
    );
    return {
      blocks: c.blocklyService.workspace.getAllBlocks(false).length,
      status: c.projectService.getBlocklyProjectLoadStatus(),
    };
  });
  pass("Original project copy loads in actual Electron");
  if (args.phases) await page.evaluate(req('./scripts/lib/abs-phase-audit.cjs').installAbsPhaseAudit);
  if (args['binding-evidence']) await page.evaluate(() => { window.auditBindingEvidence = true; });
  if (args['generation-evidence']) await page.evaluate(req('./scripts/lib/abs-generation-audit.cjs').installAbsGenerationAudit);
  if (args.snapshots) await page.evaluate(() => {
    const editor = window.ng.getComponent(document.querySelector("app-blockly-editor")).blocklyService;
    const capture = editor.captureProjectSnapshot;
    editor.captureProjectSnapshot = function (...args) {
      const start = performance.now();
      try { return capture.apply(this, args); }
      finally {
        const stats = window.auditSnapshots;
        if (stats) { stats.count++; stats.ms += performance.now() - start; }
      }
    };
  });
  const { createBlocklyToolCatalog } = await import(
    pathToFileURL(path.join(agent, "dist/blockly/tools/definitions.js")).href
  );
  const { WorkspaceHistoryRuntime } = await import(
    pathToFileURL(
      path.join(agent, "dist/extensions/pi-workspace-history/runtime.js"),
    ).href
  );
  const agentWorkspace = path.join(root, "agent-workspace");
  fs.mkdirSync(agentWorkspace);
  const history = new WorkspaceHistoryRuntime(agentWorkspace);
  const catalog = createBlocklyToolCatalog(agentWorkspace, history);
  const measureSnapshots = args.snapshots;
  const measurePhases = args.phases;
  const measureGeneration = args['generation-evidence'];
  const call = async (name, args = {}) => {
    mark(name);
    await page.evaluate(() => {
      window.auditHeartbeat = { maxGapMs: 0, ticks: 0 };
      window.auditLastTick = performance.now();
      window.auditSnapshots = { count: 0, ms: 0 };
      window.auditPhases = { host: {}, native: [] };
      window.auditGeneration = { native: [], host: [] };
    });
    const t = Date.now();
    const r = await catalog
      .find((x) => x.name === name)
      .execute({ project, ...args });
    const result = r.structuredContent;
    const longTasks = await page.evaluate(
      () => window.auditLongTasks?.splice(0) || [],
    );
    const heartbeat = await page.evaluate(() => window.auditHeartbeat);
    const snapshots = measureSnapshots ? await page.evaluate(() => window.auditSnapshots) : undefined;
    const phases = measurePhases ? await page.evaluate(() => window.auditPhases) : undefined;
    const generation = measureGeneration ? await page.evaluate(() => window.auditGeneration) : undefined;
    report.calls.push({
      heartbeat,
      ...(snapshots ? { snapshots } : {}),
      ...(phases ? { phases } : {}),
      ...(generation ? { generation } : {}),
      name,
      durationMs: Date.now() - t,
      longTasks,
      result,
    });
    save();
    console.log(
      "RESULT=" +
        JSON.stringify({
          name,
          ok: result?.ok,
          code: result?.code,
          diagnostics: result?.diagnostics,
        }),
    );
    return result;
  };
  await page.evaluate((monitor) => {
    window.auditLongTasks = [];
    window.auditHeartbeat = { maxGapMs: 0, ticks: 0 };
    window.auditLastTick = performance.now();
    if (monitor) setInterval(() => {
      const now = performance.now();
      window.auditHeartbeat.maxGapMs = Math.max(
        window.auditHeartbeat.maxGapMs,
        now - window.auditLastTick,
      );
      window.auditHeartbeat.ticks++;
      window.auditLastTick = now;
    }, 50);
    new PerformanceObserver((list) => {
      for (const e of list.getEntries())
        window.auditLongTasks.push({
          start: e.startTime,
          duration: e.duration,
        });
    }).observe({ entryTypes: ["longtask"] });
  }, args.heartbeat);
  if (args.profile) {
    cdp = await app.context().newCDPSession(page);
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.start");
  }
  if (args.trace) await app.evaluate(({ contentTracing }) => contentTracing.startRecording({
    recording_mode: 'record-as-much-as-possible',
    included_categories: ['disabled-by-default-v8.cpu_profiler', 'v8', 'devtools.timeline'],
  }));
  const before = mirrors(project);
  const diagnosis = await call("project_recover", { action: "inspect" });
  assert.equal(diagnosis.ok, true, JSON.stringify(diagnosis));
  const exported = diagnosis.diagnostics?.refresh
    ? await call("project_recover", { action: "refresh", token: diagnosis.diagnostics.refresh.token })
    : await call("abs_export", diagnosis.diagnostics?.rebind ? { rebind: diagnosis.diagnostics.rebind.token } : {});
  assert.equal(exported.ok, true, JSON.stringify(exported));
  assert.equal(mirrors(project)["project.abi"], before["project.abi"]);
  for (let i = 0; i < repeatedExports; i++) {
    const previous = mirrors(project), repeated = await call('abs_export');
    assert.equal(repeated.ok, true, JSON.stringify(repeated));
    assert.equal(repeated.abs, exported.abs, 'Repeated export preserves the full source');
    assert.deepEqual(mirrors(project), previous, 'Verified repeated export must retain ABI/ABS/map bytes');
  }
  const readCode = () => page.evaluate(() => window.ng.getComponent(document.querySelector("app-blockly-editor"))
    .blocklyService.getGeneratedCode());
  const initialCode = await readCode();
  const candidate = fs.readFileSync(args.candidate, "utf8");
  assert.notEqual(candidate, exported.abs, "Regression must exercise a real edit");
  assert.equal(exported.abs, fs.readFileSync(path.join(source, "project.abs"), "utf8"), "Imported projection must match the source baseline");
  const withoutDelays = text => text.split("\n").filter(line => line.trim() !== "time_delay(math_number(200))").join("\n");
  assert.equal(withoutDelays(candidate), withoutDelays(exported.abs), "Fixture must only add delay statements");
  fs.writeFileSync(path.join(root, "candidate.abs"), candidate);
  if (args["warm-candidate"]) {
    const warm = fs.readFileSync(args["warm-candidate"], "utf8"), saved = mirrors(project);
    assert.notEqual(warm, candidate, "Warmup must use a different candidate, not a prepared handoff hit");
    assert.notEqual(warm, exported.abs);
    assert.equal(withoutDelays(warm), withoutDelays(exported.abs));
    const snapshot = () => page.evaluate(() => {
      const editor = window.ng.getComponent(document.querySelector("app-blockly-editor")).blocklyService;
      return JSON.stringify(editor.captureProjectSnapshot().document);
    });
    const state = await snapshot();
    const warmup = await call("abs_validate", { generation: exported.generation, abs: warm, chunk: true });
    report.calls[report.calls.length - 1].warmup = true;
    assert.equal(warmup.ok, true, JSON.stringify(warmup));
    assert.deepEqual(mirrors(project), saved, "Cross-candidate warmup must not modify project mirrors");
    assert.equal(await snapshot(), state, "Warmup must not alter the workspace");
    assert.equal(await readCode(), initialCode, "Warmup must not publish generated code");
    report.warmCandidateHash = sha(warm);
    pass("Different candidate validates without changing workspace, code or project mirrors");
  }
  const validateFirst = !args["direct-apply"] || args["expect-failure"] || args['native-timeout'];
  const captureFailureBoundary = () => page.evaluate(() => {
    const editor = window.ng.getComponent(document.querySelector('app-blockly-editor')).blocklyService;
    return JSON.stringify(editor.captureProjectSnapshot().document);
  });
  const validationBoundary = validateFirst ? { mirrors: mirrors(project), workspace: await captureFailureBoundary(), code: await readCode() } : undefined;
  if (args['native-timeout']) await page.evaluate(req('./scripts/lib/abs-timeout-fault.cjs').installAbsTimeoutFault, args['native-timeout']);
  const validation = validateFirst ? await call("abs_validate", { generation: exported.generation, abs: candidate, chunk: true }) : { ok: true };
  if (args['native-timeout']) {
    report.timeoutRecovery = await page.evaluate(() => window.absTimeoutFault.restore());
    assert.equal(report.timeoutRecovery.fired, args['native-timeout'] === 'once' ? 1 : 2);
    assert.equal(report.timeoutRecovery.cleanedUp, true);
    assert.ok(report.timeoutRecovery.cleanBeforeRealm.every(Boolean));
    if (args['native-timeout'] === 'always') assert.deepEqual(report.timeoutRecovery.budgets, [10000, 30000]);
    save();
  }
  const validationGeneration = validateFirst ? report.calls.at(-1)?.generation : undefined;
  if (!validation.ok && validationBoundary) {
    report.failedValidationUnchanged = {
      mirrors: JSON.stringify(mirrors(project)) === JSON.stringify(validationBoundary.mirrors),
      workspace: await captureFailureBoundary() === validationBoundary.workspace,
      code: await readCode() === validationBoundary.code,
    };
    save();
    assert.deepEqual(report.failedValidationUnchanged, { mirrors: true, workspace: true, code: true }, 'Rejected validation must not change the live workspace or published project');
  }
  if (args['native-timeout'] === 'always') {
    assert.equal(validation.ok, false); assert.equal(validation.code, 'ABS_NATIVE_TIMEOUT');
    assert.match(validation.recovery, /Do not loop/);
    assert.equal(fs.readFileSync(path.join(root, 'candidate.abs'), 'utf8'), candidate);
    pass('Two isolated timeouts stop preparation, preserve the candidate and leave workspace/code/mirrors unchanged');
    report.success = true;
    return;
  }
  if (args["expect-failure"]) {
    assert.equal(validation.ok, false);
    assert.equal(validation.code, "ABS_GENERATION_FAILED");
    assert.match(JSON.stringify(validation), /deferred UI task changed persisted state.*\/x/);
    assert.equal(mirrors(project)["project.abi"], before["project.abi"]);
    pass("Old runtime reproduces the saved-coordinate failure; ABI was not modified");
    report.success = true;
    return;
  }
  assert.equal(validation.ok, true, JSON.stringify(validation));
  if (validateFirst) pass("Candidate validates in the imported project");
  let preparedGeneration;
  const applied = await call("abs_apply", { generation: exported.generation, abs: candidate, chunk: true });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.applyVerification.ok, true);
  assert.equal(applied.publication.status, "COMMITTED");
  if (measureGeneration) {
    const actual = report.calls.at(-1).generation;
    const native = actual.native.length ? actual.native : validationGeneration?.native;
    report.generationComparison = { source: actual.native.length ? 'apply' : 'validate',
      ...req('./scripts/lib/abs-generation-audit.cjs').compareAbsGenerationEvidence(native, actual.host) };
    assert.notEqual(report.generationComparison.status, 'unavailable', 'Generation audit requires real evidence');
    preparedGeneration = actual.host[0];
    // A mismatch is diagnostic, not a failure of the existing supported full path.
    // Save raw evidence so the difference is inspectable instead of ignored.
    console.log('GENERATION_COMPARISON=' + JSON.stringify(report.generationComparison));
    save();
  }
  assert.equal(fs.readFileSync(path.join(project, "project.abs"), "utf8"), candidate);
  const roots = abi => [...(abi.blocks?.blocks || abi.pages?.[0]?.content?.blocks?.blocks || []), ...(abi.sharedModel?.procedureBlocks || [])];
  const beforeAbi = JSON.parse(fs.readFileSync(path.join(source, "project.abi"), "utf8"));
  const afterAbi = JSON.parse(fs.readFileSync(path.join(project, "project.abi"), "utf8"));
  report.abiKeys = Object.keys(afterAbi);
  report.rootCoordinates = roots(afterAbi).map(b => [b.id, b.x, b.y]);
  assert.ok(report.rootCoordinates.length, "Native ABI top roots must be inspected");
  assert.deepEqual(report.rootCoordinates, roots(beforeAbi).map(b => [b.id, b.x, b.y]));
  const index = abi => {
    const result = new Map(), parents = new Map(), pending = roots(abi).map(block => ({ block }));
    while (pending.length) {
      const { block, parent, edge } = pending.pop();
      assert.ok(!result.has(block.id), 'Persisted block identities remain unique');
      result.set(block.id, block);
      if (parent) parents.set(block.id, { parent, edge });
      for (const [name, input] of Object.entries(block.inputs || {})) for (const kind of ['block', 'shadow']) {
        if (input[kind]) pending.push({ block: input[kind], parent: block.id, edge: ['inputs', name, kind] });
      }
      if (block.next?.block) pending.push({ block: block.next.block, parent: block.id, edge: ['next', 'block'] });
    }
    result.parents = parents;
    return result;
  };
  const previousBlocks = index(beforeAbi), savedBlocks = index(afterAbi);
  const rebuilt = new Map();
  const savedEquivalent = id => {
    if (savedBlocks.has(id)) return savedBlocks.get(id);
    if (rebuilt.has(id)) return rebuilt.get(id);
    const previous = previousBlocks.get(id), connection = previousBlocks.parents.get(id);
    assert.ok(connection, `Existing root retained: ${id}`);
    const parent = previousBlocks.get(connection.parent);
    // Large real projects also contain identical ordinary subtrees.
    // Reconciliation may rebuild ambiguous unannotated blocks, but never accept their
    // disappearance: prove attributes AND their edge from the same parent.
    assert.ok(!['deletable', 'editable', 'movable', 'data', 'extraState'].some(key => Object.hasOwn(previous, key)),
      `Protected or annotated block must retain identity: ${id}`);
    const saved = connection.edge.reduce((node, key) => node?.[key], savedEquivalent(connection.parent));
    assert.ok(saved, `Existing block retained at its original connection: ${id}`);
    assert.ok(!previousBlocks.has(saved.id), 'A rebuilt block must not steal an existing identity');
    assert.ok(![...rebuilt.values()].some(block => block.id === saved.id), 'Equivalent blocks must remain one-to-one');
    rebuilt.set(id, saved);
    return saved;
  };
  for (const [id, previous] of previousBlocks) {
    const saved = savedEquivalent(id);
    const local = ({ id, inputs, next, ...attributes }) => attributes;
    const connection = ({ block, shadow, ...metadata } = {}) => metadata;
    assert.deepEqual(local(saved), local(previous), `All persisted attributes of ${id} unchanged`);
    for (const [name, input] of Object.entries(previous.inputs || {})) {
      assert.deepEqual(connection(saved.inputs?.[name]), connection(input), `Input metadata of ${id}/${name} unchanged`);
    }
    assert.deepEqual(connection(saved.next), connection(previous.next), `Next metadata of ${id} unchanged`);
  }
  report.preservedBlocks = previousBlocks.size;
  report.rebuiltEquivalentDelayBlocks = rebuilt.size;
  const delayDelta = (candidate.match(/time_delay\(math_number\(200\)\)/g) || []).length
    - (exported.abs.match(/time_delay\(math_number\(200\)\)/g) || []).length;
  report.expectedAddedBlocks = delayDelta * 2;
  const liveCount = () => page.evaluate(() => window.ng.getComponent(document.querySelector("app-blockly-editor"))
    .blocklyService.workspace.getAllBlocks(false).length);
  report.blocksAfter = await liveCount();
  assert.equal(report.blocksAfter, report.loaded.blocks + report.expectedAddedBlocks);
  const code = await readCode();
  const verifyPublishedGeneration = () => {
    if (!measureGeneration) return;
    assert.equal(preparedGeneration.code, code, 'Prepared code matches the published editor view');
    assert.equal(fs.readFileSync(path.join(project, '.temp/sketch/sketch.ino'), 'utf8'), code,
      'Prepared code matches the actual published build input');
    for (const artifact of preparedGeneration.artifacts || []) {
      assert.equal(path.basename(artifact.fileName), artifact.fileName, 'Artifact is a basename');
      assert.equal(fs.readFileSync(path.join(project, 'src', artifact.fileName), 'utf8'), artifact.content,
        `Published header matches prepared content: ${artifact.fileName}`);
    }
    report.publishedGeneration = { sketchHash: sha(code), artifacts: (preparedGeneration.artifacts || []).map(artifact =>
      ({ fileName: artifact.fileName, hash: sha(artifact.content) })) };
  };
  verifyPublishedGeneration();
  assert.ok(initialCode.trim() && code.trim(), 'The actual host must publish generated code');
  const delays = text => (text.match(/\bdelay\s*\(\s*200\s*\)\s*;/g) || []).length;
  assert.equal(delays(code) - delays(initialCode), delayDelta, 'Each added ABS delay reaches generated C++');
  report.generatedCode = { hash: sha(code), bytes: Buffer.byteLength(code), addedDelays: delayDelta };
  fs.writeFileSync(path.join(root, 'generated.cpp'), code);
  pass("Candidate commits all new delay blocks and preserves every existing root coordinate");
  if (args["verify-noop"]) {
    const abs = fs.readFileSync(path.join(project, "project.abs"), "utf8");
    const generation = JSON.parse(fs.readFileSync(path.join(project, "project.abs.map.json"), "utf8")).generation;
    const savedAbi = mirrors(project)["project.abi"];
    await page.evaluate(() => {
      const editor = window.ng.getComponent(document.querySelector("app-blockly-editor")).blocklyService;
      window.auditNoopBlocks = editor.workspace.getAllBlocks(false);
    });
    const result = await call("abs_apply", { generation, abs: abs + "\n# formatting-only regression\n", chunk: true });
    report.calls[report.calls.length - 1].noop = true;
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.publication.status, "COMMITTED");
    assert.equal(mirrors(project)["project.abi"], savedAbi);
    assert.equal(fs.readFileSync(path.join(project, "project.abs"), "utf8"), abs);
    assert.equal(await readCode(), code);
    report.noop = await page.evaluate(() => {
      const workspace = window.ng.getComponent(document.querySelector("app-blockly-editor")).blocklyService.workspace;
      const retained = window.auditNoopBlocks.every(block => workspace.getBlockById(block.id) === block);
      const count = window.auditNoopBlocks.length;
      delete window.auditNoopBlocks;
      return { retained, count };
    });
    const preservesInstances = !args["expect-noop-reload"];
    assert.equal(report.noop.retained, preservesInstances, "Zero-delta loading behavior matches the selected build");
    assert.equal(report.noop.count, report.blocksAfter);
    const phases = report.calls[report.calls.length - 1].phases?.host;
    if (phases && preservesInstances) {
      assert.equal(phases["workspace.load"]?.count || 0, 0);
      assert.equal(phases["workspace.append"]?.count || 0, 0);
    }
    if (phases && !preservesInstances) assert.ok(phases["workspace.load"]?.count > 0);
    pass(preservesInstances
      ? "Formatting-only apply preserves all instances, ABI, ABS and generated code without loading"
      : "Baseline formatting-only apply rebuilds instances but preserves ABI, ABS and generated code");
  }
  const persisted = mirrors(project);
  mark("reopen");
  await page.reload();
  await page.waitForFunction(() => {
    const el = document.querySelector("app-blockly-editor");
    const c = el && window.ng?.getComponent(el);
    return c?.projectService.getBlocklyProjectLoadStatus(c.projectService.currentProjectPath)?.ready;
  }, undefined, { timeout: 180000 });
  assert.equal(await liveCount(), report.blocksAfter);
  assert.deepEqual(mirrors(project), persisted);
  await page.waitForFunction(expected => {
    const c = window.ng?.getComponent(document.querySelector("app-blockly-editor"));
    return c?.blocklyService.getGeneratedCode() === expected;
  }, code, { timeout: 30000 });
  verifyPublishedGeneration();
  pass("Generated C++ includes the requested delays and remains identical after reopening");
  pass("Full edited project reopens with identical saved mirrors and block count");
  if (args.compile) {
    mark("wait-for-dependencies");
    await page.waitForFunction(() => {
      const el = document.querySelector("app-blockly-editor");
      const c = el && window.ng?.getComponent(el);
      return c?._builderService && !c._builderService.isInstallInProgress();
    }, undefined, { timeout: 180000 });
    const build = await call("project_build");
    assert.equal(build.ok, true, JSON.stringify(build));
    pass("Edited project compiles through the actual host build service");
  }
  await page.screenshot({ path: path.join(root, "project.png") });
  assert.deepEqual(mirrors(source), original);
  pass("Original ABI/ABS/map untouched");
  report.success = true;
})()
  .catch((e) => {
    report.failure = { phase, message: e.stack };
    console.error(e.stack);
    process.exitCode = 1;
  })
  .finally(async () => {
    report.originalAfter = source && mirrors(source);
    if (JSON.stringify(report.originalAfter) !== JSON.stringify(original)) {
      report.success = false;
      report.originalChanged = true;
      process.exitCode = 1;
    }
    if (args.trace && app) await app.evaluate(({ contentTracing }, target) => contentTracing.stopRecording(target),
      path.join(root, 'trace.json')).catch(error => console.error(error));
    if (cdp) {
      const cpu = await cdp.send("Profiler.stop").catch(() => null);
      if (cpu)
        fs.writeFileSync(
          path.join(root, "cpu.json"),
          JSON.stringify(cpu.profile),
        );
    }
    save();
    console.log("REPORT=" + path.join(root, "result.json"));
    if (app) {
      const process = app.process();
      await Promise.race([
        app.close().catch(() => {}),
        new Promise((r) => setTimeout(r, 5000)),
      ]);
      if (process.exitCode === null) process.kill("SIGKILL");
    }
    await renderer.close();
  });
