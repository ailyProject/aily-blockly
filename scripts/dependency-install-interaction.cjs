// Real Electron interaction regression, using a disposable product-imported copy.
// Build the host first, then: node scripts/dependency-install-interaction.cjs /path/to/project
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { _electron } = require("playwright");
const {
  createPackagedRendererServer,
} = require("../electron/packaged-renderer-server");
const repo = path.resolve(__dirname, "..");
if (!process.argv[2]) throw Error("Project source path required");
const source = path.resolve(process.argv[2]);
const root = fs.mkdtempSync(
  path.join(os.tmpdir(), "aily-dependency-interaction-"),
);
const appData = path.join(root, "app-data"),
  project = path.join(root, "Project Copy");
fs.mkdirSync(appData);
const config = require("../electron/config/config.json");
config.project_path = root;
config.appdata_path[process.platform] = appData;
fs.writeFileSync(path.join(appData, "config.json"), JSON.stringify(config));
const hash = (p) =>
  createHash("sha256")
    .update(fs.readFileSync(path.join(p, "project.abi")))
    .digest("hex");
const original = hash(source);
const report = { root, source, project, checks: [], errors: [] };
const save = () =>
  fs.writeFileSync(
    path.join(root, "result.json"),
    JSON.stringify(report, null, 2),
  );
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
let app,
  page,
  phase = "start";
