const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { test } = require("node:test");

const repo = path.resolve(__dirname, "../.."),
  lex = path.resolve(repo, "../aily-lex-pro");
const modules = Promise.all([
  import(
    pathToFileURL(
      path.join(repo, "e2e/electron/fixtures/r2-owned-session-file.mjs"),
    )
  ),
  import(
    pathToFileURL(path.join(lex, "packages/aily-agent/dist/e2e/runtime.js"))
  ),
  import(
    pathToFileURL(path.join(repo, "e2e/fixtures/installed-chat-observer.mjs"))
  ),
]);
async function fixture(t) {
  const suite = await fs.mkdtemp(path.join(os.tmpdir(), "r2-session-file-"));
  const home = path.join(suite, "home"),
    project = path.join(suite, "project"),
    sessionId = "01a1ba01-e91e-7466-85ce-08819030d142";
  const bucket = path.join(home, ".aily-chat/sessions/0123456789abcdef");
  await fs.mkdir(bucket, { recursive: true });
  await fs.mkdir(project);
  const file = path.join(
    bucket,
    "2026-11-08T07-14-09-822Z_" + sessionId + ".jsonl",
  );
  const bytes = Buffer.from(
    JSON.stringify({
      type: "session",
      version: 3,
      id: sessionId,
      cwd: project,
    }) +
      "\n" +
      JSON.stringify({ type: "custom", id: "prepared-original" }) +
      "\n",
  );
  await fs.writeFile(file, bytes);
  t.after(() => fs.rm(suite, { recursive: true, force: true }));
  return { suite, home, project, sessionId, file, bytes, bucket };
}

test("the actual E2E runtime rejects session.filePath while its installed observer supports only the existing list/read methods", async () => {
  const [, { createAilyAgentE2ERuntime }, { createInstalledChatObserver }] =
    await modules;
  let registryReads = 0;
  const runtime = createAilyAgentE2ERuntime(
    {
      get: () => {
        registryReads++;
        return undefined;
      },
      list: () => [],
      subscribeClosed: () => () => {},
    },
    () => {
      throw Error("Artifact review must not run");
    },
  );
  const observer = createInstalledChatObserver(
    "http://127.0.0.1:1234/?token=owned-only",
    async (_url, options) =>
      new Response(
        JSON.stringify(await runtime.execute(JSON.parse(options.body))),
        { status: 200 },
      ),
  );
  assert.deepEqual(await observer("session.list"), { sessions: [] });
  const unsupported = await runtime.execute({
    protocol: "aily-agent-e2e",
    version: 4,
    method: "session.filePath",
    sessionId: "original-session",
  });
  assert.equal(unsupported.ok, false);
  assert.equal(unsupported.error.code, "INVALID_REQUEST");
  await assert.rejects(() =>
    observer("session.filePath", { sessionId: "original-session" }),
  );
  assert.equal(registryReads, 0);
  const supported = await runtime.execute({
    protocol: "aily-agent-e2e",
    version: 4,
    method: "session.read",
    sessionId: "original-session",
  });
  assert.equal(supported.error.code, "SESSION_NOT_OPEN");
  assert.equal(registryReads, 1);
});

test("every E2E method used by the actual Board driver belongs to the current runtime protocol", async () => {
  const [, { createAilyAgentE2ERuntime }] = await modules;
  const runtime = createAilyAgentE2ERuntime(
    { get: () => undefined, list: () => [], subscribeClosed: () => () => {} },
    () => {
      throw Error("No review");
    },
  );
  const source = await fs.readFile(
    path.join(repo, "e2e/electron/r2-board-publication-cold.acceptance.mjs"),
    "utf8",
  );
  const methods = [...source.matchAll(/\.e2e\(\s*["']([^"']+)["']/g)].map(
    (value) => value[1],
  );
  assert.ok(methods.length);
  for (const method of methods) {
    const result = await runtime.execute({
      protocol: "aily-agent-e2e",
      version: 4,
      method,
      sessionId: "original-session",
    });
    assert.notEqual(
      result.error?.code,
      "INVALID_REQUEST",
      "Unsupported actual driver method: " + method,
    );
  }
});

test("reads exact original header and bytes without changing the physical session", async (t) => {
  const [{ readOwnedSessionFile }] = await modules,
    f = await fixture(t);
  const before = await fs.stat(f.file),
    captured = await readOwnedSessionFile(f);
  assert.equal(captured.sessionFile, f.file);
  assert.deepEqual(captured.bytes, f.bytes);
  const after = await fs.stat(f.file);
  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.deepEqual(await fs.readFile(f.file), f.bytes);
});

test("foreign header project and a renamed foreign session ID are refused instead of selecting a substitute", async (t) => {
  const [{ readOwnedSessionFile }] = await modules,
    f = await fixture(t);
  await fs.writeFile(
    f.file,
    JSON.stringify({
      type: "session",
      id: f.sessionId,
      cwd: path.join(f.suite, "foreign"),
    }) + "\n",
  );
  await assert.rejects(() => readOwnedSessionFile(f), /original project/);
  await fs.writeFile(
    f.file,
    JSON.stringify({ type: "session", id: "foreign-session", cwd: f.project }) +
      "\n",
  );
  await assert.rejects(() => readOwnedSessionFile(f));
});

test("duplicate exact session headers and an external home are rejected without latest-file guessing", async (t) => {
  const [{ readOwnedSessionFile }] = await modules,
    f = await fixture(t);
  await fs.writeFile(
    path.join(f.bucket, "another_" + f.sessionId + ".jsonl"),
    f.bytes,
  );
  await assert.rejects(
    () => readOwnedSessionFile(f),
    /one exact owned session/,
  );
  await assert.rejects(
    () => readOwnedSessionFile({ ...f, home: path.dirname(f.suite) }),
    /owned suite/,
  );
});

test("linked session ancestry and multiply linked files cannot supply the original session", async (t) => {
  const [{ readOwnedSessionFile }] = await modules,
    f = await fixture(t);
  const duplicate = path.join(f.suite, "hardlink.jsonl");
  await fs.link(f.file, duplicate);
  await assert.rejects(() => readOwnedSessionFile(f), /physical regular file/);
  await fs.unlink(duplicate);
  const moved = path.join(f.home, "saved-sessions");
  await fs.rename(path.join(f.home, ".aily-chat/sessions"), moved);
  await fs.symlink(
    moved,
    path.join(f.home, ".aily-chat/sessions"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(() => readOwnedSessionFile(f), /ancestry/);
});
