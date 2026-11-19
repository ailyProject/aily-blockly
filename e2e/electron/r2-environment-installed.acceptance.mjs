import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
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
import {
  assertColdPendingIntent,
  assertColdCandidateProof,
  sourceHash,
  waitForColdSessionOpen,
} from "./fixtures/abs-cold-continuity.mjs";
import { verifyCustomerCandidateRecord } from "./fixtures/customer-local-library.mjs";
import { environmentSessionStartup } from "./fixtures/r2-environment-session.mjs";
import { createEnvironmentPhaseGates } from "./fixtures/r2-environment-gates.mjs";
import { loadEnvironmentResume } from "./fixtures/r2-environment-resume.mjs";
import { assertEnvironmentApplyCall } from "./fixtures/r2-environment-apply-call.mjs";
import {
  assertCapturedEnvironmentProcess,
  remainingEnvironmentProcesses,
  environmentProcessStopScript,
  selectEnvironmentProcessTree,
} from "./fixtures/r2-environment-cleanup.mjs";

// One live, offline environment interaction. No previous kill/Stop replay and
// no replacement tool executor, publication evidence or native runtime loader.
const repo = fileURLToPath(new URL("../../", import.meta.url)),
  names = [
    "executable-path",
    "installed-root",
    "lex-root",
    "resource-root",
    "test-root",
    "output",
    "expected-input-hash",
  ];
const { values } = parseArgs({
  options: {
    ...Object.fromEntries(names.map((name) => [name, { type: "string" }])),
    "resume-result": { type: "string" },
  },
});
assert.equal(
  process.env.AILY_R2_ENVIRONMENT_HOST_WINDOW,
  "1",
  "Use only the root-coordinated packaged HOST window",
);
for (const name of names.filter((name) => name !== "expected-input-hash"))
  assert.ok(path.isAbsolute(values[name] ?? ""), name);
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
const same = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
assert.ok(inside(path.join(repo, "e2e/test-results"), values.output));
assert.ok(
  inside(path.join(values["resource-root"], "dev-tests"), values["test-root"]),
);
assert.ok(
  os.freemem() >= 1024 ** 3,
  "One functional host; never terminate unrelated applications",
);
const sha = (value) => createHash("sha256").update(value).digest("hex"),
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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
const sdkModule = (name) =>
  import(
    pathToFileURL(
      path.join(values["lex-root"], "packages/aily-agent/dist", name + ".js"),
    ).href
  );
const { captureDependencyEnvironmentTree, dependencyEnvironmentFiles } =
  await sdkModule("extensions/pi-workspace-history/dependency-environment");
const { capturePublicationAttachment, samePublicationAttachment } =
  await sdkModule("blockly/services/project/publication-observation");
const asar = path.join(
    path.dirname(values["executable-path"]),
    "resources/app.asar",
  ),
  hostHash = sha(await fs.readFile(asar));
const resume = values["resume-result"]
  ? await loadEnvironmentResume({
      resultFile: values["resume-result"],
      testRoot: values["test-root"],
      artifact,
      hostHash,
      capturePublicationAttachment,
      samePublicationAttachment,
      captureDependencyEnvironmentTree,
      dependencyEnvironmentFiles,
    })
  : undefined;
await fs.mkdir(values.output, { recursive: false });
await fs.mkdir(values["test-root"], { recursive: true });
const suite =
    resume?.suite ??
    (await fs.mkdtemp(path.join(values["test-root"], "r2-environment-"))),
  project = path.join(suite, "project");
const appData = path.join(suite, "appdata"),
  home = path.join(suite, "home"),
  temp = path.join(suite, "temp");
if (!resume) {
  await fs.mkdir(home);
  await fs.mkdir(temp);
}
const fixture =
  resume?.fixture ??
  (await prepareR2EnvironmentProject({
    directory: project,
    suite,
    boardsRoot: path.resolve(repo, "../aily-blockly-boards"),
    librariesRoot: path.resolve(repo, "../aily-blockly-libraries"),
  }));