const renderer = createPackagedRendererServer();
async function ready() {
  await page.waitForFunction(
    () => {
      const el = document.querySelector("app-blockly-editor");
      const c = el && window.ng?.getComponent(el);
      return c?.projectService.getBlocklyProjectLoadStatus()?.ready;
    },
    undefined,
    { timeout: 180000 },
  );
  await page.evaluate(() => {
    window.editor = window.ng.getComponent(
      document.querySelector("app-blockly-editor"),
    );
    const dismiss = () => {
      document.querySelector("app-onboarding .btn-skip")?.click();
      document.querySelector("app-login .login-close")?.click();
    };
    new MutationObserver(dismiss).observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
    dismiss();
  });
  await page
    .locator(".login-modal-wrap")
    .waitFor({ state: "hidden", timeout: 10000 });
}
async function drag(label) {
  const target = await page.evaluate(async () => {
    const ws = window.editor.blocklyService.workspace;
    const b = ws
      .getTopBlocks(false)
      .filter((b) => b.isMovable())
      .sort(
        (a, b) =>
          b.getDescendants(false).length - a.getDescendants(false).length,
      )[0];
    if (!b) throw Error("No movable block");
    if (b.isCollapsed()) b.setCollapsed(false);
    const xy = b.getRelativeToSurfaceXY();
    ws.scroll(-xy.x * ws.scale + 150, -xy.y * ws.scale + 100);
    await new Promise((r) =>
      requestAnimationFrame(() => requestAnimationFrame(r)),
    );
    const box = b.pathObject.svgPath.getBoundingClientRect();
    return {
      id: b.id,
      before: { x: xy.x, y: xy.y },
      point: { x: box.x + 35, y: box.y + 12 },
      descendants: b.getDescendants(false).length,
      mask: !!document.querySelector(".blockly-spin"),
      editing: window.editor.blocklyService.isWorkspaceEditInProgress(),
      installing: window.editor.npmService.isInstalling,
    };
  });
  assert.equal(target.mask, false, label + ": canvas mask");
  assert.equal(target.editing, false, label + ": input fence");
  await page.mouse.move(target.point.x, target.point.y);
  await page.mouse.down();
  await page.mouse.move(target.point.x + 80, target.point.y + 45, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  target.after = await page.evaluate((id) => {
    const xy = window.editor.blocklyService.workspace
      .getBlockById(id)
      .getRelativeToSurfaceXY();
    return { x: xy.x, y: xy.y };
  }, target.id);
  assert.notDeepEqual(
    target.after,
    target.before,
    label + ": pointer drag must move block",
  );
  await page.screenshot({ path: path.join(root, label + ".png") });
  pass(label + ": actual pointer drag moves block without mask");
  return target;
}
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

  mark("background-install");
  await page.evaluate(
    ({ source, project }) => {
      window.auditService.importProjectDirectory(source, project, false);
      void window.auditService.projectOpen(project);
    },
    { source, project },
  );
  await ready();
  await page.waitForFunction(
    () => window.editor.npmService.isInstalling,
    undefined,
    { timeout: 30000 },
  );
  report.backgroundInstall = await drag("background-install");
  assert.equal(
    report.backgroundInstall.installing,
    true,
    "Real dependency install must be running during drag",
  );
  // Stop only this disposable project's real install before the deterministic switch scenario.
  await page.evaluate(() =>
    window.auditService.stopProjectCommands(
      window.auditService.currentProjectPath,
    ),
  );
  await page.waitForFunction(() => !window.editor.npmService.isInstalling);
  mark("board-install-wait");
  const targetBoard = await page.evaluate(async () => {
    const p = window.auditService;
    await p.configService.loadBoardList();
    const current = await p.getBoardModule();
    const target = Object.values(p.configService.boardDict).find(
      (b) => b.name !== current && b.mode?.includes("arduino"),
    );
    if (!target) throw Error("No alternate Arduino board");
    const cmd = p.cmdService,
      original = cmd.runAsyncChecked;
    // Keep the real native board-switch lifecycle, save and IPC path. Hold only
    // the external npm transport so interaction does not depend on network speed.
    cmd.runAsyncChecked = (...args) => {
      window.installCommand = args;
      return new Promise((_, reject) => {
        window.finishInstallWait = () => {
          cmd.runAsyncChecked = original;
          reject(new Error("Intentional fixture install cancellation"));
        };
      });
    };
    return target.name;
  });
  await app.evaluate(
    ({ BrowserWindow, ipcMain }, { project, targetBoard }) => {
      const window = BrowserWindow.getAllWindows().find((w) =>
        w.webContents.getURL().includes("/main/blockly-editor"),
      );
      globalThis.dependencyAuditResult = null;
      const handler = (_event, payload) => {
        if (payload.requestId === "dependency-mask-audit") {
          globalThis.dependencyAuditResult = payload;
          ipcMain.removeListener(
            "cli-bridge:blockly-live-operation:response",
            handler,
          );
        }
      };
      ipcMain.on("cli-bridge:blockly-live-operation:response", handler);
      window.webContents.send("cli-bridge:blockly-live-operation", {
        requestId: "dependency-mask-audit",
        path: project,
        operation: "board_switch",
        params: { boardName: targetBoard },
      });
    },
    { project, targetBoard },
  );
  await page.waitForFunction(() => !!window.finishInstallWait, undefined, {
    timeout: 60000,
  });
  await page.waitForTimeout(400); // wait for the preceding native save's mask fade
  report.boardInstall = await drag("board-install-wait");
  await page.evaluate(() => window.finishInstallWait());
  for (let i = 0; i < 100; i++) {
    report.boardResult = await app.evaluate(
      () => globalThis.dependencyAuditResult,
    );
    if (report.boardResult) break;
    await page.waitForTimeout(100);
  }
  assert.match(
    report.boardResult?.message || "",
    /Intentional fixture install cancellation/,
  );
  mark("persist-edits-and-reload");
  await page.evaluate(() => {
    window.reloadResult = null;
    window.auditService
      .reloadAfterBoardSwitch(window.auditService.currentProjectPath)
      .then(
        () => (window.reloadResult = "ok"),
        (e) => (window.reloadResult = String(e)),
      );
  });
  await page.waitForFunction(() => window.reloadResult !== null, undefined, {
    timeout: 180000,
  });
  assert.equal(await page.evaluate(() => window.reloadResult), "ok");
  await ready();
  report.reloadedPosition = await page.evaluate((id) => {
    const b = window.editor.blocklyService.workspace.getBlockById(id);
    const xy = b.getRelativeToSurfaceXY();
    return { x: xy.x, y: xy.y };
  }, report.boardInstall.id);
  assert.deepEqual(report.reloadedPosition, report.boardInstall.after);
  pass("Edits made during board installation survive native save and reload");
  mark("write-protection");
  await page.evaluate(() => {
    window.auditLease =
      window.editor.blocklyService.acquireWorkspaceEditLease();
  });
  await page.waitForSelector(".blockly-spin.show");
  assert.equal(
    await page.evaluate(() =>
      window.editor.blocklyService.isWorkspaceEditInProgress(),
    ),
    true,
  );
  await page.evaluate(() => window.auditLease.release());
  await page.waitForSelector(".blockly-spin", { state: "detached" });
  pass(
    "Actual workspace writes still activate and release the input fence and mask",
  );
  assert.equal(hash(source), original);
  report.success = true;
})()
  .catch((e) => {
    report.failure = { phase, message: e.stack };
    console.error(e.stack);
    process.exitCode = 1;
  })
  .finally(async () => {
    report.originalUnchanged = hash(source) === original;
    save();
    console.log("REPORT=" + path.join(root, "result.json"));
    if (app) {
      const owned = app.process();
      await Promise.race([
        app.close().catch(() => {}),
        new Promise((r) => setTimeout(r, 5000)),
      ]);
      if (owned.exitCode === null) owned.kill("SIGKILL");
    }
    await renderer.close();
  });
