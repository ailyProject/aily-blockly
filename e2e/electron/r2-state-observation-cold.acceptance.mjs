import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { parseArgs, promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { _electron } from "@playwright/test";
import { createAbsStopModel } from "../fixtures/abs-stop-model.mjs";
import {
  createLocalChatApiRouter,
  prepareInstalledChatProfile,
  assertInstalledChatLoaded,
} from "../fixtures/installed-chat-ui.mjs";
import { prepareBuildLogProject } from "./fixtures/build-log-project.mjs";
import { singleFieldExpectedDocument } from "./fixtures/online-comparison.mjs";
import {
  sourceHash,
  waitForColdSessionOpen,
} from "./fixtures/abs-cold-continuity.mjs";
import {
  assertUserStoppedAssistant,
  assertUserStopTerminalUi,
  readUserStopTerminalUi,
} from "./fixtures/abs-stop-presentation.mjs";
import { assertNoNativeSaveModelFailures } from "./fixtures/native-save-observation-fault.mjs";
import { installR2StateObservationFault } from "./fixtures/r2-state-observation-fault.mjs";

// R2 incremental boundary, deliberately separate from the R1 save/tidy driver:
// no ABS candidate A -> registered state setter -> real terminal ACK loss ->
// actual Chat Stop -> whole HOST death -> automatic original project/session ->
// original observe_state -> ordinary core edit B -> fresh apply + UI save.
const repo = fileURLToPath(new URL("../../", import.meta.url));
const names = [
  "executable-path",
  "installed-root",
  "lex-root",
  "resource-root",
  "test-root",
  "output",
  "expected-input-hash",
];
const { values } = parseArgs({
  options: Object.fromEntries(names.map((name) => [name, { type: "string" }])),
});
assert.equal(
  process.env.AILY_R2_STATE_OBSERVATION_HOST_WINDOW,
  "1",
  "Use only the root-coordinated frozen-artifact HOST window",
);
for (const name of names.filter((name) => name !== "expected-input-hash"))
  assert.ok(path.isAbsolute(values[name] ?? ""));
assert.match(values["expected-input-hash"] ?? "", /^[a-f0-9]{64}$/);
const inside = (root, file) => {
  const relative = path.relative(root, file);
  return (
    relative &&
    relative !== ".." &&
    !relative.startsWith(".." + path.sep) &&
    !path.isAbsolute(relative)
  );
};
const same = (left, right) =>
  typeof left === "string" &&
  typeof right === "string" &&
  path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
assert.ok(inside(path.join(repo, "e2e/test-results"), values.output));
assert.ok(
  inside(path.join(values["resource-root"], "dev-tests"), values["test-root"]),
);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex"),
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const exec = promisify(execFile);
const processes = async () => {
  const result = await exec(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,@{Name='CreationDate';Expression={$_.CreationDate.ToUniversalTime().ToString('o')}},ExecutablePath | ConvertTo-Json -Compress",
    ],
    { windowsHide: true, timeout: 15000 },
  );
  const list = JSON.parse(result.stdout);
  return Array.isArray(list) ? list : [list];
};
const ownedTree = async (pid) => {
  const all = await processes(),
    ids = new Set([pid]);
  let changed;
  do {
    changed = false;
    for (const item of all)
      if (ids.has(item.ParentProcessId) && !ids.has(item.ProcessId)) {
        ids.add(item.ProcessId);
        changed = true;
      }
  } while (changed);
  return all.filter((item) => ids.has(item.ProcessId));
};
const exited = async (tree) => {
  const deadline = Date.now() + 30000;
  let remaining;
  do {
    const current = await processes();
    remaining = tree.filter((item) =>
      current.some(
        (value) =>
          value.ProcessId === item.ProcessId &&
          value.CreationDate === item.CreationDate,
      ),
    );
    if (!remaining.length) return { exitedNaturally: true, remaining: [] };
    await wait(500);
  } while (Date.now() < deadline);
  throw Object.assign(
    Error(
      "Owned host descendants remain; never terminate unrelated applications",
    ),
    { remaining },
  );
};
const textOf = (message) =>
  (message?.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
const payloadOf = (message) => {
  if (message?.details?.result) return message.details.result;
  try {
    return JSON.parse(textOf(message));
  } catch {
    return undefined;
  }
};
const callsOf = (snapshot) =>
  (snapshot?.messages ?? [])
    .filter((message) => message.role === "assistant")
    .flatMap((message) => message.content ?? [])
    .filter((part) => part.type === "toolCall")
    .map((call) => ({
      ...call,
      actualName: call.name === "tool_invoke" ? call.arguments.name : call.name,
    }));
const native = (id, name, args) => ({ id, name, arguments: args }),
  deferred = (id, name, args) =>
    native(id, "tool_invoke", { name, arguments: args });
const checkpointOf = (snapshot) =>
  snapshot.entries?.findLast(
    (entry) =>
      entry.type === "custom" &&
      entry.customType === "aily.workspace-history" &&
      same(entry.data?.workspaceRoot, project),
  )?.data;
const noInventedCandidate = (snapshot) => {
  const workflows =
    snapshot.entries?.filter(
      (entry) =>
        entry.type === "custom" &&
        entry.customType === "aily.abs-workflow" &&
        same(entry.data?.project, project),
    ) ?? [];
  assert.ok(
    workflows.every(
      (entry) =>
        !entry.data.retainedCandidate && !entry.data.applicationRequestId,
    ),
    "A no-draft state request cannot invent a candidate or an apply attempt",
  );
  assert.equal(
    callsOf(snapshot).some((call) =>
      ["edit", "write", "code_run", "abs_apply", "abs_import"].includes(
        call.actualName,
      ),
    ),
    false,
  );
};
const { verifyPortableBuild } = await import(
  pathToFileURL(
    path.join(
      values["lex-root"],
      "packages/aily-chat/server/portable-integrity.ts",
    ),
  )
);
const { captureBuildInputs } = await import(
  pathToFileURL(
    path.join(
      values["lex-root"],
      "packages/aily-chat/scripts/portable-build-inputs.mjs",
    ),
  )
);
const artifact = await verifyPortableBuild(values["installed-root"]);
assert.equal(artifact.inputHash, values["expected-input-hash"]);
assert.equal(
  artifact.inputHash,
  sha(JSON.stringify(await captureBuildInputs(values["lex-root"]))),
);
const asar = path.join(
    path.dirname(values["executable-path"]),
    "resources/app.asar",
  ),
  hostHash = sha(await fs.readFile(asar));
await fs.mkdir(values.output, { recursive: false });
await fs.mkdir(values["test-root"], { recursive: true });
const suite = await fs.mkdtemp(
    path.join(values["test-root"], "r2-state-cold-"),
  ),
  project = path.join(suite, "project");
const appData = path.join(suite, "appdata"),
  home = path.join(suite, "home"),
  temp = path.join(suite, "temp"),
  absPath = path.join(project, "project.abs");
for (const directory of [home, temp]) await fs.mkdir(directory);
const fixture = await prepareBuildLogProject({
  directory: project,
  boardsRoot: path.resolve(repo, "../aily-blockly-boards"),
  librariesRoot: path.resolve(repo, "../aily-blockly-libraries"),
  scenario: "field-edit",
  marker: "R2_STATE_OBSERVE_NO_COMPILE",
});
const seed = JSON.parse(
  await fs.readFile(path.join(project, "project.abi"), "utf8"),
);
seed.blocks.blocks.find(
  (block) => block.type === "arduino_global",
).inputs.ARDUINO_GLOBAL.block.next = {
  block: {
    type: fixture.blockType,
    id: "r2_state_cold_second",
    fields: { VALUE: 200 },
  },
};
await fs.writeFile(
  path.join(project, "project.abi"),
  JSON.stringify(seed, null, 2),
);
const evidence = {
  ok: false,
  suite,
  project,
  artifact,
  hostHash,
  startedAt: new Date().toISOString(),
  realInstalledChat: true,
  realAsarHost: true,
  paidModelRequests: 0,
  deterministicLocalModel: true,
  fabricatedHostReceipts: false,
  manualProofBinding: false,
  manualSessionRestore: false,
  beforeStateCandidatePresent: false,
  stages: [],
  tools: [],
  launches: [],
  sessionCommands: [],
  sessionResponses: [],
  abortCommands: [],
  abortResponses: [],
  resources: [],
};
const persist = () =>
  fs.writeFile(
    path.join(values.output, "result.json"),
    JSON.stringify(evidence, null, 2),
  );
const phase = async (name) => {
  console.log("PHASE=" + name);
  evidence.stages.push({ name, at: Date.now() });
  await persist();
};
let app,
  page,
  loaded,
  model,
  router,
  profile,
  hostPid,
  ownedMainIdentity,
  originalHostPid,
  sessionId,
  snapshot,
  baseline,
  sourceS0,
  generation,
  inspected,
  rootId;
let expectedG1,
  g1Binding,
  pending,
  held = false,
  release,
  coldReopened = false,
  faultInstalled = false;
const seen = new Set(),
  abortIds = new Set();
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
const faultState = () =>
  app.evaluate(
    () =>
      globalThis.__ailyR2StateObservationFault?.snapshot() ?? {
        available: false,
      },
  );
const state = () =>
  page.evaluate(() => {
    const component = (name) => {
      const element = window.document.querySelector(name);
      return element ? window.ng?.getComponent(element) : undefined;
    };
    const editor = component("app-blockly-editor"),
      host = component("app-child-tool-host"),
      domain = component("app-header")?.projectService;
    const blockly = editor?.blocklyService,
      notice = host?.noticeService ?? editor?.noticeService;
    return {
      project: domain?.currentProjectPath ?? null,
      ready: domain?.getBlocklyProjectLoadStatus()?.ready ?? false,
      writing: blockly?.aiWriting ?? false,
      blocked: blockly?.isWorkspaceEditBlocked() ?? false,
      nativeBusy: blockly?.isWorkspaceEditInProgress() ?? false,
      recoveryRequired: blockly?.isWorkspaceRecoveryRequired() ?? false,
      hasRunning: host?.aiOperationProtocol?.hasRunning ?? false,
      noticeHasStop: typeof notice?.data?.stop === "function",
      noticeButtons: window.document.querySelectorAll(
        "app-notification .notification-box .btn.red",
      ).length,
      recentProjects: (domain?.recentlyProjects ?? []).map(
        (value) => value.path,
      ),
    };
  });
const trust = async () => {
  assert.equal(
    await loaded.frame.locator(".full-access-permission-dialog").isVisible(),
    false,
  );
  for (const dialog of await loaded.frame.locator(".pi-extension-dialog").all())
    if (await dialog.isVisible()) {
      const lines = String(await dialog.getAttribute("aria-label")).split(
        /\r?\n/,
      );
      assert.equal(lines[0], "Trust project folder?");
      assert.ok(same(lines[1], project));
      await dialog
        .getByRole("button", { name: "Trust (this session only)", exact: true })
        .click();
    }
};
const observe = async () => {
  await trust();
  const sessions = (await loaded.e2e("session.list")).sessions.filter((value) =>
    same(value.cwd, project),
  );
  assert.ok(sessions.length <= 1);
  sessionId ??= sessions[0]?.sessionId;
  if (!sessionId) return;
  snapshot = (await loaded.e2e("session.read", { sessionId })).session;
  assert.equal(snapshot.sessionId, sessionId);
  assert.ok(same(snapshot.cwd, project));
  assert.equal(snapshot.permissionMode, "default");
  const calls = callsOf(snapshot);
  for (const message of snapshot.messages.filter(
    (value) => value.role === "toolResult",
  )) {
    if (seen.has(message.toolCallId)) continue;
    seen.add(message.toolCallId);
    const result = payloadOf(message),
      name =
        calls.find((call) => call.id === message.toolCallId)?.actualName ??
        message.toolName;
    evidence.tools.push({
      id: message.toolCallId,
      name,
      isError: message.isError === true,
      result,
      text: name === "read" ? textOf(message) : undefined,
    });
    if (message.toolCallId === "uncertain-state-g1") {
      assert.equal(message.isError, true);
      assert.equal(result.stateOutcome, "unknown");
      assert.equal(result.observation?.resultKnown, false);
      assert.equal(result.observation?.operationCancelled, false);
      assert.ok(
        ["transport", "cancelled"].includes(result.observation.reason),
        "Receipt mismatch is not successful transport loss",
      );
      pending = checkpointOf(snapshot)?.pendingPublication;
      assert.ok(
        pending,
        "The actual registered state tool must durably record its original request before dispatch",
      );
      assert.equal(pending.operation, "blocks_set_state");
      assert.equal(pending.requestId, result.pendingState.requestId);
      assert.equal(
        result.pendingState.nativeRequestId,
        "pub2-" + pending.requestId,
      );
      assert.equal(pending.state.requestId, pending.requestId);
      assert.equal(pending.targetPid, hostPid);
      assert.equal(
        pending.state.expectedGeneration,
        inspected.expectedGeneration,
      );
      assert.equal(pending.inputAbiHash, evidence.s0.mirrors["project.abi"]);
      assert.equal(pending.inputAbsHash, sourceHash(sourceS0));
      assert.equal(pending.owner.sessionId, sessionId);
      assert.ok(pending.owner.branchId && pending.owner.operationId);
      noInventedCandidate(snapshot);
      evidence.pendingPublication = structuredClone(pending);
      evidence.actualSdkCancellation = {
        reason: result.observation.reason,
        operationCancelled: false,
        resultKnown: false,
        cancelled: result.cancelled === true,
      };
    } else
      assert.equal(
        message.isError === true,
        false,
        name + ": " + textOf(message).slice(0, 1000),
      );
    if (message.toolCallId === "export-s0") {
      generation = result.generation;
      sourceS0 = result.abs;
      baseline = await document();
      rootId = baseline.pages[0].content.blocks.blocks.find(
        (block) => block.type === "arduino_global",
      ).id;
      evidence.s0 = {
        generation,
        document: baseline,
        mirrors: await mirrors(),
        absHash: sourceHash(sourceS0),
      };
    }
    if (message.toolCallId === "inspect-s0") {
      inspected = result;
      assert.equal(result.instances.length, 1);
      assert.equal(result.instances[0].blockId, rootId);
      expectedG1 = structuredClone(baseline);
      const target = expectedG1.pages[0].content.blocks.blocks.find(
        (block) => block.id === rootId,
      );
      if (inspected.instances[0].collapsed) delete target.collapsed;
      else target.collapsed = true;
    }
  }
};
const submit = async (prompt) => {
  await trust();
  await loaded.frame
    .locator('.aily-chat-composer-input[role="textbox"]')
    .fill(prompt);
  const send = loaded.frame.locator("button.primary-action.send-action");
  await send.waitFor({ state: "visible", timeout: 15000 });
  await send.click();
};
const settle = async (users) => {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    assertNoNativeSaveModelFailures(model.snapshot().failures);
    await observe();
    if (
      snapshot?.isIdle &&
      !snapshot.isStreaming &&
      !snapshot.isPreparing &&
      snapshot.messages.filter((value) => value.role === "user").length ===
        users
    ) {
      await fs.writeFile(
        path.join(values.output, "session-" + users + ".json"),
        JSON.stringify(snapshot, null, 2),
      );
      return;
    }
    await wait(100);
  }
  throw Error(
    "Installed Chat did not settle the exact state/cold continuation",
  );
};
const idle = async () => {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const current = await state();
    if (
      current.ready &&
      !current.hasRunning &&
      !current.writing &&
      !current.blocked &&
      !current.nativeBusy &&
      !current.recoveryRequired
    ) {
      assert.equal(current.noticeHasStop, false);
      assert.equal(current.noticeButtons, 0);
      return current;
    }
    await wait(100);
  }
  throw Error("State continuation left a runtime/notice/recovery gate");
};
async function launch(attempt) {
  assert.ok(os.freemem() >= 1024 ** 3);
  evidence.resources.push({
    attempt,
    freeMemory: os.freemem(),
    at: Date.now(),
  });
  const {
    ELECTRON_RUN_AS_NODE,
    AILY_CHILD_PATH,
    NODE_PATH,
    AILY_PORTABLE_ROOT,
    AILY_AUTH_FILE,
    ...env
  } = process.env;
  ownedMainIdentity = undefined;
  hostPid = undefined;
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
    },
  });
  hostPid = await app.evaluate(() => process.pid);
  ownedMainIdentity = (await processes()).find(
    (value) => value.ProcessId === hostPid,
  );
  assert.ok(ownedMainIdentity?.CreationDate);
  assert.ok(same(ownedMainIdentity?.ExecutablePath, values["executable-path"]));
  evidence.launches.push({
    attempt,
    hostPid,
    mainIdentity: ownedMainIdentity,
    at: Date.now(),
  });
  await persist();
  // Install the passive cold reader before renderer/Chat startup can observe.
  if (attempt) {
    const descriptorFile = path.join(
        home,
        ".aily-blockly/cli-bridge",
        hostPid + ".json",
      ),
      until = Date.now() + 30000;
    let descriptor;
    while (!descriptor && Date.now() < until) {
      try {
        descriptor = JSON.parse(await fs.readFile(descriptorFile, "utf8"));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        await wait(30);
      }
    }
    assert.equal(descriptor?.pid, hostPid);
    evidence.coldObserverInstalled = await app.evaluate(
      installR2StateObservationFault,
      JSON.stringify({
        project,
        appData,
        pid: hostPid,
        port: descriptor.port,
        previousGeneration: generation,
        inputAbiHash: pending.inputAbiHash,
        expectedDocument: expectedG1,
        observationOnly: true,
        originalState: pending.state,
        originalTargetPid: originalHostPid,
      }),
    );
    assert.equal(evidence.coldObserverInstalled.available, true);
    faultInstalled = true;
  }
  await app.context().route("**/*", (route) => {
    const url = new URL(route.request().url());
    return !["http:", "https:"].includes(url.protocol) ||
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      ? route.continue()
      : route.abort("blockedbyclient");
  });
  page = undefined;
  const deadline = Date.now() + 60000;
  while (!page && Date.now() < deadline) {
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
        let value;
        try {
          value = JSON.parse(String(payload));
        } catch {
          return;
        }
        if (value.channel !== "agent") return;
        const command = value.command;
        if (command?.type === "abort") {
          abortIds.add(value.id);
          evidence.abortCommands.push({
            id: value.id,
            sessionId: command.sessionId,
            source: command.source,
            reason: command.reason,
          });
        }
        if (
          ["session.open", "session.openSubscribe", "session.create"].includes(
            command?.type,
          )
        )
          evidence.sessionCommands.push({
            attempt,
            id: value.id,
            type: command.type,
            sessionId: command.sessionId ?? command.options?.sessionId,
            cwd: command.options?.cwd,
          });
      })
      .on("framereceived", ({ payload }) => {
        let value;
        try {
          value = JSON.parse(String(payload));
        } catch {
          return;
        }
        if (value.channel !== "agent" || value.type !== "response") return;
        if (abortIds.has(value.id))
          evidence.abortResponses.push({
            id: value.id,
            ok: value.ok,
            accepted: value.result?.accepted,
          });
        if (
          evidence.sessionCommands.some(
            (command) =>
              command.id === value.id &&
              ["session.open", "session.openSubscribe"].includes(command.type),
          )
        )
          evidence.sessionResponses.push({
            id: value.id,
            ok: value.ok,
            subscribed: value.result?.subscribed,
            sessionId: value.result?.snapshot?.sessionId,
            errorCode: value.error?.code,
            errorMessage: value.error?.message,
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
  await page.waitForFunction(() => {
    const element = window.document.querySelector("app-header");
    return element && window.ng?.getComponent(element)?.projectService;
  });
  if (!attempt)
    await page.evaluate(async (project) => {
      const domain = window.ng.getComponent(
        window.document.querySelector("app-header"),
      ).projectService;
      await domain.initializeProjectDataSchema(project);
      if (!(await domain.projectOpen(project)))
        throw Error("Owned fixture failed to open");
    }, project);
  // No Recent click, open RPC or replacement session on cold startup.
  await page.waitForFunction(
    (project) => {
      const domain = window.ng.getComponent(
        window.document.querySelector("app-header"),
      ).projectService;
      return (
        domain.currentProjectPath === project &&
        domain.getBlocklyProjectLoadStatus(project)?.ready
      );
    },
    project,
    { timeout: 120000 },
  );
  const uiOutput = path.join(values.output, "launch-" + attempt);
  await fs.mkdir(uiOutput);
  loaded = await assertInstalledChatLoaded(page, {
    installedRoot: values["installed-root"],
    output: uiOutput,
    expectedApiBase: router.origin,
    expectedInputHash: artifact.inputHash,
    expectedOutputHash: artifact.outputHash,
  });
  evidence.launches.at(-1).chat = loaded.evidence;
  if (attempt)
    evidence.launches.at(-1).originalSessionOpen = await waitForColdSessionOpen(
      {
        project,
        sessionId,
        attempt,
        commands: () => evidence.sessionCommands,
        responses: () => evidence.sessionResponses,
        readRegistry: async () =>
          (await loaded.e2e("session.list")).sessions.filter((value) =>
            same(value.cwd, project),
          ),
      },
    );
}
try {
  model = await createAbsStopModel({
    nextTool: async ({ turn, step }) => {
      assertNoNativeSaveModelFailures(model.snapshot().failures);
      await observe();
      if (!turn) {
        if (step === 0)
          return native("load-r2-tools", "tool_load", {
            names: [
              "abs_export",
              "abs_apply",
              "blocks_set_state",
              "project_save",
            ],
          });
        if (step === 1) return deferred("export-s0", "abs_export", { project });
        if (step === 2)
          return deferred("inspect-s0", "blocks_set_state", {
            project,
            action: "inspect",
            blockIds: [rootId],
            limit: 1,
          });
        if (step === 3) {
          noInventedCandidate(snapshot);
          const descriptor = JSON.parse(
            await fs.readFile(
              path.join(home, ".aily-blockly/cli-bridge", hostPid + ".json"),
              "utf8",
            ),
          );
          assert.equal(descriptor.pid, hostPid);
          evidence.faultInstalled = await app.evaluate(
            installR2StateObservationFault,
            JSON.stringify({
              project,
              appData,
              pid: hostPid,
              port: descriptor.port,
              previousGeneration: generation,
              inputAbiHash: evidence.s0.mirrors["project.abi"],
              expectedDocument: expectedG1,
            }),
          );
          assert.equal(evidence.faultInstalled.available, true);
          faultInstalled = true;
          return deferred("uncertain-state-g1", "blocks_set_state", {
            project,
            action: "update",
            expectedGeneration: inspected.expectedGeneration,
            changes: [
              { blockId: rootId, collapsed: !inspected.instances[0].collapsed },
            ],
          });
        }
        assert.equal(step, 4);
        const proof = await faultState();
        evidence.lostStateAck = proof;
        assert.deepEqual(proof.failures, []);
        assert.deepEqual(proof.unverifiedTerminalReplies, []);
        assert.equal(proof.drops, 1);
        assert.equal(
          proof.commands.filter(
            (value) => value.operation === "blocks_set_state",
          ).length,
          1,
        );
        assert.equal(
          proof.commands.filter((value) => value.action === "observe_state")
            .length,
          0,
        );
        assert.equal(proof.requestId, pending.requestId);
        assert.deepEqual(proof.state, pending.state);
        g1Binding = proof.terminals.at(-1).binding;
        assert.notEqual(g1Binding.generation, generation);
        assert.deepEqual(await document(), expectedG1);
        assert.deepEqual(
          JSON.parse(
            await fs.readFile(path.join(project, "project.abi"), "utf8"),
          ),
          expectedG1,
        );
        evidence.g1 = {
          binding: g1Binding,
          document: expectedG1,
          mirrors: await mirrors(),
        };
        const objectHash = pending.inputAbsHash.slice(7);
        const s0Blob = await fs.readFile(
          path.join(
            project,
            ".workspace-history/objects",
            objectHash.slice(0, 2),
            objectHash + ".blob",
          ),
        );
        assert.equal(sourceHash(s0Blob), pending.inputAbsHash);
        assert.equal(s0Blob.toString(), sourceS0);
        evidence.savedS0BlobPinned = {
          hash: pending.inputAbsHash,
          bytes: s0Blob.length,
          checkpointId: checkpointOf(snapshot).checkpointId,
        };
        held = true;
        await new Promise((resolve) => {
          release = resolve;
        });
        return undefined;
      }
      assert.equal(turn, 1);
      assert.equal(coldReopened, true);
      assert.equal(
        snapshot.messages.filter((value) => value.role === "user").length,
        2,
      );
      if (step === 0) {
        const checkpoint = checkpointOf(snapshot);
        assert.equal(
          checkpoint?.pendingPublication,
          undefined,
          "Cold preflight must observe/adopt/clear the exact no-A state request before any provider tool",
        );
        const observed = await faultState();
        evidence.coldStateObservation = observed;
        assert.deepEqual(observed.failures, []);
        assert.deepEqual(observed.unverifiedTerminalReplies, []);
        assert.equal(observed.drops, 0);
        assert.ok(observed.commands.length >= 1);
        assert.ok(
          observed.commands.every(
            (value) =>
              value.operation === "abs_recovery" &&
              value.action === "observe_state",
          ),
        );
        assert.ok(observed.terminals.length >= 1);
        assert.ok(
          observed.terminals.every(
            (value) =>
              value.requestId === pending.requestId &&
              value.nativeRequestId === "pub2-" + pending.requestId,
          ),
        );
        assert.equal(
          observed.terminals.at(-1).originalExecutor.hostPid,
          originalHostPid,
        );
        assert.equal(observed.terminals.at(-1).observer.hostPid, hostPid);
        assert.notEqual(originalHostPid, hostPid);
        assert.deepEqual(await mirrors(), evidence.g1.mirrors);
        assert.deepEqual(await document(), expectedG1);
        noInventedCandidate(snapshot);
        return native("read-g1-before-B", "read", { path: absPath });
      }
      if (step === 1)
        return native("edit-B", "edit", {
          path: absPath,
          edits: [
            {
              oldText: `${fixture.blockType}(200)`,
              newText: `${fixture.blockType}(201)`,
            },
          ],
        });
      if (step === 2)
        return deferred("apply-B", "abs_apply", { project, absPath });
      assert.equal(step, 3);
      return undefined;
    },
  });
  router = await createLocalChatApiRouter({
    operationOrigin: model.origin,
    installedRoot: values["installed-root"],
  });
  profile = await prepareInstalledChatProfile({
    appData,
    installedRoot: values["installed-root"],
    apiBase: router.origin,
    baseConfigPath: path.join(repo, "electron/config/config.json"),
    resourceAppData: values["resource-root"],
    token: router.token,
  });
  await phase("no-candidate-original-state-request-true-lost-terminal");
  await launch(0);
  await submit(
    "Collapse the existing global block and save that state. Do not change program text. I will stop before continuing.",
  );
  const until = Date.now() + 120000;
  while (!held && Date.now() < until) {
    assertNoNativeSaveModelFailures(model.snapshot().failures);
    await observe();
    await wait(100);
  }
  assert.equal(held, true);
  noInventedCandidate(snapshot);
  await fs.writeFile(
    path.join(values.output, "session-before-stop.json"),
    JSON.stringify(snapshot, null, 2),
  );
  await page.screenshot({
    path: path.join(values.output, "lost-state-ack-before-stop.png"),
    fullPage: true,
  });
  await phase("actual-chat-stop-while-state-request-remains-unknown");
  await loaded.frame
    .locator("button.primary-action.stop-action")
    .waitFor({ state: "visible", timeout: 5000 });
  await loaded.frame.locator("button.primary-action.stop-action").click();
  const stopUntil = Date.now() + 15000;
  while (
    !model.snapshot().interactions.find((value) => value.turn === 0)
      ?.interrupted &&
    Date.now() < stopUntil
  )
    await wait(50);
  assert.equal(
    model.snapshot().interactions.find((value) => value.turn === 0)
      ?.interrupted,
    true,
  );
  release();
  release = undefined;
  await settle(1);
  evidence.userStop = assertUserStoppedAssistant(snapshot);
  await loaded.frame
    .locator(
      '.x-aily-interruption-divider[role="status"], .x-aily-interruption-text[role="status"]',
    )
    .first()
    .waitFor({ state: "visible", timeout: 15000 });
  evidence.userStopUi = await loaded.frame.evaluate(readUserStopTerminalUi);
  assertUserStopTerminalUi(evidence.userStopUi);
  assert.equal(evidence.abortCommands.length, 1);
  assert.equal(evidence.abortCommands[0].sessionId, sessionId);
  assert.ok(
    evidence.abortResponses.some(
      (value) => value.ok && value.accepted === true,
    ),
  );
  await idle();
  assert.deepEqual(checkpointOf(snapshot)?.pendingPublication, pending);
  noInventedCandidate(snapshot);
  assert.deepEqual(await mirrors(), evidence.g1.mirrors);
  evidence.firstFaultFinal = await faultState();
  assert.equal(evidence.firstFaultFinal.commands.length, 1);
  assert.equal(
    await app.evaluate(() =>
      globalThis.__ailyR2StateObservationFault.restore(),
    ),
    1,
  );
  faultInstalled = false;
  await phase("whole-host-sigkill-with-unobserved-state-request");
  originalHostPid = hostPid;
  const tree = await ownedTree(hostPid),
    closed = app.waitForEvent("close", { timeout: 15000 });
  await app
    .evaluate(
      (_, expected) => {
        if (
          process.pid !== expected.pid ||
          process.env.AILY_APPDATA_PATH !== expected.appData
        )
          throw Error("Refuse unrelated host termination");
        process.kill(process.pid, "SIGKILL");
      },
      { pid: hostPid, appData },
    )
    .catch((error) => {
      if (!/closed|destroyed|terminated|Target/i.test(error.message))
        throw error;
    });
  await closed;
  app = undefined;
  page = undefined;
  loaded = undefined;
  evidence.crashCleanup = await exited(tree);
  await launch(1);
  await observe();
  assert.deepEqual(await document(), expectedG1);
  assert.deepEqual(await mirrors(), evidence.g1.mirrors);
  noInventedCandidate(snapshot);
  coldReopened = true;
  await phase(
    "automatic-original-project-session-readonly-original-state-then-B",
  );
  await submit(
    "In this same project, change the existing value 200 to 201 and save the completed change.",
  );
  await settle(2);
  await idle();
  const applied = evidence.tools.find(
    (value) => value.id === "apply-B",
  )?.result;
  assert.equal(applied?.ok, true);
  assert.equal(applied.publication?.status, "COMMITTED");
  assert.equal(applied.applyVerification?.ok, true);
  const expected = singleFieldExpectedDocument(
    expectedG1,
    "r2_state_cold_second",
    "VALUE",
    200,
    201,
  );
  assert.deepEqual(await document(), expected);
  assert.deepEqual(
    JSON.parse(await fs.readFile(path.join(project, "project.abi"), "utf8")),
    expected,
  );
  assert.ok(
    evidence.tools
      .find((value) => value.id === "read-g1-before-B")
      ?.text.includes(`${fixture.blockType}(200)`),
  );
  assert.equal(
    callsOf(snapshot).filter(
      (call) =>
        call.actualName === "blocks_set_state" &&
        (call.arguments.arguments ?? call.arguments).action === "update",
    ).length,
    1,
  );
  assert.equal(
    callsOf(snapshot).filter((call) => call.actualName === "abs_apply").length,
    1,
  );
  assert.ok(
    !callsOf(snapshot).some((call) =>
      [
        "project_create",
        "project_fork",
        "project_recover",
        "project_open",
        "app_open",
        "app_reload",
      ].includes(call.actualName),
    ),
  );
  // Observe the real menu save to completion; this wrapper forwards the original
  // call/result unchanged and cannot create a receipt or declare native success.
  await phase("actual-ui-save-after-B");
  await page.evaluate(() => {
    const domain = window.ng.getComponent(
      document.querySelector("app-header"),
    ).projectService;
    const original = domain.save,
      calls = [];
    const wrapper = async function (...args) {
      const call = { project: args[0], started: Date.now(), settled: false };
      calls.push(call);
      try {
        const result = await original.apply(this, args);
        call.success = result?.success;
        call.projectSaved = result?.projectSaved;
        call.partial = result?.partial;
        return result;
      } finally {
        call.settled = true;
      }
    };
    window.__r2StateUiSave = {
      calls,
      restore: () => {
        if (domain.save !== wrapper)
          throw Error("UI save observer ownership changed");
        domain.save = original;
      },
    };
    domain.save = wrapper;
  });
  try {
    await page.locator("app-header .header-box > .menu").click();
    await page
      .locator(".menu-item")
      .filter({ has: page.locator(".text", { hasText: /^Ctrl\s*\+\s*S$/i }) })
      .click();
    await page.waitForFunction(
      () =>
        window.__r2StateUiSave.calls.some(
          (call) => call.settled && call.success === true,
        ),
      undefined,
      { timeout: 30000 },
    );
    evidence.uiSave = await page.evaluate(() => window.__r2StateUiSave.calls);
    assert.equal(evidence.uiSave.length, 1);
    assert.ok(same(evidence.uiSave[0].project ?? project, project));
    assert.notEqual(evidence.uiSave[0].partial, true);
  } finally {
    await page.evaluate(() => {
      window.__r2StateUiSave.restore();
      delete window.__r2StateUiSave;
    });
  }
  await idle();
  assert.deepEqual(await document(), expected);
  assert.deepEqual(
    JSON.parse(await fs.readFile(path.join(project, "project.abi"), "utf8")),
    expected,
  );
  evidence.final = {
    sessionId,
    document: expected,
    mirrors: await mirrors(),
    state: await idle(),
    currentCheckpoint: checkpointOf(snapshot),
  };
  assert.ok(same(evidence.final.state.project, project));
  assert.ok(
    evidence.final.state.recentProjects.every((value) => same(value, project)),
  );
  assert.equal(model.snapshot().createCount, 2);
  assert.deepEqual(model.snapshot().failures, []);
  await page.screenshot({
    path: path.join(values.output, "final-G1-B.png"),
    fullPage: true,
  });
  evidence.ok = true;
} catch (error) {
  evidence.error = {
    name: error.name,
    message: error.message,
    stack: error.stack,
  };
  if (faultInstalled && app)
    evidence.finalFault = await faultState().catch((error) => ({
      observationError: error.message,
    }));
  if (page) {
    evidence.failureState = await state().catch((error) => ({
      observationError: error.message,
    }));
    await page
      .screenshot({
        path: path.join(values.output, "failure.png"),
        fullPage: true,
      })
      .catch(() => {});
  }
  if (loaded && sessionId) {
    const value = await loaded
      .e2e("session.read", { sessionId })
      .catch(() => undefined);
    if (value)
      await fs.writeFile(
        path.join(values.output, "failure-session.json"),
        JSON.stringify(value.session, null, 2),
      );
  }
  throw error;
} finally {
  release?.();
  if (faultInstalled && app) {
    evidence.finalFault ??= await faultState().catch((error) => ({
      observationError: error.message,
    }));
    await app
      .evaluate(() => globalThis.__ailyR2StateObservationFault?.restore())
      .catch((error) => {
        evidence.faultRestoreError = error.message;
      });
  }
  if (app) {
    try {
      assert.ok(
        ownedMainIdentity && ownedMainIdentity.ProcessId === hostPid,
        "Cleanup requires this launch's original Main identity",
      );
      const tree = await ownedTree(hostPid);
      const current = tree.find((value) => value.ProcessId === hostPid);
      let forced = false;
      if (current) {
        assert.equal(current.CreationDate, ownedMainIdentity.CreationDate);
        assert.ok(
          same(current.ExecutablePath, ownedMainIdentity.ExecutablePath),
        );
        assert.ok(same(current.ExecutablePath, values["executable-path"]));
        const literal = (value) =>
          "'" + String(value).replace(/'/g, "''") + "'";
        // Recheck the same creation/exe inside the OS kill command. Do not
        // invoke app.close()/beforeQuit: normal-close coverage is not claimed.
        const script = `
$r2Owned = Get-CimInstance Win32_Process -Filter 'ProcessId = ${hostPid}' -ErrorAction Stop
if (-not $r2Owned) { throw 'Owned Main exited before cleanup' }
if ($r2Owned.CreationDate.ToUniversalTime().ToString('o') -cne ${literal(ownedMainIdentity.CreationDate)} -or
    [IO.Path]::GetFullPath([string]$r2Owned.ExecutablePath) -ine [IO.Path]::GetFullPath(${literal(values["executable-path"])})) {
  throw 'Refuse cleanup after Main PID creation or executable changed'
}
Stop-Process -Id ${hostPid} -Force -ErrorAction Stop
`;
        const closed = app
          .waitForEvent("close", { timeout: 15000 })
          .catch((error) => ({ error: error.message }));
        await exec(
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-Command", script],
          { windowsHide: true, timeout: 20000 },
        );
        forced = true;
        const closeResult = await closed;
        assert.equal(
          closeResult?.error,
          undefined,
          "Owned Main must actually close after forced test cleanup",
        );
      }
      const ended = await exited(tree);
      evidence.finalCleanup = {
        kind: "forced-test-cleanup",
        forced,
        normalCloseCovered: false,
        ownedProcessesExited: ended.exitedNaturally,
        remaining: ended.remaining,
        mainIdentity: ownedMainIdentity,
      };
    } catch (error) {
      evidence.cleanupError = error.message;
      evidence.finalCleanup = {
        kind: "forced-test-cleanup",
        normalCloseCovered: false,
        ownedProcessesExited: false,
        remaining: error.remaining,
        error: error.message,
      };
    }
  }
  evidence.model = model?.snapshot();
  evidence.api = router?.snapshot();
  await router?.close();
  await model?.close();
  evidence.finishedAt = new Date().toISOString();
  await persist();
}
assert.deepEqual(await verifyPortableBuild(values["installed-root"]), artifact);
assert.equal(
  artifact.inputHash,
  sha(JSON.stringify(await captureBuildInputs(values["lex-root"]))),
);
assert.equal(sha(await fs.readFile(asar)), hostHash);
assert.equal(evidence.finalCleanup?.ownedProcessesExited, true);