const absPath = path.join(project, "project.abs"),
  evidence = {
    ok: false,
    suite,
    project,
    artifact,
    hostHash,
    actualInstalledChat: true,
    actualPackagedHost: true,
    actualManagedNpm: true,
    fixtureDefinitionsOnly: true,
    paidModelRequests: 0,
    compileRequests: 0,
    globalSdkHermetic: false,
    tools: [],
    phases: [],
    sessionCommands: [],
    sessionResponses: [],
    startup: {},
    startedAt: new Date().toISOString(),
    ...(resume
      ? {
          resumedProvenance: resume.provenance,
          combinedSameSuite: true,
          standalonePass: false,
          priorVerified: {
            s0: resume.previous.s0,
            library: resume.previous.library,
            privateA: resume.previous.privateA,
            originalProof: resume.previous.originalProof,
          },
        }
      : {}),
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
const mirrors = async () =>
  Object.fromEntries(
    await Promise.all(
      [
        "project.abi",
        "project.abs",
        "project.abs.map.json",
        ".aily/abs-sync/committed.json",
      ].map(async (name) => {
        try {
          return [
            name,
            sourceHash(await fs.readFile(path.join(project, name))),
          ];
        } catch (error) {
          if (error.code === "ENOENT") return [name, null];
          throw error;
        }
      }),
    ),
  );
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
const native = (id, name, args) => ({ id, name, arguments: args }),
  deferred = (id, name, args) =>
    native(id, "tool_invoke", { name, arguments: args });
let app,
  page,
  loaded,
  model,
  router,
  profile,
  hostPid,
  sessionId,
  snapshot,
  baseSource,
  sourceA,
  generation,
  baseline,
  expectedC,
  savedC;
let beforeLibrary, backup, archiveBytes;
const seen = new Set();
if (resume) {
  ({
    sessionId,
    baseSource,
    sourceA,
    generation,
    baseline,
    expectedC,
    backup,
    archiveBytes,
  } = resume);
  savedC = {
    mirrors: resume.mirrors,
    head: {
      generation:
        resume.record.saveRequest?.state === "completed"
          ? JSON.parse(
              await fs.readFile(
                path.join(project, ".aily/abs-sync/committed.json"),
                "utf8",
              ),
            ).generation
          : undefined,
    },
  };
  for (const tool of resume.previous.tools) seen.add(tool.id);
  for (const id of resume.originalToolCallIds) seen.add(id);
}
const phaseGates = createEnvironmentPhaseGates();
const document = () =>
  page.evaluate(() =>
    JSON.parse(
      window.ng
        .getComponent(window.document.querySelector("app-blockly-editor"))
        .blocklyService.captureRecoverySnapshot().documentText,
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
      domain = component("app-header")?.projectService;
    const service = editor?.blocklyService,
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
  evidence.startup.firstRegistryReadAfterSubmitAt ??= Date.now();
  const sessions = (await loaded.e2e("session.list")).sessions.filter((value) =>
    same(value.cwd, project),
  );
  assert.ok(sessions.length <= 1);
  sessionId ??= sessions[0]?.sessionId;
  if (!sessionId) return;
  snapshot = (await loaded.e2e("session.read", { sessionId })).session;
  assert.equal(snapshot.sessionId, sessionId);
  assert.ok(same(snapshot.cwd, project));
  for (const message of snapshot.messages.filter(
    (value) => value.role === "toolResult",
  )) {
    if (seen.has(message.toolCallId)) continue;
    seen.add(message.toolCallId);
    const result = payloadOf(message);
    evidence.tools.push({
      id: message.toolCallId,
      name: message.toolName,
      isError: message.isError === true,
      result,
      ...(message.toolName === "read" ? { text: textOf(message) } : {}),
    });
    assert.equal(
      message.isError === true,
      false,
      message.toolCallId + ": " + textOf(message).slice(0, 1400),
    );
    if (message.toolCallId === "env-export-s0") {
      baseSource = result.abs;
      generation = result.generation;
      assert.equal(result.publication.status, "COMMITTED");
      sourceA = baseSource.replace(
        `${fixture.blockType}(100)`,
        `${fixture.blockType}(101)`,
      );
      assert.notEqual(sourceA, baseSource);
      baseline = await document();
      evidence.s0 = {
        generation,
        document: baseline,
        mirrors: await mirrors(),
      };
    }
    if (message.toolCallId === "env-install-library") {
      assert.equal(result.ok, true);
      assert.equal(result.persistence, "dependencies-only");
      assert.equal(result.runtimeSync?.ready, true);
      assert.equal(result.packageName, fixture.addedLibraryName);
      assert.match(result.originalRequestId, /^env1-[a-f0-9-]{36}$/i);
      assert.equal(result.originalExecutorPid, hostPid);
      evidence.library = await page.evaluate(
        async ({ project, blockType, requestId }) => {
          const domain = window.ng.getComponent(
            window.document.querySelector("app-header"),
          ).projectService;
          const editor = window.ng.getComponent(
            window.document.querySelector("app-blockly-editor"),
          );
          return {
            installed: !!window.Blockly.Blocks[blockType],
            registeredOwner:
              editor.blocklyService.blockTypeToLibMap.get(blockType)?.name,
            runtimeReady: editor.blocklyService.isLibraryRuntimeReady(),
            status: await window.libraryDependencies.status(project),
            originalEnvironment:
              await window.libraryDependencies.observeEnvironment(project, {
                requestId,
              }),
            sameWorkspaceProject: domain.currentProjectPath === project,
          };
        },
        {
          project,
          blockType: fixture.addedBlockType,
          requestId: result.originalRequestId,
        },
      );
      assert.equal(evidence.library.installed, true);
      assert.equal(evidence.library.registeredOwner, fixture.addedLibraryName);
      assert.equal(evidence.library.runtimeReady, true);
      assert.equal(evidence.library.sameWorkspaceProject, true);
      assert.equal(evidence.library.status.dirty, false);
      const originalEnvironment =
        evidence.library.originalEnvironment.environment;
      for (const environment of [result.environment, originalEnvironment]) {
        assert.equal(environment.version, 1);
        assert.equal(environment.requestId, result.originalRequestId);
        assert.ok(same(environment.project, project));
        assert.equal(environment.status, "completed");
        assert.equal(environment.current, true);
        assert.equal(environment.candidateApplied, false);
        assert.equal(environment.executor.version, 1);
        assert.equal(environment.executor.hostPid, hostPid);
        assert.equal(environment.observer.version, 1);
        assert.equal(environment.observer.hostPid, hostPid);
        assert.equal(environment.mutation.action, "install");
        assert.deepEqual(environment.mutation.packages, [
          fixture.addedLibraryName,
        ]);
        assert.ok(
          samePublicationAttachment(
            environment.attachment,
            capturePublicationAttachment(project),
          ),
        );
        assert.deepEqual(
          Object.keys(environment.hashes).sort(),
          Object.keys(dependencyEnvironmentFiles).sort(),
        );
        for (const [key, name] of Object.entries(dependencyEnvironmentFiles)) {
          let actual = null;
          try {
            actual = sourceHash(await fs.readFile(path.join(project, name)));
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
          }
          assert.equal(
            actual,
            environment.hashes[key],
            "Original environment output: " + name,
          );
        }
        assert.equal(environment.ownedPaths.length, 1);
        const owned = environment.ownedPaths[0];
        assert.equal(owned.path, "local-libraries/" + fixture.addedLibraryName);
        assert.equal(owned.exists, true);
        const actualTree = captureDependencyEnvironmentTree(
          project,
          owned.path,
        );
        assert.equal(actualTree.exists, true);
        assert.equal(actualTree.hash, owned.hash);
      }
      assert.deepEqual(
        originalEnvironment.executor,
        result.environment.executor,
      );
      assert.deepEqual(originalEnvironment.hashes, result.environment.hashes);
      assert.deepEqual(
        originalEnvironment.ownedPaths,
        result.environment.ownedPaths,
      );
      evidence.library.originalRequestVerified = true;
      const canonicalLibrary = path.join(
        project,
        "local-libraries",
        ...fixture.addedLibraryName.split("/"),
      );
      const installedLibrary = path.join(
        project,
        "node_modules",
        ...fixture.addedLibraryName.split("/"),
      );
      assert.equal(result.installMode, "symbolic-link");
      assert.equal(
        (await fs.lstat(installedLibrary)).isSymbolicLink(),
        true,
        "The managed local installation must retain its internal source link",
      );
      assert.ok(
        same(
          await fs.realpath(installedLibrary),
          await fs.realpath(canonicalLibrary),
        ),
      );
      evidence.library.actualInternalLink = {
        symbolicLink: true,
        target: await fs.realpath(installedLibrary),
      };
      assert.deepEqual(await document(), expectedC);
      assert.deepEqual(
        await mirrors(),
        beforeLibrary,
        "Pure library work cannot save GUI C or publish A/new Program head",
      );
      const pending = assertColdPendingIntent(snapshot, {
        project,
        sessionId,
        generation,
        source: sourceA,
      });
      backup = pending.retainedCandidateBackup;
      evidence.privateA = await verifyCustomerCandidateRecord({
        project,
        backup,
        candidateHash: sourceHash(sourceA),
        intentGeneration: generation,
      });
      archiveBytes = await fs.readFile(backup.path);
      evidence.originalProof = assertColdCandidateProof(
        JSON.parse(archiveBytes),
        { project, source: sourceA, baseSource, generation },
      );
      await page.screenshot({
        path: path.join(values.output, "library-runtime-S1-C-private-A.png"),
        fullPage: true,
      });
      phaseGates.release(message.toolCallId);
      evidence.phaseGates = phaseGates.snapshot();
    }
    if (message.toolCallId === "env-select-board") {
      assert.equal(result.ok, true);
      assert.equal(result.persisted, true);
      assert.equal(result.publication.status, "COMMITTED");
      assert.equal(result.environment?.status, "completed");
      assert.equal(result.environment?.current, true);
      assert.equal(result.candidateApplied, false);
      assert.match(result.projectionReceipt.requestId, /^pub2-/);
      assert.deepEqual(await document(), expectedC);
      assert.deepEqual(
        JSON.parse(
          await fs.readFile(path.join(project, "project.abi"), "utf8"),
        ),
        expectedC,
      );
      const packageAfterBoard = JSON.parse(
        await fs.readFile(path.join(project, "package.json"), "utf8"),
      );
      const canonicalLibrary = path.join(
        project,
        "local-libraries",
        ...fixture.addedLibraryName.split("/"),
      );
      const installedLibrary = path.join(
        project,
        "node_modules",
        ...fixture.addedLibraryName.split("/"),
      );
      assert.equal(
        (await fs.lstat(installedLibrary)).isSymbolicLink(),
        true,
        "Board publication cannot detach the managed internal library source",
      );
      assert.ok(
        same(
          await fs.realpath(installedLibrary),
          await fs.realpath(canonicalLibrary),
        ),
      );
      const dependencyAfterBoard =
        packageAfterBoard.dependencies[fixture.addedLibraryName];
      assert.match(
        dependencyAfterBoard,
        /^file:/,
        "Board publication must retain the library just installed by the same turn",
      );
      assert.ok(
        same(
          path.resolve(project, dependencyAfterBoard.slice(5)),
          canonicalLibrary,
        ),
        "The retained dependency must target the exact canonical local source",
      );
      assert.ok(
        (await fs.readFile(path.join(canonicalLibrary, "generator.js"))).equals(
          await fs.readFile(path.join(installedLibrary, "generator.js")),
        ),
      );
      evidence.libraryAfterBoard = await page.evaluate((type) => {
        const service = window.ng.getComponent(
          window.document.querySelector("app-blockly-editor"),
        ).blocklyService;
        return {
          definitionPresent: !!window.Blockly.Blocks[type],
          registeredOwner: service.blockTypeToLibMap.get(type)?.name,
          runtimeReady: service.isLibraryRuntimeReady(),
        };
      }, fixture.addedBlockType);
      assert.deepEqual(evidence.libraryAfterBoard, {
        definitionPresent: true,
        registeredOwner: fixture.addedLibraryName,
        runtimeReady: true,
      });
      assert.ok(
        (await fs.readFile(absPath, "utf8")).includes(
          `${fixture.blockType}(100)`,
        ),
        "Native board publication cannot publish private A",
      );
      const head = JSON.parse(
        await fs.readFile(
          path.join(project, ".aily/abs-sync/committed.json"),
          "utf8",
        ),
      );
      assert.equal(head.generation, result.publication.generation);
      const records = await fs.readdir(
        path.join(project, ".aily/dependency-recovery"),
      );
      const envRecord = await fs.readFile(
        path.join(
          project,
          ".aily/dependency-recovery",
          "environment-" + sha(result.environment.requestId),
          "checkpoint.json",
        ),
        "utf8",
      );
      const checkpoint = JSON.parse(envRecord);
      assert.equal(
        checkpoint.hash,
        sourceHash(JSON.stringify(checkpoint.payload)),
      );
      assert.equal(
        checkpoint.payload.request.programRef.request.requestId,
        result.projectionReceipt.requestId,
      );
      assert.equal(
        records.filter((value) => value.startsWith("environment-")).length > 0,
        true,
      );
      savedC = {
        result,
        mirrors: await mirrors(),
        environmentCheckpointHash: sourceHash(envRecord),
        head,
      };
      evidence.board = savedC;
      await page.screenshot({
        path: path.join(values.output, "board-published-C-private-A.png"),
        fullPage: true,
      });
      phaseGates.release(message.toolCallId);
      evidence.phaseGates = phaseGates.snapshot();
    }
  }
};
const settle = async (users, name) => {
  const deadline = Date.now() + 150000;
  if (!sessionId) {
    let startup;
    while (!startup && Date.now() < deadline) {
      startup = environmentSessionStartup(
        evidence.sessionCommands,
        evidence.sessionResponses,
        project,
      );
      if (!startup) await wait(100);
    }
    assert.ok(
      startup,
      "The actual UI must finish its original create/subscribe before registry observation",
    );
    sessionId = startup.sessionId;
    evidence.startup.ready = startup;
    evidence.startup.registryEligibleAt = Date.now();
    await persist();
  }
  while (Date.now() < deadline) {
    await observe();
    assert.deepEqual(model.snapshot().failures, []);
    if (
      snapshot?.isIdle &&
      !snapshot.isStreaming &&
      snapshot.messages.filter((message) => message.role === "user").length ===
        users
    ) {
      await fs.writeFile(
        path.join(values.output, name),
        JSON.stringify(snapshot, null, 2),
      );
      return;
    }
    await wait(120);
  }
  throw Error("Installed Chat did not settle the exact requested user turn");
};
const submit = async (text) => {
  await trust();
  await loaded.frame
    .locator('.aily-chat-composer-input[role="textbox"]')
    .fill(text);
  const send = loaded.frame.locator("button.primary-action.send-action");
  await send.waitFor({ state: "visible", timeout: 15000 });
  evidence.startup.firstUserSubmitAt ??= Date.now();
  await send.click();
};
const exec = promisify(execFile);
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
  const value = JSON.parse(result.stdout);
  return Array.isArray(value) ? value : [value];
};
const ownedTree = async () => {
  assert.equal(evidence.mainIdentity?.ProcessId, hostPid);
  return selectEnvironmentProcessTree(await processes(), evidence.mainIdentity);
};
try {
  model = await createAbsStopModel({
    nextTool: async ({ turn, step, previousResult }) => {
      if (resume) {
        assert.equal(
          turn,
          0,
          "Resume backend is only the third real user prompt; it cannot continue the old provider task",
        );
        await observe();
        assert.equal(
          snapshot.messages.filter((message) => message.role === "user").length,
          3,
        );
        return [
          native("env-resume-read-A", "read", { path: absPath }),
          native("env-resume-edit-B", "edit", {
            path: absPath,
            edits: [
              {
                oldText: `${fixture.blockType}(300)`,
                newText: `${fixture.blockType}(301)`,
              },
            ],
          }),
          deferred("env-resume-apply-ABC", "abs_apply", { project, absPath }),
        ][step];
      }
      await phaseGates.waitAfterResult({ turn, step, previousResult });
      if (turn === 0)
        return [
          native("env-load-tools", "tool_load", {
            names: [
              "abs_export",
              "abs_apply",
              "get_board_config",
              "set_board_config",
              "lib_install_local",
            ],
          }),
          deferred("env-export-s0", "abs_export", { project }),
          native("env-read-s0", "read", { path: absPath }),
          native("env-edit-A", "edit", {
            path: absPath,
            edits: [
              {
                oldText: `${fixture.blockType}(100)`,
                newText: `${fixture.blockType}(101)`,
              },
            ],
          }),
        ][step];
      assert.equal(turn, 1);
      return [
        deferred("env-install-library", "lib_install_local", {
          project,
          source: fixture.localLibrary,
        }),
        deferred("env-read-board", "get_board_config", { project }),
        deferred("env-select-board", "set_board_config", {
          project,
          config_key: "R2Mode",
          config_value: "two",
        }),
        native("env-read-A-after-board", "read", { path: absPath }),
        native("env-edit-B", "edit", {
          path: absPath,
          edits: [
            {
              oldText: `${fixture.blockType}(300)`,
              newText: `${fixture.blockType}(301)`,
            },
          ],
        }),
        deferred("env-apply-ABC", "abs_apply", { project, absPath }),
      ][step];
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
    ...(resume ? { reuseExisting: true } : {}),
  });
  const {
    ELECTRON_RUN_AS_NODE,
    AILY_CHILD_PATH,
    NODE_PATH,
    AILY_PORTABLE_ROOT,
    AILY_AUTH_FILE,
    ...env
  } = process.env;
  await phase("open-one-offline-owned-project");
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
  evidence.hostPid = hostPid;
  evidence.mainIdentity = (await processes()).find(
    (value) => value.ProcessId === hostPid,
  );
  assert.ok(
    evidence.mainIdentity?.CreationDate &&
      same(evidence.mainIdentity.ExecutablePath, values["executable-path"]),
  );
  if (resume) {
    assert.notEqual(hostPid, resume.previous.hostPid);
    assert.ok(
      !(await processes()).some(
        (value) => value.ProcessId === resume.previous.mainIdentity.ProcessId,
      ),
      "Original Main must have exited before readonly cold continuation",
    );
  }
  await app.context().route("**/*", (route) => {
    const url = new URL(route.request().url());
    return !["http:", "https:"].includes(url.protocol) ||
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      ? route.continue()
      : route.abort("blockedbyclient");
  });
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
        let message;
        try {
          message = JSON.parse(String(payload));
        } catch {
          return;
        }
        const command = message.command;
        if (
          message.channel !== "agent" ||
          ![
            "session.create",
            "session.open",
            "session.openSubscribe",
            "session.subscribe",
            "prompt",
          ].includes(command?.type)
        )
          return;
        evidence.sessionCommands.push({
          attempt: resume ? 1 : 0,
          id: message.id,
          type: command.type,
          cwd: command.options?.cwd,
          sessionId: command.sessionId ?? command.options?.sessionId,
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
          cwd: message.result?.snapshot?.cwd,
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
  await page.waitForFunction(() => {
    const element = window.document.querySelector("app-header");
    return element && window.ng?.getComponent(element)?.projectService;
  });
  if (!resume)
    await page.evaluate(async (project) => {
      const domain = window.ng.getComponent(
        window.document.querySelector("app-header"),
      ).projectService;
      await domain.initializeProjectDataSchema(project);
      if (!(await domain.projectOpen(project)))
        throw Error("Owned fixture did not open");
    }, project);
  await page.waitForFunction(
    (project) => {
      const element = window.document.querySelector("app-header");
      const domain =
        element && window.ng?.getComponent(element)?.projectService;
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
  evidence.mainCapability = await page.evaluate(() =>
    window.libraryDependencies.capabilities(),
  );
  assert.equal(evidence.mainCapability.dependencyEnvironmentVersion, 2);
  if (!resume) {
    await phase("real-core-tool-private-A");
    await submit(
      "Keep edit A to 101 private and unapplied. I will make a separate native environment change before continuing.",
    );
    await settle(1, "session-A.json");
    assert.deepEqual(await document(), baseline);
    assert.deepEqual(await mirrors(), evidence.s0.mirrors);
    await phase("real-GUI-dirty-C-and-managed-offline-library-install");
    await page.evaluate(
      ({ project, id }) => {
        const editor = window.ng.getComponent(
          window.document.querySelector("app-blockly-editor"),
        );
        if (
          editor.projectService?.currentProjectPath &&
          editor.projectService.currentProjectPath !== project
        )
          throw Error("Wrong GUI project");
        const block = editor.blocklyService.workspace.getBlockById(id);
        if (!block) throw Error("Missing actual C block");
        block.setFieldValue(201, "VALUE");
      },
      { project, id: fixture.cId },
    );
    expectedC = singleFieldExpectedDocument(
      baseline,
      fixture.cId,
      "VALUE",
      200,
      201,
    );
    assert.deepEqual(await document(), expectedC);
    beforeLibrary = await mirrors();
    assert.equal(
      await page.evaluate(
        (type) => !!window.Blockly.Blocks[type],
        fixture.addedBlockType,
      ),
      false,
    );
    await phase("real-board-tool-publisher-then-full-A-B-C");
    await submit(
      "Install the owned local library, select R2Mode two, preserve the existing canvas edit C, continue private A, change third field B to 301 and apply the complete program.",
    );
    await settle(2, "session-ABC.json");
  } else {
    await phase("AUTO-original-project-session-readonly-completed-board-tail");
    evidence.startup.originalSessionOpen = await waitForColdSessionOpen({
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
    await observe();
    assert.equal(snapshot.sessionId, resume.sessionId);
    assert.equal(
      snapshot.messages.filter((message) => message.role === "user").length,
      2,
    );
    assert.deepEqual(await document(), expectedC);
    assert.deepEqual(await mirrors(), resume.mirrors);
    const currentEnv = await page.evaluate(
      async ({ project, requestId, blockType }) => {
        const editor = window.ng.getComponent(
          document.querySelector("app-blockly-editor"),
        );
        return {
          environment: (
            await window.libraryDependencies.observeEnvironment(project, {
              requestId,
            })
          ).environment,
          definitionPresent: !!window.Blockly.Blocks[blockType],
          registeredOwner:
            editor.blocklyService.blockTypeToLibMap.get(blockType)?.name,
          runtimeReady: editor.blocklyService.isLibraryRuntimeReady(),
        };
      },
      {
        project,
        requestId: resume.environmentRequestId,
        blockType: fixture.addedBlockType,
      },
    );
    assert.equal(currentEnv.environment.requestId, resume.environmentRequestId);
    assert.equal(currentEnv.environment.status, "completed");
    assert.equal(currentEnv.environment.current, true);
    assert.equal(
      currentEnv.environment.executor.hostPid,
      resume.previous.hostPid,
    );
    assert.equal(currentEnv.environment.observer.hostPid, hostPid);
    assert.ok(
      samePublicationAttachment(
        currentEnv.environment.attachment,
        resume.record.saveRequest.attachment,
      ),
    );
    assert.deepEqual(currentEnv.environment.hashes, resume.environmentHashes);
    assert.equal(currentEnv.definitionPresent, true);
    assert.equal(currentEnv.registeredOwner, fixture.addedLibraryName);
    assert.equal(currentEnv.runtimeReady, true);
    const canonical = path.join(
        project,
        "local-libraries",
        ...fixture.addedLibraryName.split("/"),
      ),
      installed = path.join(
        project,
        "node_modules",
        ...fixture.addedLibraryName.split("/"),
      );
    assert.equal((await fs.lstat(installed)).isSymbolicLink(), true);
    assert.ok(same(await fs.realpath(installed), canonical));
    assert.ok((await fs.readFile(backup.path)).equals(archiveBytes));
    evidence.resumeStartup = {
      environment: currentEnv,
      sessionId,
      mirrors: await mirrors(),
      document: await document(),
      rawLeafId: snapshot.leafId,
    };
    await phase("third-user-read-A-edit-B-apply-omitted-generation");
    await submit(
      "Continue private A in this original project, change third field B from 300 to 301, and apply complete A+B while preserving my saved C and installed library.",
    );
    await settle(3, "session-ABC.json");
  }
  assert.ok(savedC, "The actual native board publication must be observed");
  const read = evidence.tools.find(
    (value) =>
      value.id === (resume ? "env-resume-read-A" : "env-read-A-after-board"),
  );
  assert.ok(read.text.includes(`${fixture.blockType}(101)`));
  const result = evidence.tools.find(
    (value) => value.id === (resume ? "env-resume-apply-ABC" : "env-apply-ABC"),
  )?.result;
  assert.equal(result.ok, true);
  assert.equal(result.publication.status, "COMMITTED");
  assert.equal(result.applyVerification.ok, true);
  assert.equal(result.absPersistence.verified, true);
  assert.equal(result.requiresReload, false);
  const expected = singleFieldExpectedDocument(
    singleFieldExpectedDocument(expectedC, fixture.blockId, "VALUE", 100, 101),
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
      result.receipt.output.binding[key],
    );
  assert.equal(result.receipt.validation.scope, "complete-generation");
  assert.equal(result.receipt.validation.ok, true);
  assert.ok(
    (await fs.readFile(backup.path)).equals(archiveBytes),
    "The original immutable A archive cannot be replaced",
  );
  if (resume) {
    const resumedCalls = snapshot.messages
      .filter((message) => message.role === "assistant")
      .flatMap((message) => message.content ?? [])
      .filter(
        (part) =>
          part.type === "toolCall" && part.id === "env-resume-apply-ABC",
      );
    assert.equal(resumedCalls.length, 1);
    assertEnvironmentApplyCall(resumedCalls[0], project, absPath);
    const newCalls = snapshot.messages
      .filter((message) => message.role === "assistant")
      .flatMap((message) => message.content ?? [])
      .filter(
        (part) =>
          part.type === "toolCall" &&
          !resume.originalToolCallIds.includes(part.id),
      );
    assert.deepEqual(
      newCalls.map((call) => call.id),
      ["env-resume-read-A", "env-resume-edit-B", "env-resume-apply-ABC"],
    );
    evidence.resumeNewToolCalls = newCalls.map((call) => ({
      id: call.id,
      name: call.name,
      arguments: call.arguments,
    }));
    await phase("resumed-real-UI-save-full-ABC");
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
      window.__r2EnvironmentResumeSave = {
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
          window.__r2EnvironmentResumeSave.calls.some(
            (call) => call.settled && call.success === true,
          ),
        undefined,
        { timeout: 30000 },
      );
      evidence.uiSave = await page.evaluate(
        () => window.__r2EnvironmentResumeSave.calls,
      );
      assert.equal(evidence.uiSave.length, 1);
      assert.notEqual(evidence.uiSave[0].partial, true);
    } finally {
      await page.evaluate(() => {
        window.__r2EnvironmentResumeSave.restore();
        delete window.__r2EnvironmentResumeSave;
      });
    }
    assert.deepEqual(await document(), expected);
    assert.deepEqual(
      JSON.parse(await fs.readFile(path.join(project, "project.abi"), "utf8")),
      expected,
    );
    assert.ok((await fs.readFile(backup.path)).equals(archiveBytes));
    const currentSessionBytes = await fs.readFile(resume.sessionFile);
    assert.ok(
      currentSessionBytes
        .subarray(0, resume.sessionBytes.length)
        .equals(resume.sessionBytes),
      "The original exact branch JSONL must remain an unmodified prefix",
    );
    evidence.resumedProvenance.originalSessionPrefixPreserved = true;
  }
  const idle = Date.now() + 30000;
  do {
    evidence.finalState = await state();
    if (
      !evidence.finalState.running &&
      !evidence.finalState.busy &&
      !evidence.finalState.blocked &&
      !evidence.finalState.recovery &&
      !evidence.finalState.noticeStop &&
      !evidence.finalState.noticeButtons
    )
      break;
    await wait(100);
  } while (Date.now() < idle);
  assert.deepEqual(
    { ...evidence.finalState, project: project },
    {
      project,
      ready: true,
      busy: false,
      blocked: false,
      recovery: false,
      running: false,
      noticeStop: false,
      noticeButtons: 0,
    },
  );
  assert.ok(same(evidence.finalState.project, project));
  assert.deepEqual(model.snapshot().failures, []);
  assert.equal(model.snapshot().createCount, resume ? 1 : 2);
  evidence.final = {
    document: expected,
    mirrors: await mirrors(),
    generation: result.publication.generation,
  };
  await page.screenshot({
    path: path.join(values.output, "final-full-A-B-C.png"),
    fullPage: true,
  });
  evidence.ok = true;
  if (resume) evidence.tailOk = true;
} catch (error) {
  evidence.error = {
    name: error.name,
    code: error.code,
    message: error.message,
    stack: error.stack,
  };
  if (page) {
    evidence.failureState = await state().catch((error) => ({
      error: error.message,
    }));
    await page
      .screenshot({
        path: path.join(values.output, "failure.png"),
        fullPage: true,
      })
      .catch(() => {});
  }
  if (loaded && sessionId)
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
  phaseGates.cancel(
    new DOMException("Environment driver cleanup", "AbortError"),
  );
  evidence.phaseGates = phaseGates.snapshot();
  if (app) {
    try {
      const tree = await ownedTree(),
        identity = evidence.mainIdentity;
      const original = tree.find((value) => value.ProcessId === hostPid);
      assert.ok(
        identity?.CreationDate,
        "No process may be terminated without its captured owned creation identity",
      );
      evidence.cleanup = {
        kind: "forced-test-cleanup",
        normalCloseCovered: false,
        ownedMain: identity,
        originalTree: tree,
        exactTerminations: [],
      };
      const deadline = Date.now() + 30000;
      const terminate = async (expected) => {
        const command = environmentProcessStopScript(expected);
        await exec(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            Buffer.from(command, "utf16le").toString("base64"),
          ],
          {
            windowsHide: true,
            timeout: Math.min(20000, Math.max(1, deadline - Date.now())),
          },
        );
        evidence.cleanup.exactTerminations.push(expected);
      };
      if (original) {
        assertCapturedEnvironmentProcess(original, identity);
        assert.ok(same(original.ExecutablePath, values["executable-path"]));
        await terminate(identity);
      }
      const attempted = new Set([hostPid]);
      do {
        const all = await processes();
        evidence.ownedRemaining = remainingEnvironmentProcesses(tree, all);
        if (!evidence.ownedRemaining.length) break;
        for (const expected of evidence.ownedRemaining) {
          if (attempted.has(expected.ProcessId) || Date.now() >= deadline)
            continue;
          assertCapturedEnvironmentProcess(
            all.find((value) => value.ProcessId === expected.ProcessId),
            expected,
          );
          attempted.add(expected.ProcessId);
          await terminate(expected);
        }
        await wait(300);
      } while (Date.now() < deadline);
      if (evidence.ownedRemaining.length)
        throw Error("Owned test process tree did not fully exit");
    } catch (error) {
      evidence.cleanupFailure = error.message;
      evidence.ok = false;
    }
  }
  evidence.transport = model?.snapshot();
  await router?.close();
  await model?.close();
  evidence.finishedAt = new Date().toISOString();
  await persist();
}
assert.equal(evidence.ok, true);
assert.deepEqual(evidence.ownedRemaining, []);
assert.deepEqual(await verifyPortableBuild(values["installed-root"]), artifact);
assert.equal(
  artifact.inputHash,
  sha(JSON.stringify(await captureBuildInputs(values["lex-root"]))),
);
assert.equal(sha(await fs.readFile(asar)), hostHash);
if (resume)
  assert.equal(
    sourceHash(await fs.readFile(values["resume-result"])),
    resume.provenance.originalResultHash,
  );
