import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs, promisify } from "node:util";
import { execFile } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { _electron } from "@playwright/test";
import {
  createLocalChatApiRouter,
  prepareInstalledChatProfile,
  assertInstalledChatLoaded,
} from "../fixtures/installed-chat-ui.mjs";
import { loadEnvironmentSaveResume } from "./fixtures/r2-environment-resume.mjs";
import {
  waitForColdSessionOpen,
  sourceHash,
} from "./fixtures/abs-cold-continuity.mjs";
import {
  assertCapturedEnvironmentProcess,
  remainingEnvironmentProcesses,
  environmentProcessStopScript,
  selectEnvironmentProcessTree,
} from "./fixtures/r2-environment-cleanup.mjs";

// Sealed artifact, same original suite, no model and no tool replay. Only the
// actual GUI menu save remains after the original ABC publication succeeded.
const repo = fileURLToPath(new URL("../../", import.meta.url)),
  names = [
    "executable-path",
    "installed-root",
    "lex-root",
    "resource-root",
    "test-root",
    "output",
    "expected-input-hash",
    "resume-save-result",
  ];
const { values } = parseArgs({
  options: Object.fromEntries(names.map((name) => [name, { type: "string" }])),
});
assert.equal(process.env.AILY_R2_ENVIRONMENT_HOST_WINDOW, "1");
for (const name of names.filter((name) => name !== "expected-input-hash"))
  assert.ok(path.isAbsolute(values[name] ?? ""), name);
const inside = (root, file) => {
  const relative = path.relative(root, file);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
};
const same = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
assert.ok(inside(path.join(repo, "e2e/test-results"), values.output));
assert.ok(
  inside(path.join(values["resource-root"], "dev-tests"), values["test-root"]),
);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex"),
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  exec = promisify(execFile);
const { verifyPortableBuild } = await import(
  pathToFileURL(
    path.join(
      values["lex-root"],
      "packages/aily-chat/server/portable-integrity.ts",
    ),
  )
);
const artifact = await verifyPortableBuild(values["installed-root"]);
assert.equal(artifact.inputHash, values["expected-input-hash"]);
const asar = path.join(
    path.dirname(values["executable-path"]),
    "resources/app.asar",
  ),
  hostHash = sha(await fs.readFile(asar));
const resume = await loadEnvironmentSaveResume({
  resultFile: values["resume-save-result"],
  testRoot: values["test-root"],
  artifact,
  hostHash,
});
const { suite, project, sessionId, expected } = resume,
  appData = path.join(suite, "appdata"),
  home = path.join(suite, "home"),
  temp = path.join(suite, "temp");
await fs.mkdir(values.output, { recursive: false });
const evidence = {
  ok: false,
  tailOk: false,
  combinedSameSuite: true,
  standalonePass: false,
  suite,
  project,
  sessionId,
  artifact,
  hostHash,
  sourceQualification:
    "Sealed Host13/Chat10 only; current Lex source equality is intentionally not a requirement for GUI-only continuation.",
  currentLexSourceCompared: false,
  modelRequests: 0,
  paidModelRequests: 0,
  toolReplays: 0,
  manualProjectOpen: false,
  manualSessionOpen: false,
  resumedProvenance: resume.provenance,
  phases: [],
  sessionCommands: [],
  sessionResponses: [],
  startedAt: new Date().toISOString(),
};
const persist = () =>
  fs.writeFile(
    path.join(values.output, "result.json"),
    JSON.stringify(evidence, null, 2),
  );
const phase = async (name) => {
  console.log("PHASE=" + name);
  evidence.phases.push({ name, at: Date.now() });
  await persist();
};
const processes = async () => {
  const result = await exec(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath,@{Name='CreationDate';Expression={$_.CreationDate.ToUniversalTime().ToString('o')}} | ConvertTo-Json -Compress",
    ],
    { windowsHide: true, timeout: 15000 },
  );
  const all = JSON.parse(result.stdout);
  return Array.isArray(all) ? all : [all];
};
const ownedTree = async (pid) => {
  assert.equal(identity?.ProcessId, pid);
  return selectEnvironmentProcessTree(await processes(), identity);
};
let app,
  page,
  loaded,
  router,
  hostPid,
  identity,
  sessionOpened = false;
const document = () =>
  page.evaluate(() =>
    JSON.parse(
      window.ng
        .getComponent(window.document.querySelector("app-blockly-editor"))
        .blocklyService.captureRecoverySnapshot().documentText,
    ),
  );
const mirrors = async () =>
  Object.fromEntries(
    await Promise.all(
      [
        "project.abi",
        "project.abs",
        "project.abs.map.json",
        ".aily/abs-sync/committed.json",
      ].map(async (name) => [
        name,
        sourceHash(await fs.readFile(path.join(project, name))),
      ]),
    ),
  );
