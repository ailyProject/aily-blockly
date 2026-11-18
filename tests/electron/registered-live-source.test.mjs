// Offline tests of the evidence adapter, using small synthetic protocol
// samples in an owned temp directory. These are not Agent/Desktop acceptance.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  prepareRegisteredLiveCase,
  fillRegisteredLivePrompt,
  assertRegisteredLiveMutation,
  auditRegisteredLiveCase,
} from "../../e2e/electron/fixtures/registered-live-source.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const reply = (id, content, extra = {}) => ({
  role: "toolResult",
  toolCallId: id,
  content: [{ type: "text", text: content }],
  ...extra,
});
const call = (id, name, input) => ({
  role: "assistant",
  content: [{ type: "toolCall", id, name, arguments: input }],
});
async function fixture(t) {
  const ownedRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "registered-live-evidence-"),
    ),
    project = path.join(ownedRoot, "project");
  t.after(() => fs.rm(ownedRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(project, ".aily/abs-sync"), { recursive: true });
  const source =
    "# ABS Schema: 2\narduino_global()\narduino_setup()\narduino_loop()\n";
  const content = {
    "project.abi": '{"pages":[],"sharedModel":{}}',
    "project.abs": source,
    "project.abs.map.json": '{"generation":"fixture"}',
    ".aily/abs-sync/committed.json": '{"generation":"fixture"}',
  };
  for (const [name, bytes] of Object.entries(content))
    await fs.writeFile(path.join(project, name), bytes);
  const real = await fs.realpath(project),
    stat = await fs.stat(project, { bigint: true }),
    sessionId = "fixture-session",
    attachment = {
      version: 1,
      root: real,
      identity: Object.fromEntries(
        ["dev", "ino", "birthtimeNs"].map((key) => [key, String(stat[key])]),
      ),
    },
    working = {
      attachment,
      documentHash: "sha256:" + sha(content["project.abi"]),
    },
    reviewManifestFile = path.join(ownedRoot, "reviewed-native-commands.json"),
    options = {
      project: real,
      ownedRoot,
      reviewManifestFile,
      sessionId,
      working,
      desktopInstance: { pid: 101, createdAt: "first" },
    };
  return { ...options, source, options };
}
async function put(project, bytes) {
  bytes = Buffer.from(bytes);
  const hash = sha(bytes),
    filename = path.join(
      project,
      ".workspace-history/objects",
      hash.slice(0, 2),
      hash + ".blob",
    );
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.writeFile(filename, bytes);
  return { hash, bytes: bytes.length };
}
async function prepareCandidate(f, state, alias) {
  const base = {};
  for (const [name, text] of Object.entries({
    document: "{}",
    abs: f.source,
    map: "{}",
    contracts: "{}",
  }))
    base[name] = await put(f.project, text);
  base.published = null;
  const id = randomUUID(),
    owner = { sessionId: f.sessionId, intentAnchorId: "user-1" },
    originalRecord = {
      version: 1,
      kind: "agent",
      id,
      owner,
      project: { logicalId: sha(f.project), attachment: f.working.attachment },
      scope: { kind: "project" },
      base,
      source: base.abs,
      intent: { anchorId: "user-1" },
      derivation: { kind: "capture" },
    },
    original = {
      version: 1,
      id,
      revisionHash: (await put(f.project, JSON.stringify(originalRecord))).hash,
    },
    dirty = f.source.replace(
      state.firstLine,
      state.firstLine + "\n" + state.registeredLive.marker,
    ),
    edits = await put(
      f.project,
      JSON.stringify([
        {
          start: state.firstLine.length,
          end: state.firstLine.length,
          text: "\n" + state.registeredLive.marker,
        },
      ]),
    ),
    currentRecord = {
      ...originalRecord,
      parent: original,
      source: await put(f.project, dirty),
      derivation: { kind: "splices", edits },
    },
    current = {
      version: 1,
      id,
      revisionHash: (await put(f.project, JSON.stringify(currentRecord))).hash,
    };
  await fs.mkdir(path.dirname(path.join(f.project, alias)), {
    recursive: true,
  });
  await fs.writeFile(path.join(f.project, alias), f.source);
  const result = {
      ok: true,
      workingCandidate: original,
      sourceState: {
        role: "alias",
        kind: "candidate",
        path: path.join(f.project, alias),
        workingCandidate: original,
      },
      absPersistence: { verified: true },
    },
    messages = [
      { role: "user", content: "offline adapter sample" },
      call("setup", "powershell", { command: state.setupCommand }),
      reply("setup", "setup completed"),
      call("export", "abs_export", { project: f.project, outFile: alias }),
      reply("export", JSON.stringify(result), { details: { result } }),
      call("read", "read", { path: alias, limit: 6 }),
      reply("read", f.source),
      call("edit", "edit", {
        path: alias,
        edits: [
          {
            oldText: state.firstLine,
            newText: state.firstLine + "\n" + state.registeredLive.marker,
          },
        ],
      }),
      reply("edit", "edited", {
        details: {
          candidatePublication: { project: f.project, sourceHash: sha(dirty) },
        },
      }),
      call("main", "powershell", { command: state.mainCommand }),
    ],
    cp = {
      workspaceRoot: f.project,
      turnId: "retired-turn",
      candidateRefs: { [alias]: current },
    },
    snapshot = {
      sessionId: f.sessionId,
      cwd: f.project,
      isIdle: false,
      isStreaming: true,
      messages,
      entries: [
        {
          id: "checkpoint",
          type: "custom",
          customType: "aily.workspace-history",
          data: cp,
        },
      ],
    };
  return { snapshot, original, current, dirty, edits };
}
function approval(state, id, command, kind = "root-reviewed-auxiliary") {
  const commandHash = sha(command),
    result = {
      toolCallId: id,
      sessionId: state.sessionId,
      project: state.project,
      commandHash,
      kind,
      clicked: true,
    };
  if (kind === "root-reviewed-auxiliary")
    result.approvalRef = {
      file: state.reviewManifestFile,
      entryHash: sha("offline reviewer entry"),
      sessionId: state.sessionId,
      toolCallId: id,
      commandHash,
    };
  return result;
}
async function completedDelete(t) {
  const f = await fixture(t),
    state = await prepareRegisteredLiveCase({
      ...f.options,
      name: "registered-live-delete",
    }),
    sample = await prepareCandidate(f, state, state.registeredLive.deletePath);
  await assertRegisteredLiveMutation(
    state,
    sample.snapshot,
    0,
    state.mainCommand,
  );
  await fs.unlink(path.join(f.project, state.registeredLive.deletePath));
  const entry = (scope) => ({
      scope,
      file: state.registeredLive.deletePath,
      before: {
        kind: "file",
        hash:
          "sha256:" +
          (scope === "canonical"
            ? state.mutationAdmission.canonical.hash
            : sha(sample.dirty)),
        bytes: scope === "canonical" ? f.source.length : sample.dirty.length,
        identity:
          scope === "canonical"
            ? state.mutationAdmission.canonical.identity
            : "exact-private-file-identity",
      },
      after: { kind: "missing", hash: null, identity: null, bytes: null },
      disposition: "removed",
      sourceBindingReleased: true,
      ordinaryCaptureCompleted: true,
    }),
    outcome = { version: 1, entries: ["canonical", "execution"].map(entry) };
  sample.snapshot.messages.push(
    reply("main", "removed"),
    call("absent", "read", { path: state.registeredLive.deletePath }),
    reply("absent", "ENOENT: file not found", { isError: true }),
  );
  sample.snapshot.entries.push({
    id: "checkpoint-after",
    type: "custom",
    customType: "aily.workspace-history",
    data: { workspaceRoot: f.project, turnId: "new-turn", candidateRefs: {} },
  });
  Object.assign(sample.snapshot, { isIdle: true, isStreaming: false });
  const evidence = {
    snapshot: sample.snapshot,
    initialUsers: 0,
    tools: [
      { toolCallId: "setup", name: "powershell" },
      { toolCallId: "main", name: "powershell", nativeProgramOutcome: outcome },
    ],
    approvals: [
      approval(state, "setup", state.setupCommand),
      approval(state, "main", state.mainCommand, "preplanned-main"),
    ],
    workingAfter: f.working,
    fault: { failures: [], commands: [] },
    finalText: "Temporary alias removed.",
    hostPid: 101,
  };
  return { f, state, sample, evidence };
}

