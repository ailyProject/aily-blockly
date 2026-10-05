// Run after building the host and Agent. Uses a disposable app profile and the
// product import API; only the imported copy is edited. Original mirrors are hashed.
// node scripts/abs-issue-audit.cjs --source /path/to/copied-draft-project --agent /path/to/aily-agent [--profile]
// node scripts/abs-issue-audit.cjs --playground-only
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
    "playground-only": { type: "boolean", default: false },
  },
});
if (!args["playground-only"] && (!args.source || !args.agent))
  throw Error(
    "--source and --agent are required. Source must contain a copied ABS draft.",
  );
const repo = path.resolve(__dirname, "..");
const agent = args.agent && path.resolve(args.agent);
const req = createRequire(path.join(repo, "package.json"));
const { _electron } = req("playwright");
const { createPackagedRendererServer } = req(
  "./electron/packaged-renderer-server",
);
const source = args.source && path.resolve(args.source);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "aily-issue-audit-"));
const appData = path.join(root, "app-data"),
  project = path.join(root, "Project Copy");
fs.mkdirSync(appData);
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
    rootDirectory: path.join(repo, "dist/aily-blockly/browser"),
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
  mark("playground");
  await page.evaluate(() =>
    window.ng
      .getComponent(document.querySelector("app-header"))
      .router.navigate(["/main/playground/list"]),
  );
  await page.locator("app-playground nz-tag").first().waitFor();
  // Login is optional on local project browsing; close its normal overlay.
  const close = page
    .locator(
      "app-login .close, app-login .close-btn, app-login .fa-xmark, app-login .login-close",
    )
    .first();
  if (await close.count()) await close.click({ timeout: 3000 }).catch(() => {});
  const tags = page.locator("app-playground nz-tag");
  const readTagStyles = () =>
    tags.evaluateAll((elements) =>
      elements.map((e) => {
        const style = getComputedStyle(e.querySelector(".ant-tag") || e);
        return {
          text: e.textContent.trim(),
          selected: e.getAttribute("aria-pressed") === "true",
          background: style.backgroundColor,
          color: style.color,
          outline: getComputedStyle(e).outlineStyle,
        };
      }),
    );
  const initialTags = await readTagStyles();
  assert.ok(initialTags.every((tag) => !tag.selected));
  const neutralColor = initialTags[0].background;
  assert.ok(initialTags.every((tag) => tag.background === neutralColor));
  const assertSelection = async (text) => {
    const styles = await readTagStyles();
    assert.deepEqual(
      styles.filter((tag) => tag.selected).map((tag) => tag.text),
      [text],
    );
    for (const tag of styles) {
      assert.equal(
        tag.background,
        tag.selected ? "rgb(115, 156, 25)" : neutralColor,
      );
      if (tag.selected) assert.equal(tag.color, "rgb(255, 255, 255)");
    }
    return styles;
  };
  for (const text of [
    "SenseCraft AI",
    "AI-VOX",
    "UNO R4",
    "ESP32S3",
    "程序设计基础",
  ]) {
    await tags.filter({ hasText: text }).click();
    await page.waitForTimeout(350);
    const styles = await assertSelection(text);
    assert.ok(
      styles.every((tag) => tag.outline === "none"),
      "mouse selection has no outline",
    );
  }
  const tag = page
    .locator("app-playground nz-tag")
    .filter({ hasText: "ESP32S3" });
  const colorBefore = await tag.evaluate(
    (e) => getComputedStyle(e.querySelector(".ant-tag") || e).backgroundColor,
  );
  await tag.click();
  await page.waitForTimeout(350);
  assert.equal(await tag.getAttribute("aria-pressed"), "true");
  const colorAfter = await tag.evaluate(
    (e) => getComputedStyle(e.querySelector(".ant-tag") || e).backgroundColor,
  );
  assert.equal(colorAfter, "rgb(115, 156, 25)");
  const other = page
    .locator("app-playground nz-tag")
    .filter({ hasText: "UNO R4" });
  await other.focus();
  await other.press("Enter");
  await page.waitForTimeout(350);
  assert.equal(await other.getAttribute("aria-pressed"), "true");
  assert.equal(await tag.getAttribute("aria-pressed"), "false");
  await assertSelection("UNO R4");
  await tag.focus();
  await tag.press("Space");
  await page.waitForTimeout(350);
  await assertSelection("ESP32S3");
  await other.click();
  await page.waitForTimeout(350);
  await page.locator("app-playground input[nz-input]").focus();
  report.playground = {
    initialTags,
    selectedTags: await assertSelection("UNO R4"),
    colorBefore,
    colorAfter,
  };
  await page.screenshot({ path: path.join(root, "playground.png") });
  await page.locator("app-playground input[nz-input]").fill("");
  await page.waitForTimeout(350);
  report.playground.clearedTags = await readTagStyles();
  assert.ok(
    report.playground.clearedTags.every(
      (tag) => !tag.selected && tag.background === neutralColor,
    ),
  );
  pass(
    "Issue 723 all tags use the original green background and white text when selected; click, Enter, Space, switching and clearing work",
  );
  if (args["playground-only"]) {
    report.success = true;
    return;
  }
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
          text: document.body.innerText.slice(-200),
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
  const call = async (name, args = {}) => {
    mark(name);
    await page.evaluate(() => {
      window.auditHeartbeat = { maxGapMs: 0, ticks: 0 };
      window.auditLastTick = performance.now();
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
    report.calls.push({
      heartbeat,
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
  await page.evaluate(() => {
    window.auditLongTasks = [];
    window.auditHeartbeat = { maxGapMs: 0, ticks: 0 };
    window.auditLastTick = performance.now();
    setInterval(() => {
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
  });
  if (args.profile) {
    cdp = await app.context().newCDPSession(page);
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.start");
  }
  const before = mirrors(project);
  const diagnosis = await call("project_recover", { action: "inspect" });
  report.diagnosis = diagnosis;
  assert.equal(diagnosis.ok, true, JSON.stringify(diagnosis));
  assert.ok(diagnosis.diagnostics.refresh, "Copied draft must expose refresh");
  const draft = fs.readFileSync(path.join(project, "project.abs"), "utf8");
  const refreshed = await call("project_recover", {
    action: "refresh",
    token: diagnosis.diagnostics.refresh.token,
  });
  assert.equal(refreshed.ok, true, JSON.stringify(refreshed));
  const read = await call("project_recover", {
    action: "read_draft",
    generation: refreshed.draftArchive.generation,
  });
  assert.equal(read.draft.abs, draft);
  assert.equal(mirrors(project)["project.abi"], before["project.abi"]);
  pass(
    "Copied draft archived byte-exact; fresh scope committed without ABI save",
  );
  const exported = refreshed;
  const validation = await call("abs_validate", {
    generation: exported.generation,
    abs: exported.abs,
    chunk: true,
  });
  report.largeValidation = validation;
  assert.equal(validation.ok, true, JSON.stringify(validation));
  const candidate = exported.abs.replace(
    /(^|\n)arduino_setup\(\)\n/,
    "$&    time_delay(math_number(200))\n",
  );
  assert.notEqual(
    candidate,
    exported.abs,
    "Observed setup root must be present",
  );
  const added = await call("abs_validate", {
    generation: exported.generation,
    abs: candidate,
    chunk: true,
  });
  report.addedValidation = added;
  assert.equal(added.ok, true, JSON.stringify(added));
  if (added.ok) {
    const applied = await call("abs_apply", {
      generation: exported.generation,
      abs: candidate,
      chunk: true,
    });
    report.applied = applied;
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(applied.applyVerification.ok, true);
    pass("Whole real project plus new delay commits through ABS");
  }

  mark("reopen-and-drag");
  const persisted = mirrors(project);
  await page.reload();
  await page.waitForFunction(
    () => {
      const el = document.querySelector("app-blockly-editor");
      const c = el && window.ng?.getComponent(el);
      return c?.projectService.getBlocklyProjectLoadStatus(
        c.projectService.currentProjectPath,
      )?.ready;
    },
    undefined,
    { timeout: 180000 },
  );
  const reopened = await page.evaluate(() => {
    const c = window.ng.getComponent(
      document.querySelector("app-blockly-editor"),
    );
    return c.blocklyService.workspace.getAllBlocks(false).length;
  });
  assert.equal(reopened, report.loaded.blocks + 2);
  assert.deepEqual(mirrors(project), persisted);
  pass("Saved candidate reopens with both added blocks and unchanged mirrors");

  await page.evaluate(() => {
    const dismiss = () =>
      document.querySelector("app-onboarding .btn-skip")?.click();
    new MutationObserver(dismiss).observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
    dismiss();
  });
  await page.waitForTimeout(500);
  await page
    .locator("app-login .login-close")
    .click({ timeout: 3000 })
    .catch(() => {});
  await page
    .locator(".login-modal-wrap")
    .waitFor({ state: "hidden", timeout: 5000 });
  report.drag = await page.evaluate(async () => {
    const c = window.ng.getComponent(
        document.querySelector("app-blockly-editor"),
      ),
      ws = c.blocklyService.workspace;
    const b = ws
      .getTopBlocks(false)
      .filter((b) => b.isMovable())
      .sort(
        (a, b) =>
          b.getDescendants(false).length - a.getDescendants(false).length,
      )[0];
    if (!b) return { skipped: "No movable root" };
    if (b.isCollapsed()) b.setCollapsed(false);
    const xy = b.getRelativeToSurfaceXY(),
      m = ws.getMetrics();
    ws.scroll(-xy.x * ws.scale + 150, -xy.y * ws.scale + 100);
    await new Promise((r) =>
      requestAnimationFrame(() => requestAnimationFrame(r)),
    );
    const shape =
        b.pathObject?.svgPath || b.getSvgRoot().querySelector(".blocklyPath"),
      r = shape.getBoundingClientRect();
    return {
      id: b.id,
      type: b.type,
      descendants: b.getDescendants(false).length,
      before: { x: xy.x, y: xy.y },
      point: {
        x: r.x + Math.min(r.width / 2, 35),
        y: r.y + Math.min(r.height / 2, 12),
      },
    };
  });
  if (report.drag.point) {
    const { x, y } = report.drag.point;
    report.drag.hit = await page.evaluate(
      ({ x, y }) => {
        const e = document.elementFromPoint(x, y);
        return {
          tag: e?.tagName,
          css: e?.getAttribute("class"),
          block: e?.closest("[data-id]")?.getAttribute("data-id"),
        };
      },
      { x, y },
    );
    await page.screenshot({ path: path.join(root, "before-drag.png") });
    assert.ok(
      x > 0 &&
        y > 0 &&
        x < (await page.evaluate(() => innerWidth)) &&
        y < (await page.evaluate(() => innerHeight)),
      "Drag target is visible",
    );
    await page.mouse.move(x, y);
    const start = Date.now();
    await page.mouse.down();
    await page.mouse.move(x + 80, y + 45, { steps: 8 });
    await page.mouse.up();
    await page.evaluate(
      () =>
        new Promise((r) =>
          requestAnimationFrame(() => requestAnimationFrame(r)),
        ),
    );
    report.drag.durationMs = Date.now() - start;
    report.drag.after = await page.evaluate((id) => {
      const b = window.ng
        .getComponent(document.querySelector("app-blockly-editor"))
        .blocklyService.workspace.getBlockById(id);
      const xy = b.getRelativeToSurfaceXY();
      return { x: xy.x, y: xy.y };
    }, report.drag.id);
    assert.notDeepEqual(report.drag.after, report.drag.before);
    pass("Real pointer drag moves the largest movable root");
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
