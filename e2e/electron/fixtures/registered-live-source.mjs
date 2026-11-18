import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { readWorkingCandidateEvidence } from "./r3-candidate-evidence.mjs";

// Readonly evidence adapter for the installed Chat drivers. The caller owns
// the desktop lifecycle, exact per-call review and actual Host/SDK snapshots.
// This fixture never writes program files, refs, checkpoints or user settings.
export const registeredLiveCases = [
  "registered-live-delete",
  "registered-live-rename",
  "registered-live-restart",
];
const sha = (value) => createHash("sha256").update(value).digest("hex");
const key = (value) => path.resolve(value).replaceAll("\\", "/").toLowerCase();
const same = (left, right) =>
  typeof left === "string" &&
  typeof right === "string" &&
  key(left) === key(right);
const slash = (value) => value.replaceAll("\\", "/").toLowerCase();
const quote = (value) => "'" + value.replaceAll("'", "''") + "'";
const equalRef = (a, b) =>
  !!a &&
  !!b &&
  a.version === 1 &&
  a.version === b.version &&
  a.id === b.id &&
  a.revisionHash === b.revisionHash;
const text = (message) =>
  typeof message?.content === "string"
    ? message.content
    : (message?.content ?? [])
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
function inside(root, file) {
  const relative = path.relative(root, file);
  assert.ok(
    relative &&
      relative !== ".." &&
      !relative.startsWith(".." + path.sep) &&
      !path.isAbsolute(relative),
    "Registered live evidence escaped its exact owned root",
  );
}
async function physical(root) {
  const stat = await fs.lstat(root);
  assert.ok(
    stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      same(await fs.realpath(root), root),
    "Expected physical owned directory",
  );
}
async function fileAt(root, relative) {
  const absolute = path.resolve(root, relative);
  inside(root, absolute);
  try {
    await physical(root);
    for (
      let parent = path.dirname(absolute);
      !same(parent, root);
      parent = path.dirname(parent)
    )
      await physical(parent);
    const before = await fs.lstat(absolute, { bigint: true });
    assert.ok(
      before.isFile() &&
        !before.isSymbolicLink() &&
        before.nlink === 1n &&
        before.size <= 128n * 1024n * 1024n,
      "Expected exact physical regular evidence file",
    );
    const bytes = await fs.readFile(absolute),
      after = await fs.lstat(absolute, { bigint: true });
    assert.deepEqual(
      [after.dev, after.ino, after.size, after.mtimeNs, after.ctimeNs],
      [before.dev, before.ino, before.size, before.mtimeNs, before.ctimeNs],
      "Evidence changed during readonly capture",
    );
    return {
      relative,
      exists: true,
      bytes: bytes.length,
      hash: sha(bytes),
      identity: [
        before.dev,
        before.ino,
        before.size,
        before.mtimeNs,
        before.ctimeNs,
        before.mode,
      ].join(":"),
      contents: bytes,
    };
  } catch (error) {
    if (error.code === "ENOENT") return { relative, exists: false };
    throw error;
  }
}
const fact = ({ contents: _contents, ...value }) => value;
async function immutable(project, ref, expectedOwner, attachment) {
  const result = await readWorkingCandidateEvidence({ project, ref }),
    record = result.record;
  if (expectedOwner) assert.equal(record.owner.sessionId, expectedOwner);
  if (attachment) assert.deepEqual(record.project.attachment, attachment);
  if (record.derivation.kind === "splices") {
    const edits = await fileAt(
      project,
      ".workspace-history/objects/" +
        record.derivation.edits.hash.slice(0, 2) +
        "/" +
        record.derivation.edits.hash +
        ".blob",
    );
    assert.equal(edits.hash, record.derivation.edits.hash);
    assert.equal(edits.bytes, record.derivation.edits.bytes);
  }
  const source = Buffer.from(result.source, "utf8");
  return {
    ref,
    sourceHash: record.source.hash,
    bytes: source.length,
    baseHash: record.base.abs.hash,
    source,
    record,
  };
}
const programEntries = [
  "project.abi",
  "project.abs",
  "project.abs.map.json",
  ".aily/abs-sync/committed.json",
  ".aily/abs-sync/prepared.json",
];
async function readTypedProgram(project) {
  const entries = [];
  for (const file of programEntries) {
    const observed = await fileAt(project, file);
    entries.push({
      file,
      kind: observed.exists ? "file" : "missing",
      hash: observed.exists ? "sha256:" + observed.hash : null,
      bytes: observed.bytes ?? null,
      identity: observed.identity ?? null,
      contents: observed.contents ?? null,
    });
  }
  return entries;
}
const typedFacts = (entries) =>
  Object.fromEntries(
    entries.map(({ contents: _contents, ...entry }) => [entry.file, entry]),
  );