test("preparation only generates names/prompts and requires an explicit owned project", async (t) => {
  const f = await fixture(t),
    state = await prepareRegisteredLiveCase({
      ...f.options,
      name: "registered-live-delete",
    });
  assert.equal(
    await fs.stat(path.join(f.project, ".workspace-history")).then(
      () => true,
      (error) => {
        assert.equal(error.code, "ENOENT");
        return false;
      },
    ),
    false,
  );
  assert.equal(
    await fs.stat(path.join(f.project, state.registeredLive.directory)).then(
      () => true,
      (error) => {
        assert.equal(error.code, "ENOENT");
        return false;
      },
    ),
    false,
  );
  const prompt = fillRegisteredLivePrompt(
    "{{PROJECT}} {{REGISTERED_ALIAS}} {{REGISTERED_MARKER}} {{REGISTERED_SETUP}} {{REGISTERED_COMMAND}}",
    state,
  );
  assert.ok(!prompt.includes("{{"));
  assert.ok(prompt.includes(state.mainCommand));
  await assert.rejects(
    prepareRegisteredLiveCase({
      ...f.options,
      ownedRoot: f.project,
      name: "registered-live-delete",
    }),
    /owned root/,
  );
});

test("admission uses immutable/SDK/edit facts and does not infer the active view from checkpoint turnId", async (t) => {
  const f = await fixture(t),
    state = await prepareRegisteredLiveCase({
      ...f.options,
      name: "registered-live-delete",
    }),
    sample = await prepareCandidate(f, state, state.registeredLive.deletePath);
  const admitted = await assertRegisteredLiveMutation(
    state,
    sample.snapshot,
    0,
    state.mainCommand,
  );
  assert.equal(admitted.current.sourceHash, sha(sample.dirty));
  assert.equal(
    admitted.privateExpected.verification,
    "real-native-outcome-before-and-after",
  );
  assert.equal(
    await fs.stat(path.join(f.project, ".workspace-history/overlays")).then(
      () => true,
      (error) => {
        assert.equal(error.code, "ENOENT");
        return false;
      },
    ),
    false,
  );
  const bad = structuredClone(sample.snapshot);
  bad.messages.find(
    (message) => message.toolCallId === "edit",
  ).details.candidatePublication.sourceHash = sha("another edit");
  await assert.rejects(
    assertRegisteredLiveMutation(
      { ...state, mutationAdmission: undefined },
      bad,
      0,
      state.mainCommand,
    ),
    /real completed Pi edit/,
  );
  const filename = path.join(
    f.project,
    ".workspace-history/objects",
    sample.edits.hash.slice(0, 2),
    sample.edits.hash + ".blob",
  );
  await fs.writeFile(filename, "corrupt edits");
  await assert.rejects(
    assertRegisteredLiveMutation(
      { ...state, mutationAdmission: undefined },
      sample.snapshot,
      0,
      state.mainCommand,
    ),
  );
});

