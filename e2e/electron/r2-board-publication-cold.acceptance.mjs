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
import { prepareR2EnvironmentProject } from "./fixtures/r2-environment-project.mjs";
import { singleFieldExpectedDocument } from "./fixtures/online-comparison.mjs";
import { verifyCustomerCandidateRecord } from "./fixtures/customer-local-library.mjs";
import {
  assertColdCandidateProof,
  assertColdPendingIntent,
  sourceHash,
  waitForColdSessionOpen,
} from "./fixtures/abs-cold-continuity.mjs";
import {
  assertUserStoppedAssistant,
  assertUserStopTerminalUi,
  readUserStopTerminalUi,
} from "./fixtures/abs-stop-presentation.mjs";
import {
  assertNativeSaveContinuationPhase,
  assertNoNativeSaveModelFailures,
} from "./fixtures/native-save-observation-fault.mjs";
import { installR2BoardPublicationFault } from "./fixtures/r2-board-publication-fault.mjs";
import { readOwnedSessionFile } from "./fixtures/r2-owned-session-file.mjs";
import { assertBoardPreparedProof } from "./fixtures/r2-board-prepared-proof.mjs";
import {
  createBoardPhaseGates,
  readBoardSessionStartup,
} from "./fixtures/r2-board-session-startup.mjs";
import {
  loadBoardColdResume,
  readCurrentBoardColdHandoff,
} from "./fixtures/r2-board-cold-resume.mjs";
import { upgradeInstalledChatProfileTarget } from "./fixtures/r2-installed-profile-upgrade.mjs";
import { boardOwnedProcessTree } from "./fixtures/r2-board-processes.mjs";

// Original board publication: private A + GUI C -> lost real board save ACK
// -> Chat Stop -> whole-host crash -> automatic original-ID read -> full ABC.
// Neither a model service nor a replacement receipt/proof executor is used.
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
  options: Object.fromEntries(
    [
      ...names,
      "resume-result",
      "resume-attempt-result",
      "previous-installed-root",
    ].map((name) => [name, { type: "string" }]),
  ),
});
assert.equal(
  process.env.AILY_R2_BOARD_PUBLICATION_HOST_WINDOW,
  "1",
  "Use the root-coordinated frozen-artifact host window",
);
for (const name of names.filter((name) => name !== "expected-input-hash"))
  assert.ok(path.isAbsolute(values[name] ?? ""));
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
assert.match(values["expected-input-hash"] ?? "", /^[a-f0-9]{64}$/);
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
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,ExecutablePath,@{Name='CreationDate';Expression={$_.CreationDate.ToUniversalTime().ToString('o')}} | ConvertTo-Json -Compress",
    ],
    { windowsHide: true, timeout: 15000 },
  );
  const list = JSON.parse(result.stdout);
  return Array.isArray(list) ? list : [list];
};
const ownedTree = async (pid) => {
  assert.equal(ownedMainIdentity?.ProcessId, pid);
  return boardOwnedProcessTree(await processes(), ownedMainIdentity);
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
const resume = values["resume-result"]
  ? await loadBoardColdResume({
      resultFile: values["resume-result"],
      testRoot: values["test-root"],
      artifact,
      hostHash,
      executable: values["executable-path"],
      installedRoot: values["installed-root"],
      priorAttemptFile: values["resume-attempt-result"],
      previousInstalledRoot: values["previous-installed-root"],
      sourceReadyFile: path.join(
        values["lex-root"],
        "packages/aily-agent/test-results/r2-board-cold-materialized-proof-source-ready.json",
      ),
      capturePublicationAttachment: (
        await import(
          pathToFileURL(
            path.join(
              values["lex-root"],
              "packages/aily-agent/dist/blockly/services/project/publication-observation.js",
            ),
          )
        )
      ).capturePublicationAttachment,
      processes: await processes(),
      collectorPids: [process.pid],
    })
  : undefined;
const suite =
    resume?.suite ??
    (await fs.mkdtemp(path.join(values["test-root"], "r2-board-cold-"))),
  project = path.join(suite, "project");
const appData = path.join(suite, "appdata"),
  home = path.join(suite, "home"),
  temp = path.join(suite, "temp"),
  absPath = path.join(project, "project.abs");
if (!resume) for (const directory of [home, temp]) await fs.mkdir(directory);
const fixture =
  resume?.fixture ??
  (await prepareR2EnvironmentProject({
    directory: project,
    suite,
    boardsRoot: path.resolve(repo, "../aily-blockly-boards"),
    librariesRoot: path.resolve(repo, "../aily-blockly-libraries"),
  }));
const boardInput = {
  kind: "board-config",
  configKey: "R2Mode",
  configValue: "two",
};
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
  modelSuppliedGeneration: false,
  stages: [],
  tools: [],
  launches: [],
  sessionCommands: [],
  sessionResponses: [],
  startup: {},
  abortCommands: [],
  abortResponses: [],
  resources: [],
};
if (resume)
  Object.assign(evidence, {
    combinedSameSuite: true,
    standalonePass: false,
    resumedProvenance: resume.provenance,
    priorProcessAudit: resume.processAudit,
    priorVerified: {
      resultFile: values["resume-result"],
      resultHash: resume.provenance.originalResultHash,
      stagesNotReplayed: ["A", "board", "Stop", "kill"],
    },
    g0: resume.previous.g0,
    guiC: resume.previous.guiC,
    beforeStop: resume.previous.beforeStop,
    firstTurnStop: resume.previous.firstTurnStop,
    firstTurnStopUi: resume.previous.firstTurnStopUi,
    preDispatchCheckpoint: resume.previous.preDispatchCheckpoint,
    candidateA: resume.previous.candidateA,
    candidateProof: resume.previous.candidateProof,
    lostBoardAck: resume.previous.lostBoardAck,
    finalInitialFault: resume.previous.finalInitialFault,
  });
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
  sessionId,
  snapshot,
  baseline,
  baseSource,
  sourceA,
  generation;