const normalizeReviewedCommand = (value) =>
  typeof value === "string" ? value.replace(/\r\n/g, "\n").trim() : "";
const proof = ({ source: _source, record: _record, ...value }) => value;
function checkpoint(snapshot) {
  const entry = snapshot?.entries
    ?.filter(
      (value) =>
        value.type === "custom" &&
        value.customType === "aily.workspace-history",
    )
    .at(-1);
  assert.ok(entry?.data, "Actual SDK history checkpoint is required");
  return { entry, data: entry.data };
}
const selected = (cp, relative) =>
  Object.entries(cp.candidateRefs ?? {}).find(
    ([file]) => slash(file) === slash(relative),
  )?.[1];
function currentCalls(snapshot, initialUsers, project) {
  let seen = 0;
  const index = snapshot.messages.findIndex(
    (message) => message.role === "user" && ++seen === initialUsers + 1,
  );
  assert.ok(index >= 0, "Expected the one real new UI user turn");
  const messages = snapshot.messages.slice(index),
    replies = new Map(
      messages
        .filter((message) => message.role === "toolResult")
        .map((message) => [message.toolCallId, message]),
    );
  let userOrdinal = initialUsers;
  const actualCalls = [];
  for (const message of messages) {
    if (message.role === "user") userOrdinal++;
    if (message.role === "assistant")
      for (const call of message.content ?? [])
        if (call.type === "toolCall") actualCalls.push({ call, userOrdinal });
  }
  return actualCalls.map(({ call, userOrdinal }, index) => {
    const wrapped = call.name === "tool_invoke",
      input = wrapped
        ? (call.arguments?.arguments ?? call.arguments?.input)
        : call.arguments,
      name = wrapped ? call.arguments?.name : call.name,
      reply = replies.get(call.id);
    let relative =
      typeof input?.path === "string"
        ? path
            .relative(project, path.resolve(project, input.path))
            .replaceAll("\\", "/")
        : undefined;
    const view = relative?.match(
      /^\.workspace-history\/overlays\/[a-f0-9-]{36}\/view\/(.+)$/i,
    );
    if (view) relative = view[1];
    const body = reply ? text(reply) : "";
    let result = reply?.details?.result;
    if (!result && body) {
      try {
        result = JSON.parse(body);
      } catch {
        /* Only actual structured reply data is admissible. */
      }
    }
    return {
      index,
      userOrdinal,
      id: call.id,
      name,
      input,
      reply,
      relative,
      error: !reply || reply.isError === true,
      text: body,
      result,
    };
  });
}
function bindSession(state, snapshot) {
  assert.ok(snapshot.sessionId && same(snapshot.cwd, state.project));
  if (!state.sessionId) state.sessionId = snapshot.sessionId;
  assert.equal(snapshot.sessionId, state.sessionId, "Use the same real Chat");
}
function validApprovalRef(
  ref,
  sessionId,
  toolCallId,
  commandHash,
  reviewManifestFile,
) {
  return (
    ref &&
    typeof ref === "object" &&
    !Array.isArray(ref) &&
    Object.keys(ref).length === 5 &&
    Object.keys(ref).every((name) =>
      ["file", "entryHash", "sessionId", "toolCallId", "commandHash"].includes(
        name,
      ),
    ) &&
    same(ref.file, reviewManifestFile) &&
    /^[a-f0-9]{64}$/.test(ref.entryHash ?? "") &&
    ref.sessionId === sessionId &&
    ref.toolCallId === toolCallId &&
    ref.commandHash === commandHash
  );
}
function setupCall(state, call) {
  const command = call.input?.command;
  if (
    state.setupCommand &&
    normalizeReviewedCommand(command) ===
      normalizeReviewedCommand(state.setupCommand)
  )
    return { kind: "exact-original" };
  const approval = state.setupApprovals?.find(
    (value) =>
      value.toolCallId === call.id &&
      value.commandHash === sha(command ?? "") &&
      value.acceptanceRole === "registered-live-setup" &&
      value.sessionId === state.sessionId &&
      same(value.project, state.project) &&
      validApprovalRef(
        value.approvalRef,
        state.sessionId,
        call.id,
        sha(command ?? ""),
        state.reviewManifestFile,
      ),
  );
  return approval
    ? { kind: "reviewed-role", approvalRef: approval.approvalRef }
    : undefined;
}
async function unchangedMain(state, workingAfter) {
  assert.deepEqual(workingAfter.attachment, state.working.attachment);
  assert.equal(workingAfter.documentHash, state.working.documentHash);
  const after = typedFacts(await readTypedProgram(state.project));
  assert.deepEqual(
    after,
    state.before,
    "Main entry kinds, hashes, bytes and physical identities must all remain unchanged",
  );
  return after;
}
export async function prepareRegisteredLiveCase({
  name,
  project,
  ownedRoot,
  reviewManifestFile,
  sessionId,
  working,
  previous,
  snapshot,
  desktopInstance,
}) {
  assert.ok(registeredLiveCases.includes(name));
  assert.ok(
    path.isAbsolute(ownedRoot) && path.isAbsolute(reviewManifestFile),
    "Supply explicit test-owned root and review manifest",
  );
  await physical(ownedRoot);
  inside(ownedRoot, project);
  await physical(project);
  assert.ok(same(working.attachment.root, project));
  const entries = await readTypedProgram(project);
  assert.ok(
    entries.slice(0, 4).every((entry) => entry.kind === "file") &&
      entries[4].kind === "missing",
  );
  let registeredLive, previousProof;
  if (name === "registered-live-delete") {
    const id = "registered-live-" + randomUUID(),
      directory = ".aily/temp/" + id;
    registeredLive = {
      id,
      directory,
      deletePath: directory + "/registered-delete.abs",
      oldPath: directory + "/registered-move.abs",
      newPath: directory + "/renamed-dirty.abs",
      marker: "# retained-live-draft-" + id,
    };
    for (const file of [
      registeredLive.deletePath,
      registeredLive.oldPath,
      registeredLive.newPath,
    ])
      assert.equal((await fileAt(project, file)).exists, false);
  } else {
    assert.ok(
      previous?.completed &&
        previous.boundaryAudit?.passed &&
        previous.boundaryPreparation?.registeredLive,
      "Use the exact previous successful real result, not a synthetic fixture",
    );
    assert.equal(
      previous.boundaryAudit.name,
      name === "registered-live-rename"
        ? "registered-live-delete"
        : "registered-live-rename",
    );
    assert.equal(previous.sessionId, sessionId);
    assert.ok(same(previous.project, project));
    registeredLive = previous.boundaryPreparation.registeredLive;
    previousProof = {
      case: previous.boundaryAudit.name,
      output: previous.output,
      sessionId,
      desktopInstance: previous.boundaryPreparation.desktopInstance,
      registrations: previous.boundaryAudit.registrations,
      renamed: previous.boundaryAudit.renamed,
      mainDraft: previous.boundaryAudit.mainDraft,
    };
    assert.equal(
      (await fileAt(project, registeredLive.deletePath)).exists,
      false,
      "The deleted alias revived before continuation",
    );
    if (name === "registered-live-restart") {
      assert.equal(
        (await fileAt(project, registeredLive.oldPath)).exists,
        false,
      );
      assert.equal(
        (await fileAt(project, registeredLive.newPath)).hash,
        previousProof.renamed.hash,
      );
      assert.notDeepEqual(
        desktopInstance,
        previousProof.desktopInstance,
        "Restart must use a genuinely new desktop process",
      );
    } else
      for (const file of [registeredLive.oldPath, registeredLive.newPath])
        assert.equal((await fileAt(project, file)).exists, false);
  }
  const file =
      name === "registered-live-delete"
        ? registeredLive.deletePath
        : registeredLive.oldPath,
    setupCommand =
      name === "registered-live-restart"
        ? undefined
        : `New-Item -ItemType Directory -Force -Path ${quote(path.resolve(project, registeredLive.directory))} | Out-Null\nCopy-Item -LiteralPath ${quote(path.join(project, "project.abs"))} -Destination ${quote(path.resolve(project, file))}`,
    mainCommand =
      name === "registered-live-delete"
        ? `Remove-Item -LiteralPath ${quote(path.resolve(project, file))}`
        : name === "registered-live-rename"
          ? `Move-Item -LiteralPath ${quote(path.resolve(project, file))} -Destination ${quote(registeredLive.newPath)}`
          : undefined;
  const firstLine = entries[1].contents.toString("utf8").split(/\r?\n/, 1)[0];
  assert.ok(
    firstLine &&
      firstLine.length < 2048 &&
      !firstLine.includes(registeredLive.marker),
  );
  return {
    name,
    project,
    ownedRoot,
    reviewManifestFile,
    sessionId: sessionId ?? null,
    working,
    desktopInstance,
    before: typedFacts(entries),
    registeredLive,
    firstLine,
    setupCommand,
    mainCommand,
    command: mainCommand,
    previousProof,
    checkpointBefore: snapshot?.entries?.some(
      (value) => value.customType === "aily.workspace-history",
    )
      ? {
          entryId: checkpoint(snapshot).entry.id,
          primary: selected(checkpoint(snapshot).data, "project.abs"),
        }
      : undefined,
  };
}
export function fillRegisteredLivePrompt(prompt, state) {
  return prompt
    .replaceAll(
      "{{REGISTERED_ALIAS}}",
      state.name === "registered-live-delete"
        ? state.registeredLive.deletePath
        : state.registeredLive.oldPath,
    )
    .replaceAll("{{REGISTERED_DELETE}}", state.registeredLive.deletePath)
    .replaceAll("{{REGISTERED_OLD}}", state.registeredLive.oldPath)
    .replaceAll("{{REGISTERED_NEW}}", state.registeredLive.newPath)
    .replaceAll("{{REGISTERED_MARKER}}", state.registeredLive.marker)
    .replaceAll("{{REGISTERED_FIRST_LINE}}", state.firstLine)
    .replaceAll("{{REGISTERED_SETUP}}", state.setupCommand ?? "")
    .replaceAll("{{REGISTERED_COMMAND}}", state.mainCommand ?? "")
    .replaceAll("{{PROJECT}}", state.project);
}
export async function assertRegisteredLiveMutation(
  state,
  snapshot,
  initialUsers,
  actualCommand,
) {
  if (
    !state.mainCommand ||
    normalizeReviewedCommand(actualCommand) !==
      normalizeReviewedCommand(state.mainCommand)
  )
    return undefined;
  bindSession(state, snapshot);
  const file =
      state.name === "registered-live-delete"
        ? state.registeredLive.deletePath
        : state.registeredLive.oldPath,
    calls = currentCalls(snapshot, initialUsers, state.project),
    exports = calls.filter(
      (call) =>
        call.name === "abs_export" &&
        typeof call.input?.outFile === "string" &&
        slash(
          path.relative(
            state.project,
            path.resolve(state.project, call.input.outFile),
          ),
        ) === slash(file) &&
        !call.error,
    );
  assert.equal(
    exports.length,
    1,
    "A real successful abs_export(outFile) must register this unique alias exactly once",
  );
  const exported = exports[0],
    result = exported.result;
  assert.ok(
    result?.ok &&
      result.sourceState?.role === "alias" &&
      result.sourceState?.kind === "candidate" &&
      result.absPersistence?.verified === true,
    "A read-only canvas preview is not a registered candidate",
  );
  assert.ok(same(result.sourceState.path, path.resolve(state.project, file)));
  const originalRef =
      result.workingCandidate ?? result.sourceState.workingCandidate,
    cp = checkpoint(snapshot),
    currentRef = selected(cp.data, file);
  assert.ok(currentRef);
  const original = await immutable(
      state.project,
      originalRef,
      state.sessionId,
      state.working.attachment,
    ),
    current = await immutable(
      state.project,
      currentRef,
      state.sessionId,
      state.working.attachment,
    ),
    canonical = await fileAt(state.project, file);
  assert.ok(canonical.exists);
  assert.equal(
    canonical.hash,
    original.sourceHash,
    "Setup must leave the unedited source in the real project",
  );
  const setup = calls.filter(
    (call) =>
      ["powershell", "bash"].includes(call.name) &&
      setupCall(state, call) &&
      !call.error,
  );
  assert.equal(setup.length, 1);
  assert.ok(setup[0].index < exported.index);
  const reads = calls.filter(
    (call) =>
      call.name === "read" &&
      slash(call.relative ?? "") === slash(file) &&
      !call.error,
  );
  assert.ok(
    reads.some((call) => call.index > exported.index),
    "Agent must use Pi read on its registered alias",
  );
  const edits = calls.filter(
    (call) =>
      call.name === "edit" &&
      slash(call.relative ?? "") === slash(file) &&
      !call.error &&
      call.index > exported.index,
  );
  if (state.mainCommand) {
    assert.equal(edits.length, 1, "Use one actual Pi edit for the dirty alias");
    assert.notEqual(current.sourceHash, original.sourceHash);
    assert.ok(
      equalRef(current.record.parent, original.ref),
      "The dirty revision must be the real successor of its exported alias",
    );
    const originalText = original.source.toString("utf8"),
      newline = originalText.includes("\r\n") ? "\r\n" : "\n",
      expected = originalText.replace(
        state.firstLine,
        state.firstLine + newline + state.registeredLive.marker,
      );
    assert.equal(
      current.source.toString("utf8"),
      expected,
      "Only the unique header comment may differ from the real original source",
    );
    const publication = edits[0].reply.details?.candidatePublication;
    assert.ok(
      publication &&
        publication.sourceHash?.replace(/^sha256:/, "") === current.sourceHash,
      "Dirty proof must originate in the real completed Pi edit",
    );
  }
  await unchangedMain(state, state.working);
  const evidence = {
    file,
    exportCall: exported.id,
    setupCall: setup[0].id,
    original: proof(original),
    current: proof(current),
    checkpointEntry: cp.entry.id,
    checkpointTurnId: cp.data.turnId,
    canonical: fact(canonical),
    privateExpected: {
      hash: current.sourceHash,
      bytes: current.bytes,
      verification: "real-native-outcome-before-and-after",
    },
    readCalls: reads.map((call) => call.id),
    editCalls: edits.map((call) => call.id),
  };
  if (state.mutationAdmission)
    assert.deepEqual(
      state.mutationAdmission,
      evidence,
      "A repeated approval must not quietly recapture a different candidate",
    );
  state.mutationAdmission = evidence;
  return evidence;
}
export async function auditRegisteredLiveCase(
  state,
  {
    snapshot,
    initialUsers,
    tools,
    approvals = [],
    workingAfter,
    fault,
    finalText,
    hostPid,
  },
) {
  bindSession(state, snapshot);
  assert.ok(
    snapshot.isIdle && !snapshot.isStreaming,
    "The actual Agent turn must settle",
  );
  assert.equal(hostPid, state.desktopInstance.pid);
  await unchangedMain(state, workingAfter);
  assert.deepEqual(fault.failures ?? [], []);
  for (const field of [
    "receiptFabricated",
    "authenticatedHandlerReplaced",
    "discoveryRewritten",
  ])
    assert.notEqual(fault[field], true);
  assert.ok(
    !(fault.commands ?? []).some(
      (command) =>
        command.operation === "abs_recovery" &&
        command.action === "reconcile_program",
    ),
    "Ordinary alias operations must not require main Working repair",
  );
  assert.ok(
    !tools.some((tool) =>
      [
        "abs_apply",
        "abs_import",
        "project_build",
        "project_save",
        "blocks_tidy",
        "blocks_set_state",
        "project_recover",
      ].includes(tool.name),
    ),
    "Do not apply, save, repair or rebuild the main project for ordinary files",
  );
  assert.ok(
    !/(?:请|需要你|需要用户|请您).{0,50}(?:手动恢复|重开项目|重新打开|切换副本|切换会话)/s.test(
      finalText,
    ),
  );
  const calls = currentCalls(snapshot, initialUsers, state.project),
    native = calls.filter((call) => ["powershell", "bash"].includes(call.name)),
    main = [],
    auxiliary = [],
    actualApprovals = approvals;
  for (const call of native) {
    const approval = actualApprovals.find(
      (item) =>
        item.toolCallId === call.id &&
        item.commandHash === sha(call.input?.command ?? "") &&
        item.clicked,
    );
    assert.ok(
      approval,
      "Every real native command requires its exact per-call approval",
    );
    assert.equal(
      call.error,
      false,
      "A failed native call cannot count as successful mutation",
    );
    if (
      state.mainCommand &&
      normalizeReviewedCommand(call.input.command) ===
        normalizeReviewedCommand(state.mainCommand)
    )
      main.push(call);
    else {
      assert.ok(
        approval.kind === "root-reviewed-auxiliary" && approval.approvalRef,
      );
      assert.ok(
        validApprovalRef(
          approval.approvalRef,
          state.sessionId,
          call.id,
          sha(call.input.command),
          state.reviewManifestFile,
        ),
        "Auxiliary approval must retain its exact five-field manifest binding",
      );
      const isSetup = setupCall(state, call);
      if (isSetup?.kind === "reviewed-role") {
        assert.equal(
          approval.acceptanceRole,
          "registered-live-setup",
          "Only the exact reviewer-approved setup role may extend the observed setup command",
        );
        assert.deepEqual(approval.approvalRef, isSetup.approvalRef);
        assert.equal(approval.sessionId, state.sessionId);
        assert.ok(same(approval.project, state.project));
      }
      const outcome = tools.find(
        (tool) => tool.toolCallId === call.id,
      )?.nativeProgramOutcome;
      assert.deepEqual(outcome?.failures ?? [], []);
      assert.ok(
        !(outcome?.entries ?? []).some(
          (entry) =>
            ["project.abs", "project.abi", "project.abs.map.json"].includes(
              slash(entry.file ?? ""),
            ) || entry.scope === "journal",
        ),
        "Auxiliary commands must not mutate fixed main entries",
      );
      if (!isSetup)
        assert.ok(
          !(outcome?.entries ?? []).some(
            (entry) =>
              [
                state.registeredLive.deletePath,
                state.registeredLive.oldPath,
                state.registeredLive.newPath,
              ]
                .map(slash)
                .includes(slash(entry.file ?? "")) &&
              (entry.before?.hash !== entry.after?.hash ||
                entry.before?.kind !== entry.after?.kind),
          ),
          "An auxiliary command retried the tested mutation",
        );
      auxiliary.push({
        toolCallId: call.id,
        commandHash: approval.commandHash,
        setup: !!isSetup,
        approvalRef: approval.approvalRef,
      });
    }
  }
  const cp = checkpoint(snapshot),
    r = state.registeredLive,
    files = {},
    registrations = { ...state.previousProof?.registrations };
  for (const file of [r.deletePath, r.oldPath, r.newPath])
    files[file] = fact(await fileAt(state.project, file));
  assert.equal(files[r.deletePath].exists, false);
  assert.equal(files[r.oldPath].exists, false);
  const reads = (file) =>
      calls.filter(
        (call) =>
          call.name === "read" && slash(call.relative ?? "") === slash(file),
      ),
    missing = (file) =>
      reads(file).find(
        (call) =>
          call.error &&
          /ENOENT|no such file|does not exist|not found|找不到|不存在/i.test(
            call.text,
          ) &&
          !/CANDIDATE_|BASELINE_|ABS_|read.only|recovery/i.test(call.text),
      );
  let renamed = state.previousProof?.renamed;
  if (state.mainCommand) {
    assert.equal(main.length, 1, "Execute exactly one real main mutation");
    assert.equal(
      main[0].userOrdinal,
      initialUsers + 1,
      "The actual approved main must be a new call in the current UI turn",
    );
    const admission = state.mutationAdmission;
    assert.ok(
      admission,
      "Main native approval must first capture exact actual registration evidence",
    );
    const mainTool = tools.find((tool) => tool.toolCallId === main[0].id),
      entries = mainTool?.nativeProgramOutcome?.entries ?? [];
    assert.deepEqual(mainTool?.nativeProgramOutcome?.failures ?? [], []);
    for (const scope of ["canonical", "execution"]) {
      const entry = entries.find(
        (entry) =>
          entry.scope === scope &&
          slash(entry.file ?? "") === slash(admission.file) &&
          entry.after?.kind === "missing" &&
          entry.disposition === "removed" &&
          entry.sourceBindingReleased === true &&
          entry.ordinaryCaptureCompleted === true,
      );
      assert.ok(
        entry,
        "Both names need exact completed release evidence: " + scope,
      );
      const expected =
        scope === "canonical"
          ? admission.canonical
          : {
              hash: admission.current.sourceHash,
              bytes: admission.current.bytes,
            };
      assert.equal(entry.before?.kind, "file");
      assert.equal(entry.before.hash?.replace(/^sha256:/, ""), expected.hash);
      assert.equal(entry.before.bytes, expected.bytes);
      assert.ok(
        typeof entry.before.identity === "string" &&
          entry.before.identity.length > 0,
      );
      if (scope === "canonical")
        assert.equal(entry.before.identity, admission.canonical.identity);
      assert.equal(entry.after.identity, null);
      assert.equal(entry.after.hash, null);
    }
    assert.ok(
      missing(admission.file)?.index > main[0].index,
      "Pi read must see actual absence after removal, not candidate restoration",
    );
    assert.equal(selected(cp.data, admission.file), undefined);
    for (const candidate of [admission.original, admission.current]) {
      const retained = await immutable(
        state.project,
        candidate.ref,
        state.sessionId,
        state.working.attachment,
      );
      assert.equal(retained.sourceHash, candidate.sourceHash);
      assert.equal(retained.bytes, candidate.bytes);
    }
    registrations[state.name] = admission;
    if (state.name === "registered-live-delete")
      assert.equal(files[r.newPath].exists, false);
    else {
      assert.equal(files[r.newPath].hash, admission.current.sourceHash);
      const actual = await fileAt(state.project, r.newPath),
        dirty = await immutable(
          state.project,
          admission.current.ref,
          state.sessionId,
          state.working.attachment,
        );
      assert.ok(
        actual.contents.equals(dirty.source),
        "Renamed destination must equal every dirty source byte",
      );
      assert.ok(
        reads(r.newPath).some(
          (call) =>
            !call.error &&
            call.index > main[0].index &&
            call.text.includes(r.marker),
        ),
      );
      renamed = {
        path: r.newPath,
        hash: actual.hash,
        bytes: actual.bytes,
        dirtyRef: admission.current.ref,
        marker: r.marker,
      };
    }
  } else {
    assert.equal(main.length, 0);
    assert.equal(
      native.length,
      0,
      "Restart is one aggregate Pi read pass, no native mutation or backup",
    );
    assert.ok(
      state.previousProof && state.previousProof.sessionId === state.sessionId,
    );
    assert.notEqual(
      hostPid,
      state.previousProof.desktopInstance.pid,
      "Use an actual restarted desktop PID",
    );
    assert.ok(missing(r.deletePath) && missing(r.oldPath));
    assert.equal(files[r.newPath].hash, renamed.hash);
    assert.ok(
      reads(r.newPath).some(
        (call) => !call.error && call.text.includes(r.marker),
      ),
    );
  }
  for (const file of [r.deletePath, r.oldPath, r.newPath])
    assert.equal(
      selected(cp.data, file),
      undefined,
      "Removed aliases and their ordinary destination must not become active candidates",
    );
  for (const admission of Object.values(registrations))
    for (const candidate of [admission.original, admission.current]) {
      const retained = await immutable(
        state.project,
        candidate.ref,
        state.sessionId,
        state.working.attachment,
      );
      assert.equal(retained.sourceHash, candidate.sourceHash);
      assert.equal(retained.bytes, candidate.bytes);
    }
  let mainDraft;
  const beforeMain = state.checkpointBefore?.primary,
    afterMain = selected(cp.data, "project.abs");
  if (beforeMain) {
    const original = await immutable(state.project, beforeMain),
      current = await immutable(state.project, afterMain);
    assert.equal(
      current.sourceHash,
      original.sourceHash,
      "Alias operations cannot change main pending draft",
    );
    mainDraft = {
      original: proof(original),
      current: proof(current),
      unchanged: true,
    };
  } else if (afterMain)
    mainDraft = {
      current: proof(await immutable(state.project, afterMain)),
      unchangedMainMirrors: true,
    };
  return {
    name: state.name,
    passed: true,
    hostPid,
    sessionId: state.sessionId,
    files,
    registrations,
    renamed,
    mainDraft,
    mainProgramUnchanged: true,
    nativeCallCount: native.length,
    mainMutation: main[0]?.id,
    auxiliaryNativeCommands: auxiliary,
    checkpointAfter: {
      entryId: cp.entry.id,
      turnId: cp.data.turnId,
      registeredAliasesAbsent: true,
    },
    previousProof: state.previousProof
      ? {
          case: state.previousProof.case,
          output: state.previousProof.output,
          desktopInstance: state.previousProof.desktopInstance,
        }
      : undefined,
  };
}