test("extended setup accepts only the exact five-field reviewed tuple", async (t) => {
  const f = await fixture(t),
    state = await prepareRegisteredLiveCase({
      ...f.options,
      name: "registered-live-delete",
    }),
    sample = await prepareCandidate(f, state, state.registeredLive.deletePath),
    command =
      state.setupCommand +
      "\nGet-Item -LiteralPath " +
      "'" +
      path.join(f.project, state.registeredLive.deletePath) +
      "'",
    review = approval(state, "setup", command);
  review.acceptanceRole = "registered-live-setup";
  state.setupApprovals = [review];
  sample.snapshot.messages[1].content[0].arguments.command = command;
  await assertRegisteredLiveMutation(
    state,
    sample.snapshot,
    0,
    state.mainCommand,
  );
  for (const name of [
    "file",
    "entryHash",
    "sessionId",
    "toolCallId",
    "commandHash",
  ]) {
    const wrong = structuredClone(review);
    wrong.approvalRef[name] = "wrong";
    await assert.rejects(
      assertRegisteredLiveMutation(
        { ...state, mutationAdmission: undefined, setupApprovals: [wrong] },
        sample.snapshot,
        0,
        state.mainCommand,
      ),
    );
  }
  for (const acceptanceRole of [undefined, "another-reviewed-purpose"])
    await assert.rejects(
      assertRegisteredLiveMutation(
        {
          ...state,
          mutationAdmission: undefined,
          setupApprovals: [{ ...review, acceptanceRole }],
        },
        sample.snapshot,
        0,
        state.mainCommand,
      ),
    );
});

test("audit verifies both real typed contracts and preserves the complete immutable sources", async (t) => {
  const { state, evidence } = await completedDelete(t);
  const result = await auditRegisteredLiveCase(state, evidence);
  assert.equal(result.passed, true);
  assert.equal(result.nativeCallCount, 2);
  for (const scope of ["canonical", "execution"]) {
    const bad = structuredClone(evidence),
      entry = bad.tools[1].nativeProgramOutcome.entries.find(
        (entry) => entry.scope === scope,
      );
    entry.before.hash = "sha256:" + sha("different source");
    await assert.rejects(auditRegisteredLiveCase(state, bad));
  }
  const wrongIdentity = structuredClone(evidence);
  wrongIdentity.tools[1].nativeProgramOutcome.entries[0].before.identity =
    "different-canonical-inode";
  await assert.rejects(auditRegisteredLiveCase(state, wrongIdentity));
  const incomplete = structuredClone(evidence);
  incomplete.tools[1].nativeProgramOutcome.entries[1].ordinaryCaptureCompleted = false;
  await assert.rejects(
    auditRegisteredLiveCase(state, incomplete),
    /completed release/,
  );
  const fabricated = structuredClone(evidence);
  fabricated.fault.receiptFabricated = true;
  await assert.rejects(auditRegisteredLiveCase(state, fabricated));
  const main = path.join(state.project, "project.abi"),
    bytes = await fs.readFile(main);
  await fs.rename(main, main + ".prior");
  await fs.writeFile(main, bytes);
  await assert.rejects(
    auditRegisteredLiveCase(state, evidence),
    /physical identities/,
  );
});

test("all parameterized prompts resolve without embedding a project, server or account", async (t) => {
  const f = await fixture(t),
    state = await prepareRegisteredLiveCase({
      ...f.options,
      name: "registered-live-delete",
    });
  for (const name of ["delete", "rename", "restart"]) {
    const prompt = await fs.readFile(
      new URL(
        "../../e2e/electron/fixtures/registered-live-" + name + "-prompt.txt",
        import.meta.url,
      ),
      "utf8",
    );
    assert.ok(!/https?:\/\/|[A-Z]:[\\/]|password/i.test(prompt));
    assert.ok(!/\{\{[A-Z_]+\}\}/.test(fillRegisteredLivePrompt(prompt, state)));
  }
});