let expectedSaved,
  requestId,
  held = false,
  release,
  faultInstalled = false,
  coldReopened = false,
  originalHostPid,
  backup,
  archiveBytes;
const seen = new Set(),
  abortIds = new Set();
if (resume) {
  ({
    sessionId,
    baseline,
    baseSource,
    sourceA,
    generation,
    expectedSaved,
    requestId,
    originalHostPid,
    backup,
    archiveBytes,
  } = resume);
  for (const id of resume.originalCallIds) seen.add(id);
}
const continuationUserTurn = resume?.continuationUserTurn ?? 2;
evidence.continuationUserTurn = continuationUserTurn;
const phaseGates = createBoardPhaseGates({
  coldUserTurn: continuationUserTurn,
});
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
      ["project.abi", "project.abs", "project.abs.map.json"].map(
        async (name) => [
          name,
          sourceHash(await fs.readFile(path.join(project, name))),
        ],
      ),
    ),
  );
const faultState = () =>
  app.evaluate(
    () =>
      globalThis.__ailyR2BoardPublicationFault?.snapshot() ?? {
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
      noticeTitle: notice?.data?.title ?? null,
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
  let registry;
  if (!sessionId) {
    const startup = await readBoardSessionStartup({
      commands: evidence.sessionCommands,
      responses: evidence.sessionResponses,
      project,
      readRegistry: () => loaded.e2e("session.list"),
    });
    if (!startup) return;
    sessionId = startup.ready.sessionId;
    evidence.startup.ready = startup.ready;
    evidence.startup.firstRegistryReadAt = startup.readStartedAt;
    evidence.startup.firstRegistryResponseAt = startup.readCompletedAt;
    registry = startup.registry;
    await persist();
  }
  const sessions = (
    registry ?? (await loaded.e2e("session.list"))
  ).sessions.filter((value) => same(value.cwd, project));
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].sessionId, sessionId);
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
    if (message.toolCallId === "uncertain-original-board") {
      assert.equal(message.isError, true);
      assert.equal(result.saveOutcome, "unknown");
      assert.equal(result.observation?.resultKnown, false);
      assert.equal(
        result.observation?.reason,
        "transport",
        "A protocol rejection is not an ACK-loss scenario",
      );
      evidence.pendingSave = result.pendingSave;
    } else
      assert.equal(
        message.isError === true,
        false,
        name + ": " + textOf(message).slice(0, 1000),
      );
    if (message.toolCallId === "export-g0") {
      generation = result.generation;
      baseSource = result.abs;
      sourceA = baseSource.replace(
        `${fixture.blockType}(100)`,
        `${fixture.blockType}(101)`,
      );
      assert.notEqual(sourceA, baseSource);
      baseline = await document();
      evidence.g0 = {
        generation,
        document: baseline,
        mirrors: await mirrors(),
      };
    }
    if (phaseGates.expectsResult(message.toolCallId))
      phaseGates.releaseResult(message.toolCallId);
  }
  if (
    coldReopened &&
    !evidence.coldUserTurnObserved &&
    snapshot.messages.filter((value) => value.role === "user").length ===
      continuationUserTurn
  ) {
    phaseGates.releaseColdUserTurn(continuationUserTurn);
    evidence.coldUserTurnObserved = { sessionId, at: Date.now() };
  }
  evidence.phaseGates = phaseGates.snapshot();
};
const settle = async (users, ready = () => true) => {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    assertNoNativeSaveModelFailures(model.snapshot().failures);
    await observe();
    if (
      snapshot?.isIdle &&
      !snapshot.isStreaming &&
      snapshot.messages.filter((value) => value.role === "user").length ===
        users &&
      ready(snapshot)
    ) {
      await fs.writeFile(
        path.join(values.output, "session-" + users + ".json"),
        JSON.stringify(snapshot, null, 2),
      );
      return;
    }
    await wait(150);
  }
  throw Error(
    "Installed Chat failed to settle this exact original save scenario",
  );
};
const submit = async (prompt) => {
  await trust();
  await loaded.frame
    .locator('.aily-chat-composer-input[role="textbox"]')
    .fill(prompt);
  const send = loaded.frame.locator("button.primary-action.send-action");
  await send.waitFor({ state: "visible", timeout: 15000 });
  evidence.startup.firstUserSubmitAt ??= Date.now();
  await send.click();
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
  throw Error("Original save observation left a runtime/notice/recovery gate");
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
  evidence.launches.push({ attempt, hostPid, at: Date.now() });
  await persist();
  ownedMainIdentity = (await processes()).find(
    (value) => value.ProcessId === hostPid,
  );
  assert.ok(
    ownedMainIdentity &&
      same(ownedMainIdentity.ExecutablePath, values["executable-path"]),
  );
  assert.equal(await app.evaluate(({ app }) => app.isPackaged), true);
  if (attempt) {
    // Install before Chat/session startup; session restoration may observe the
    // pending publication before the next user turn reaches the composer.
    const descriptorPath = path.join(
      home,
      ".aily-blockly/cli-bridge",
      hostPid + ".json",
    );
    let descriptor;
    const until = Date.now() + 30000;
    while (!descriptor && Date.now() < until) {
      try {
        descriptor = JSON.parse(await fs.readFile(descriptorPath, "utf8"));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        await wait(50);
      }
    }
    assert.equal(descriptor?.pid, hostPid);
    evidence.coldObserver = await app.evaluate(
      installR2BoardPublicationFault,
      JSON.stringify({
        project,
        appData,
        pid: hostPid,
        port: descriptor.port,
        previousGeneration: generation,
        expectedDocument: expectedSaved,
        input: boardInput,
        observationOnly: true,
        requestId,
        originalTargetPid: originalHostPid,
      }),
    );
    assert.equal(evidence.coldObserver.available, true);
    faultInstalled = true;
    evidence.coldObserverInstalledAt = Date.now();
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
  evidence.launches.at(-1).websocketListenerInstalledAt = Date.now();
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
          [
            "session.open",
            "session.openSubscribe",
            "session.create",
            "session.subscribe",
            "prompt",
          ].includes(command?.type)
        )
          evidence.sessionCommands.push({
            attempt,
            id: value.id,
            type: command.type,
            sessionId: command.sessionId ?? command.options?.sessionId,
            cwd: command.options?.cwd,
            at: Date.now(),
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
        if (evidence.sessionCommands.some((command) => command.id === value.id))
          evidence.sessionResponses.push({
            id: value.id,
            ok: value.ok,
            subscribed: value.result?.subscribed,
            sessionId: value.result?.snapshot?.sessionId,
            cwd: value.result?.snapshot?.cwd,
            errorCode: value.error?.code,
            errorMessage: value.error?.message,
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
  // Cold recovery belongs to the product. Never click a recent item, issue an
  // open RPC or replace the original session to make this assertion pass.
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
    nextTool: async ({ turn, step, previousResult }) => {
      assertNoNativeSaveModelFailures(model.snapshot().failures);
      if (turn !== 0)
        assert.equal(
          coldReopened,
          true,
          "Provider retry cannot impersonate a cold second user turn",
        );
      await phaseGates.waitAfterResult({
        turn: resume ? turn + 1 : turn,
        step,
        previousResult,
      });
      if (!resume && !turn) {
        if (step === 0)
          return native("load-board-tools", "tool_load", {
            names: ["abs_export", "abs_apply", "set_board_config"],
          });
        if (step === 1) return deferred("export-g0", "abs_export", { project });
        if (step === 2)
          return native("read-before-A", "read", { path: absPath });
        if (step === 3)
          return native("edit-A", "edit", {
            path: absPath,
            edits: [
              {
                oldText: `${fixture.blockType}(100)`,
                newText: `${fixture.blockType}(101)`,
              },
            ],
          });
        if (step === 4) {
          await page.evaluate(
            ({ project, id }) => {
              const editor = window.ng.getComponent(
                window.document.querySelector("app-blockly-editor"),
              );
              if (
                editor.projectService?.currentProjectPath &&
                editor.projectService.currentProjectPath !== project
              )
                throw Error("Foreign GUI root");
              const block = editor.blocklyService.workspace.getBlockById(id);
              if (!block) throw Error("Missing actual GUI C block");
              block.setFieldValue(201, "VALUE");
            },
            { project, id: fixture.cId },
          );
          expectedSaved = singleFieldExpectedDocument(
            baseline,
            fixture.cId,
            "VALUE",
            200,
            201,
          );
          assert.deepEqual(await document(), expectedSaved);
          assert.deepEqual(
            await mirrors(),
            evidence.g0.mirrors,
            "GUI C must remain dirty until the actual board publisher saves it",
          );
          evidence.guiC = { document: expectedSaved, mirrors: await mirrors() };
          const descriptor = JSON.parse(
            await fs.readFile(
              path.join(home, ".aily-blockly/cli-bridge", hostPid + ".json"),
              "utf8",
            ),
          );
          assert.equal(descriptor.pid, hostPid);
          evidence.faultInstall = await app.evaluate(
            installR2BoardPublicationFault,
            JSON.stringify({
              project,
              appData,
              pid: hostPid,
              port: descriptor.port,
              previousGeneration: generation,
              expectedDocument: expectedSaved,
              input: boardInput,
            }),
          );
          assert.equal(evidence.faultInstall.available, true);
          faultInstalled = true;
          return deferred("uncertain-original-board", "set_board_config", {
            project,
            config_key: boardInput.configKey,
            config_value: boardInput.configValue,
          });
        }
        assert.equal(step, 5);
        const proof = await faultState();
        evidence.lostBoardAck = proof;
        assert.ok(proof.drops >= 1);
        assert.deepEqual(proof.failures, []);
        assert.deepEqual(proof.unverifiedTerminalReplies, []);
        assert.equal(
          proof.commands.filter(
            (value) => value.operation === "set_board_config",
          ).length,
          1,
        );
        assert.ok(
          proof.terminals.every((value) => value.completeGuiCVerified === true),
        );
        requestId = proof.requestId;
        assert.match(requestId, /^pub2-[a-f0-9-]{36}$/i);
        assert.equal(
          evidence.tools.find(
            (value) => value.id === "uncertain-original-board",
          )?.result?.saveOutcome,
          "unknown",
        );
        assert.deepEqual(await document(), expectedSaved);
        held = true;
        await new Promise((resolve) => {
          release = resolve;
        });
        return undefined;
      }
      if (resume?.priorAttempt) {
        assert.equal(coldReopened, true);
        assert.equal(turn, 0);
        assert.equal(
          snapshot.messages.filter((m) => m.role === "user").length,
          3,
        );
      } else
        assertNativeSaveContinuationPhase({
          coldReopened,
          actualUserTurns: snapshot.messages.filter(
            (value) => value.role === "user",
          ).length,
          providerTurn: resume ? turn + 1 : turn,
        });
      if (step === 0) {
        if (resume?.priorAttempt) {
          evidence.coldHandoff = await readCurrentBoardColdHandoff({
            suite,
            project,
            home,
            sessionId,
            expectedUserTurns: continuationUserTurn,
            previousLeafId: resume.provenance.originalLeafId,
            generation,
            requestId,
            input: boardInput,
            candidateHash:
              resume.previous.beforeStop.pending.retainedCandidate.hash,
            binding: evidence.beforeStop.binding,
            originalReference: resume.provenance.originalReference,
          });
          return native("read-A-after-cold", "read", { path: absPath });
        }
        const pending = assertColdPendingIntent(snapshot, {
          project,
          sessionId,
          generation,
          source: sourceA,
        });
        const handoffPath = path.join(
          project,
          ".workspace-history/abs-candidate-handoffs",
          pending.retainedCandidateHandoff.recordHash.slice(7) + ".json",
        );
        const bytes = await fs.readFile(handoffPath),
          record = JSON.parse(bytes);
        assert.equal(
          sourceHash(bytes),
          pending.retainedCandidateHandoff.recordHash,
        );
        assert.equal(record.intentGeneration, generation);
        assert.equal(record.saveRequest.requestId, requestId);
        assert.equal(record.saveRequest.state, "completed");
        assert.deepEqual(record.saveRequest.input, boardInput);
        assert.equal(record.editProof.origin.generation, generation);
        assert.equal(
          record.editProof.origin.acceptedMapHash,
          evidence.beforeStop.binding.mapHash.slice(7),
        );
        for (const [name, key] of [
          ["abi", "abiHash"],
          ["abs", "absHash"],
          ["map", "mapHash"],
        ])
          assert.equal(record.hashes[name], evidence.beforeStop.binding[key]);
        evidence.coldHandoff = {
          reference: pending.retainedCandidateHandoff,
          record,
        };
        return native("read-A-after-cold", "read", { path: absPath });
      }
      if (step === 1)
        return native("edit-B-after-cold", "edit", {
          path: absPath,
          edits: [
            {
              oldText: `${fixture.blockType}(300)`,
              newText: `${fixture.blockType}(301)`,
            },
          ],
        });
      if (step === 2)
        return deferred("apply-A-B-C-after-cold", "abs_apply", {
          project,
          absPath,
        });
      assert.equal(step, 3);
      return undefined;
    },
  });
  router = await createLocalChatApiRouter({
    operationOrigin: model.origin,
    installedRoot: values["installed-root"],
  });
  if (resume?.upgrade)
    evidence.profileUpgrade = await upgradeInstalledChatProfileTarget({
      appData,
      suite,
      ownedTestRoot: values["test-root"],
      from: resume.upgrade.from,
      to: resume.upgrade.to,
      verifyPortableBuild,
    });
  profile = await prepareInstalledChatProfile({
    appData,
    installedRoot: values["installed-root"],
    apiBase: router.origin,
    baseConfigPath: path.join(repo, "electron/config/config.json"),
    resourceAppData: values["resource-root"],
    token: router.token,
    reuseExisting: !!resume,
  });
  if (!resume) {
    await phase("pending-A-GUI-C-real-board-publication-lost-ACK");
    await launch(0);
    await submit(
      "Keep private edit A unapplied, change the unrelated canvas field, then set the board mode and save the current canvas. I will stop before continuing.",
    );
    const deadline = Date.now() + 150000;
    while (!held && Date.now() < deadline) {
      assertNoNativeSaveModelFailures(model.snapshot().failures);
      await observe();
      await wait(100);
    }
    assert.equal(
      held,
      true,
      "The actual board publication must commit and lose its terminal reply before Stop",
    );
    const pending = assertColdPendingIntent(snapshot, {
      project,
      sessionId,
      generation,
      source: sourceA,
    });
    backup = pending.retainedCandidateBackup;
    evidence.candidateA = await verifyCustomerCandidateRecord({
      project,
      backup,
      candidateHash: sourceHash(sourceA),
      intentGeneration: generation,
    });
    archiveBytes = await fs.readFile(backup.path);
    evidence.candidateProof = assertColdCandidateProof(
      JSON.parse(archiveBytes),
      {
        project,
        source: sourceA,
        baseSource,
        generation,
      },
    );
    const handoffPath = path.join(
      project,
      ".workspace-history/abs-candidate-handoffs",
      pending.retainedCandidateHandoff.recordHash.slice(7) + ".json",
    );
    const handoffBytes = await fs.readFile(handoffPath),
      handoff = JSON.parse(handoffBytes),
      binding = evidence.lostBoardAck.terminals.at(-1).binding;
    assert.equal(
      sourceHash(handoffBytes),
      pending.retainedCandidateHandoff.recordHash,
    );
    assert.equal(handoff.saveRequest.state, "prepared");
    assert.equal(handoff.saveRequest.requestId, requestId);
    assert.deepEqual(handoff.saveRequest.input, boardInput);
    assert.equal(handoff.saveRequest.targetPid, hostPid);
    assert.equal(handoff.intentGeneration, generation);
    assert.equal(handoff.editProof.origin.generation, generation);
    const { sessionFile, bytes: jsonlBytes } = await readOwnedSessionFile({
      suite,
      home,
      project,
      sessionId,
    });
    assert.ok(
      inside(suite, sessionFile),
      "Read only the exact owned session JSONL",
    );
    const jsonl = jsonlBytes
      .toString("utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    assert.equal(jsonl[0].id, sessionId);
    const durableHandoff = jsonl.findLast(
      (entry) =>
        entry.type === "custom" &&
        entry.customType === "aily.abs-workflow" &&
        entry.data?.retainedCandidateHandoff?.recordHash ===
          pending.retainedCandidateHandoff.recordHash,
    );
    assert.ok(
      durableHandoff,
      "Prepared A/input must exist in original Pi JSONL before the native mutation is sent",
    );
    assert.ok(
      Date.parse(durableHandoff.timestamp) <=
        evidence.lostBoardAck.commands.find(
          (command) => command.operation === "set_board_config",
        ).at,
    );
    evidence.preDispatchCheckpoint = {
      sessionFile,
      sessionId,
      entryId: durableHandoff.id,
      timestamp: durableHandoff.timestamp,
      reference: durableHandoff.data.retainedCandidateHandoff,
      jsonlHash: sourceHash(jsonlBytes),
      owner: handoff.owner,
      saveRequest: handoff.saveRequest,
    };
    for (const [file, key, short] of [
      ["project.abi", "abiHash", "abi"],
      ["project.abs", "absHash", "abs"],
      ["project.abs.map.json", "mapHash", "map"],
    ]) {
      assert.equal(
        sourceHash(await fs.readFile(path.join(project, file))),
        binding[key],
      );
      assert.equal(handoff.hashes[short], evidence.g0.mirrors[file]);
    }
    assert.equal(
      handoff.editProof.origin.mapHash,
      evidence.g0.mirrors["project.abs.map.json"].slice(7),
    );
    const preparedProof = assertBoardPreparedProof({
      bytes: handoffBytes,
      reference: pending.retainedCandidateHandoff,
      project,
      generation,
      baseSource,
      source: sourceA,
      mirrors: evidence.g0.mirrors,
      requestId,
      input: boardInput,
      targetPid: hostPid,
      attachment: evidence.lostBoardAck.terminals.at(-1).attachment,
    });
    evidence.beforeStop = {
      pending,
      handoffPath,
      handoffHash: sourceHash(handoffBytes),
      mirrors: await mirrors(),
      binding,
      preparedProof,
    };
    await phase("actual-Chat-Stop-before-board-observation");
    await loaded.frame.locator("button.primary-action.stop-action").click();
    const interruptedUntil = Date.now() + 15000;
    while (
      !model.snapshot().interactions.find((value) => value.turn === 0)
        ?.interrupted &&
      Date.now() < interruptedUntil
    )
      await wait(100);
    assert.equal(
      model.snapshot().interactions.find((value) => value.turn === 0)
        ?.interrupted,
      true,
    );
    release();
    release = undefined;
    await settle(1);
    evidence.firstTurnStop = assertUserStoppedAssistant(snapshot);
    await loaded.frame
      .locator(
        '.x-aily-interruption-divider[role="status"], .x-aily-interruption-text[role="status"]',
      )
      .first()
      .waitFor({ state: "visible", timeout: 15000 });
    evidence.firstTurnStopUi = await loaded.frame.evaluate(
      readUserStopTerminalUi,
    );
    assertUserStopTerminalUi(evidence.firstTurnStopUi);
    assert.equal(evidence.abortCommands.length, 1);
    assert.equal(evidence.abortCommands[0].sessionId, sessionId);
    assert.ok(
      evidence.abortResponses.some(
        (value) => value.ok && value.accepted === true,
      ),
    );
    await idle();
    assert.deepEqual(await mirrors(), evidence.beforeStop.mirrors);
    assertColdPendingIntent(snapshot, {
      project,
      sessionId,
      generation,
      source: sourceA,
    });
    evidence.finalInitialFault = await faultState();
    assert.deepEqual(evidence.finalInitialFault.failures, []);
    assert.equal(
      evidence.finalInitialFault.commands.filter(
        (value) => value.operation === "set_board_config",
      ).length,
      1,
    );
    assert.ok(
      evidence.finalInitialFault.commands.every(
        (value) => value.requestId === requestId,
      ),
    );
    await app.evaluate(() =>
      globalThis.__ailyR2BoardPublicationFault.restore(),
    );
    faultInstalled = false;
    await phase("whole-host-kill-and-product-AUTO-original-project-session");
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
            throw Error("Refuse unrelated termination");
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
  } else {
    await phase("same-suite-cold-only-original-Stop-already-verified");
    evidence.crashCleanup = {
      originalMainExited: true,
      remaining: [],
      processAudit: resume.processAudit,
      priorFalseCleanupPreserved: true,
      normalCloseCovered: false,
    };
  }
  await launch(1);
  await observe();
  assert.deepEqual(await document(), expectedSaved);
  assert.deepEqual(await mirrors(), evidence.beforeStop.mirrors);
  coldReopened = true;
  await phase("AUTO-original-board-status-and-B-omitted-generation-apply");
  await submit(
    "Continue the retained edit A, change the third field from 300 to 301, and apply complete A+B while preserving my saved canvas C in this same project.",
  );
  await settle(continuationUserTurn);
  evidence.coldObservation = await faultState();
  assert.deepEqual(evidence.coldObservation.failures, []);
  assert.deepEqual(evidence.coldObservation.unverifiedTerminalReplies, []);
  assert.ok(
    evidence.coldObservation.commands.some(
      (value) =>
        value.operation === "project_publication_status" &&
        value.requestId === requestId,
    ),
  );
  assert.equal(
    evidence.coldObservation.commands.filter(
      (value) => value.operation === "set_board_config",
    ).length,
    0,
  );
  assert.ok(
    evidence.coldObservation.commands.every(
      (value) => JSON.stringify(value.input) === JSON.stringify(boardInput),
    ),
  );
  assert.ok(
    evidence.coldObservation.terminals.some(
      (value) => value.requestId === requestId,
    ),
  );
  await app.evaluate(() => globalThis.__ailyR2BoardPublicationFault.restore());
  faultInstalled = false;
  assert.ok(
    evidence.tools
      .find((value) => value.id === "read-A-after-cold")
      ?.text.includes(`${fixture.blockType}(101)`),
  );
  const applied = evidence.tools.find(
    (value) => value.id === "apply-A-B-C-after-cold",
  )?.result;
  assert.equal(applied?.ok, true);
  assert.equal(applied.publication?.status, "COMMITTED");
  assert.equal(applied.applyVerification?.ok, true);
  assert.equal(applied.absPersistence?.verified, true);
  assert.equal(applied.requiresReload, false);
  const expected = singleFieldExpectedDocument(
    singleFieldExpectedDocument(
      expectedSaved,
      fixture.blockId,
      "VALUE",
      100,
      101,
    ),
    fixture.bId,
    "VALUE",
    300,
    301,
  );
  assert.deepEqual(await document(), expected);
  assert.deepEqual(
    JSON.parse(await fs.readFile(path.join(project, "project.abi"), "utf8")),
    expected,
  );
  for (const [file, key] of [
    ["project.abi", "abiHash"],
    ["project.abs", "absHash"],
    ["project.abs.map.json", "mapHash"],
  ])
    assert.equal(
      sourceHash(await fs.readFile(path.join(project, file))),
      applied.receipt.output.binding[key],
    );
  assert.equal(
    callsOf(snapshot).filter((value) => value.actualName === "set_board_config")
      .length,
    1,
  );
  assert.equal(
    callsOf(snapshot).filter((value) => value.actualName === "abs_apply")
      .length,
    1,
  );
  assert.ok(
    !callsOf(snapshot).some((value) =>
      [
        "project_create",
        "project_fork",
        "project_recover",
        "project_open",
        "app_open",
        "app_reload",
      ].includes(value.actualName),
    ),
  );
  assert.ok(
    callsOf(snapshot)
      .filter((value) => value.actualName === "abs_apply")
      .every(
        (value) =>
          !(
            "generation" in
            (value.name === "tool_invoke"
              ? value.arguments.arguments
              : value.arguments)
          ),
      ),
  );
  await phase("real-UI-save-completion-and-idle");
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
        return result;
      } finally {
        call.settled = true;
      }
    };
    domain.save = wrapper;
    window.__r2BoardUiSave = {
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
      () =>
        window.__r2BoardUiSave.calls.some(
          (call) => call.settled && call.success === true,
        ),
      undefined,
      { timeout: 30000 },
    );
    evidence.uiSave = await page.evaluate(() => window.__r2BoardUiSave.calls);
    assert.equal(evidence.uiSave.length, 1);
    assert.notEqual(evidence.uiSave[0].partial, true);
  } finally {
    await page.evaluate(() => {
      window.__r2BoardUiSave.restore();
      delete window.__r2BoardUiSave;
    });
  }
  assert.deepEqual(await document(), expected);
  assert.deepEqual(
    JSON.parse(await fs.readFile(path.join(project, "project.abi"), "utf8")),
    expected,
  );
  assert.equal(
    JSON.parse(await fs.readFile(path.join(project, "package.json"), "utf8"))
      .projectConfig.R2Mode,
    "two",
  );
  evidence.final = {
    state: await idle(),
    mirrors: await mirrors(),
    sessionId: snapshot.sessionId,
    document: expected,
  };
  assert.ok(same(evidence.final.state.project, project));
  assert.ok(
    evidence.final.state.recentProjects.every((value) => same(value, project)),
  );
  assert.ok((await fs.readFile(backup.path)).equals(archiveBytes));
  assert.equal(model.snapshot().createCount, resume ? 1 : 2);
  assert.deepEqual(model.snapshot().failures, []);
  await page.screenshot({
    path: path.join(values.output, "final-full-ABC.png"),
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
    evidence.finalSaveFault = await faultState().catch((error) => ({
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
  phaseGates.cancel(
    new DOMException("Owned Board acceptance cleanup", "AbortError"),
  );
  evidence.phaseGates = phaseGates.snapshot();
  release?.();
  if (faultInstalled && app) {
    evidence.finalSaveFault ??= await faultState().catch((error) => ({
      observationError: error.message,
    }));
    await app
      .evaluate(() => globalThis.__ailyR2BoardPublicationFault?.restore())
      .catch((error) => {
        evidence.faultRestoreError = error.message;
      });
  }
  if (app) {
    try {
      assert.equal(ownedMainIdentity?.ProcessId, hostPid);
      const tree = await ownedTree(hostPid),
        current = tree.find((value) => value.ProcessId === hostPid);
      let forced = false;
      if (current) {
        assert.equal(current.CreationDate, ownedMainIdentity.CreationDate);
        assert.ok(same(current.ExecutablePath, values["executable-path"]));
        const literal = (value) =>
          "'" + String(value).replace(/'/g, "''") + "'";
        const script = `
$r2Owned = Get-CimInstance Win32_Process -Filter 'ProcessId = ${hostPid}' -ErrorAction Stop
if (-not $r2Owned -or $r2Owned.CreationDate.ToUniversalTime().ToString('o') -cne ${literal(ownedMainIdentity.CreationDate)} -or
    [IO.Path]::GetFullPath([string]$r2Owned.ExecutablePath) -ine [IO.Path]::GetFullPath(${literal(values["executable-path"])})) {
  throw 'Refuse cleanup after Main PID creation or executable changed'
}
Stop-Process -Id ${hostPid} -Force -ErrorAction Stop
`;
        const closed = app.waitForEvent("close", { timeout: 15000 });
        await exec(
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-Command", script],
          { windowsHide: true, timeout: 20000 },
        );
        forced = true;
        await closed;
      }
      const ended = await exited(tree);
      evidence.finalCleanup = {
        kind: "forced-test-cleanup",
        forced,
        normalCloseCovered: false,
        ownedProcessesExited: ended.exitedNaturally,
        remaining: ended.remaining,
      };
    } catch (error) {
      evidence.cleanupError = error.message;
      evidence.finalCleanup = {
        kind: "forced-test-cleanup",
        normalCloseCovered: false,
        ownedProcessesExited: false,
        remaining: error.remaining,
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
if (resume)
  assert.equal(
    sourceHash(await fs.readFile(values["resume-result"])),
    resume.provenance.originalResultHash,
  );
if (resume?.priorAttempt)
  assert.equal(
    sourceHash(await fs.readFile(values["resume-attempt-result"])),
    resume.provenance.priorAttemptHash,
  );