const state = () =>
  page.evaluate(() => {
    const component = (selector) => {
      const element = window.document.querySelector(selector);
      return element ? window.ng?.getComponent(element) : undefined;
    };
    const editor = component("app-blockly-editor"),
      host = component("app-child-tool-host"),
      domain = component("app-header")?.projectService,
      service = editor?.blocklyService,
      notice = host?.noticeService ?? editor?.noticeService;
    return {
      project: domain?.currentProjectPath,
      ready: domain?.getBlocklyProjectLoadStatus()?.ready ?? false,
      busy: service?.isWorkspaceEditInProgress() ?? false,
      blocked: service?.isWorkspaceEditBlocked() ?? false,
      recovery: service?.isWorkspaceRecoveryRequired() ?? false,
      running: host?.aiOperationProtocol?.hasRunning ?? false,
      noticeStop: typeof notice?.data?.stop === "function",
      noticeButtons: window.document.querySelectorAll(
        "app-notification .notification-box .btn.red",
      ).length,
    };
  });
const idle = async () => {
  const until = Date.now() + 30000;
  do {
    const result = await state();
    if (
      result.ready &&
      !result.busy &&
      !result.blocked &&
      !result.recovery &&
      !result.running &&
      !result.noticeStop &&
      !result.noticeButtons
    )
      return result;
    await wait(100);
  } while (Date.now() < until);
  throw Error("GUI-only save tail did not become idle");
};
try {
  router = await createLocalChatApiRouter({
    installedRoot: values["installed-root"],
  });
  const profile = await prepareInstalledChatProfile({
    appData,
    installedRoot: values["installed-root"],
    apiBase: router.origin,
    baseConfigPath: path.join(repo, "electron/config/config.json"),
    resourceAppData: values["resource-root"],
    token: router.token,
    reuseExisting: true,
  });
  evidence.profilePreparation = profile.preparation;
  const {
    ELECTRON_RUN_AS_NODE,
    AILY_CHILD_PATH,
    NODE_PATH,
    AILY_PORTABLE_ROOT,
    AILY_AUTH_FILE,
    ...env
  } = process.env;
  await phase("product-AUTO-original-root-session-full-ABC");
  app = await _electron.launch({
    executablePath: values["executable-path"],
    cwd: repo,
    args: [`--user-data-dir=${path.join(suite, "electron-profile")}`],
    timeout: 60000,
    env: {
      ...env,
      ...profile.env,
      AILY_E2E: "1",
      HOME: home,
      USERPROFILE: home,
      TEMP: temp,
      TMP: temp,
      npm_config_offline: "true",
      npm_config_audit: "false",
      npm_config_fund: "false",
    },
  });
  hostPid = await app.evaluate(() => process.pid);
  identity = (await processes()).find((value) => value.ProcessId === hostPid);
  assert.ok(
    identity && same(identity.ExecutablePath, values["executable-path"]),
  );
  evidence.mainIdentity = identity;
  assert.equal(await app.evaluate(({ app }) => app.isPackaged), true);
  await app.context().route("**/*", (route) => {
    const url = new URL(route.request().url());
    return !["http:", "https:"].includes(url.protocol) ||
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      ? route.continue()
      : route.abort("blockedbyclient");
  });
  const until = Date.now() + 60000;
  while (!page && Date.now() < until) {
    for (const candidate of app.windows())
      if (await candidate.locator("app-main-window").count()) {
        page = candidate;
        break;
      }
    if (!page) await wait(100);
  }
  assert.ok(page);
  page.on("dialog", (dialog) => dialog.dismiss());
  page.on("websocket", (socket) =>
    socket
      .on("framesent", ({ payload }) => {
        let message;
        try {
          message = JSON.parse(String(payload));
        } catch {
          return;
        }
        if (message.channel !== "agent") return;
        const command = message.command;
        if (
          [
            "session.create",
            "session.open",
            "session.openSubscribe",
            "session.subscribe",
            "prompt",
          ].includes(command?.type)
        )
          evidence.sessionCommands.push({
            attempt: 1,
            id: message.id,
            type: command.type,
            sessionId: command.sessionId ?? command.options?.sessionId,
            cwd: command.options?.cwd,
            at: Date.now(),
          });
      })
      .on("framereceived", ({ payload }) => {
        let message;
        try {
          message = JSON.parse(String(payload));
        } catch {
          return;
        }
        if (
          message.channel !== "agent" ||
          message.type !== "response" ||
          !evidence.sessionCommands.some((value) => value.id === message.id)
        )
          return;
        evidence.sessionResponses.push({
          id: message.id,
          ok: message.ok,
          subscribed: message.result?.subscribed,
          sessionId: message.result?.snapshot?.sessionId,
          errorCode: message.error?.code,
          at: Date.now(),
        });
      }),
  );
  await page.evaluate(() => {
    const dismiss = () => {
      window.document.querySelector("app-onboarding .btn-skip")?.click();
      window.document.querySelector("app-login .login-close")?.click();
    };
    new MutationObserver(dismiss).observe(window.document.documentElement, {
      childList: true,
      subtree: true,
    });
    dismiss();
  });
  await page.waitForFunction(
    (project) => {
      const element = window.document.querySelector("app-header"),
        domain = element && window.ng?.getComponent(element)?.projectService;
      return (
        domain?.currentProjectPath === project &&
        domain?.getBlocklyProjectLoadStatus(project)?.ready
      );
    },
    project,
    { timeout: 120000 },
  );
  loaded = await assertInstalledChatLoaded(page, {
    installedRoot: values["installed-root"],
    output: values.output,
    expectedApiBase: router.origin,
    expectedInputHash: artifact.inputHash,
    expectedOutputHash: artifact.outputHash,
  });
  evidence.originalSessionOpen = await waitForColdSessionOpen({
    project,
    sessionId,
    attempt: 1,
    commands: () => evidence.sessionCommands,
    responses: () => evidence.sessionResponses,
    readRegistry: async () =>
      (await loaded.e2e("session.list")).sessions.filter((value) =>
        same(value.cwd, project),
      ),
  });
  sessionOpened = true;
  const before = (await loaded.e2e("session.read", { sessionId })).session;
  assert.equal(before.sessionId, sessionId);
  assert.ok(same(before.cwd, project));
  assert.equal(
    before.messages.filter((message) => message.role === "user").length,
    3,
  );
  assert.deepEqual(await document(), expected);
  assert.deepEqual(await mirrors(), resume.mirrors);
  assert.ok(
    (await fs.readFile(resume.backup.path)).equals(resume.archiveBytes),
  );
  evidence.beforeSave = {
    state: await idle(),
    mirrors: await mirrors(),
    document: await document(),
  };
  await phase("real-menu-save-only-no-model-no-tools");
  await page.evaluate(() => {
    const domain = window.ng.getComponent(
        document.querySelector("app-header"),
      ).projectService,
      original = domain.save,
      calls = [];
    const wrapper = async function (...args) {
      const call = { project: args[0], settled: false };
      calls.push(call);
      try {
        const result = await original.apply(this, args);
        call.success = result?.success;
        call.partial = result?.partial;
        call.projectSaved = result?.projectSaved;
        call.publication = result?.publication;
        call.receipt = result?.projectionReceipt;
        call.evidence = result?.evidence;
        call.saveReceipt = result?.saveReceipt;
        return result;
      } finally {
        call.settled = true;
      }
    };
    domain.save = wrapper;
    window.__r2EnvironmentSaveTail = {
      calls,
      restore() {
        if (domain.save !== wrapper) throw Error("UI save observer changed");
        domain.save = original;
      },
    };
  });
  try {
    await page.locator("app-header .header-box > .menu").click();
    await page
      .locator(".menu-item")
      .filter({ has: page.locator(".text", { hasText: /^Ctrl\s*\+\s*S$/i }) })
      .click();
    await page.waitForFunction(
      () => window.__r2EnvironmentSaveTail.calls.some((call) => call.settled),
      undefined,
      { timeout: 30000 },
    );
    evidence.uiSave = await page.evaluate(
      () => window.__r2EnvironmentSaveTail.calls,
    );
    assert.equal(evidence.uiSave.length, 1);
    const saved = evidence.uiSave[0];
    assert.equal(saved.success, true);
    assert.notEqual(saved.partial, true);
    assert.equal(saved.projectSaved, true);
    assert.equal(saved.publication.status, "COMMITTED");
    assert.equal(saved.saveReceipt?.version, 2);
    assert.equal(saved.saveReceipt.operation, "project_save");
    assert.equal(saved.saveReceipt.state, "completed");
    assert.ok(same(saved.saveReceipt.project, project));
    assert.match(saved.saveReceipt.requestId, /^pub2-[a-f0-9-]{36}$/i);
    assert.notEqual(
      saved.saveReceipt.requestId,
      resume.provenance.originalNativeBoardRequestId,
    );
    const binding = saved.receipt?.output?.binding ?? saved.evidence?.binding;
    assert.ok(binding);
    for (const [name, key] of [
      ["project.abi", "abiHash"],
      ["project.abs", "absHash"],
      ["project.abs.map.json", "mapHash"],
    ])
      assert.equal(
        sourceHash(await fs.readFile(path.join(project, name))),
        binding[key],
      );
    const pointer = JSON.parse(
      await fs.readFile(
        path.join(project, ".aily/abs-sync/committed.json"),
        "utf8",
      ),
    );
    assert.equal(pointer.generation, binding.generation);
    assert.equal(
      pointer.hash,
      sourceHash(
        await fs.readFile(
          path.join(
            project,
            ".aily/abs-sync/baselines",
            pointer.generation + ".json",
          ),
        ),
      ),
    );
    evidence.uiSaveBinding = binding;
  } finally {
    await page.evaluate(() => {
      window.__r2EnvironmentSaveTail.restore();
      delete window.__r2EnvironmentSaveTail;
    });
  }
  assert.deepEqual(await document(), expected);
  assert.deepEqual(
    JSON.parse(await fs.readFile(path.join(project, "project.abi"), "utf8")),
    expected,
  );
  assert.ok(
    (await fs.readFile(resume.backup.path)).equals(resume.archiveBytes),
  );
  const after = (await loaded.e2e("session.read", { sessionId })).session;
  assert.equal(
    after.messages.filter((message) => message.role === "user").length,
    3,
  );
  assert.ok(
    !evidence.sessionCommands.some((command) =>
      ["prompt", "session.create"].includes(command.type),
    ),
  );
  evidence.api = router.snapshot();
  assert.ok(
    !evidence.api.requests.some((request) =>
      request.path.startsWith("/api/v3/interactions"),
    ),
  );
  assert.ok(
    (await fs.readFile(resume.sessionFile))
      .subarray(0, resume.sessionBytes.length)
      .equals(resume.sessionBytes),
  );
  evidence.final = {
    state: await idle(),
    document: expected,
    mirrors: await mirrors(),
    sessionId,
  };
  evidence.tailOk = true;
  evidence.ok = true;
  await page.screenshot({
    path: path.join(values.output, "full-ABC-UI-save.png"),
    fullPage: true,
  });
} catch (error) {
  evidence.error = {
    name: error.name,
    code: error.code,
    message: error.message,
    stack: error.stack,
  };
  if (page)
    await page
      .screenshot({
        path: path.join(values.output, "failure.png"),
        fullPage: true,
      })
      .catch(() => {});
  if (sessionOpened)
    await fs
      .writeFile(
        path.join(values.output, "failure-session.json"),
        JSON.stringify(
          (await loaded.e2e("session.read", { sessionId }).catch(() => ({})))
            .session,
          null,
          2,
        ),
      )
      .catch(() => {});
  throw error;
} finally {
  if (app)
    try {
      const tree = await ownedTree(hostPid),
        deadline = Date.now() + 30000;
      const current = tree.find((value) => value.ProcessId === hostPid);
      evidence.cleanup = {
        kind: "forced-test-cleanup",
        normalCloseCovered: false,
        ownedMain: identity,
        originalTree: tree,
        terminationAttempts: [],
      };
      const terminate = async (expected) => {
        await exec(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            Buffer.from(
              environmentProcessStopScript(expected),
              "utf16le",
            ).toString("base64"),
          ],
          {
            windowsHide: true,
            timeout: Math.min(20000, Math.max(1, deadline - Date.now())),
          },
        );
        evidence.cleanup.terminationAttempts.push(expected);
      };
      if (current) {
        assertCapturedEnvironmentProcess(current, identity);
        await terminate(identity);
      }
      const attempted = new Set([hostPid]);
      do {
        const all = await processes();
        evidence.ownedRemaining = remainingEnvironmentProcesses(tree, all);
        if (!evidence.ownedRemaining.length) break;
        for (const old of evidence.ownedRemaining)
          if (!attempted.has(old.ProcessId) && Date.now() < deadline) {
            assertCapturedEnvironmentProcess(
              all.find((value) => value.ProcessId === old.ProcessId),
              old,
            );
            attempted.add(old.ProcessId);
            await terminate(old);
          }
        await wait(300);
      } while (Date.now() < deadline);
      assert.deepEqual(evidence.ownedRemaining, []);
    } catch (error) {
      evidence.cleanupFailure = error.message;
      evidence.ok = false;
    }
  evidence.api = router?.snapshot();
  await router?.close();
  evidence.finishedAt = new Date().toISOString();
  await persist();
}
assert.equal(evidence.ok, true);
assert.deepEqual(evidence.ownedRemaining, []);
assert.deepEqual(await verifyPortableBuild(values["installed-root"]), artifact);
assert.equal(sha(await fs.readFile(asar)), hostHash);
assert.equal(
  sourceHash(await fs.readFile(values["resume-save-result"])),
  resume.provenance.resume02ResultHash,
);
assert.equal(
  sourceHash(await fs.readFile(resume.provenance.original17ResultFile)),
  resume.provenance.original17ResultHash,
);
