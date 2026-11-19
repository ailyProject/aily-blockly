const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path"),
  vm = require("node:vm");
const ts = require("typescript"),
  { transformSync, buildSync } = require("esbuild"),
  { webcrypto } = require("node:crypto");
const {
  LibraryDependencies,
  runDependencyWorker,
} = require("../../electron/library-dependencies");
const {
  LibraryDependencySessions,
} = require("../../electron/library-dependency-sessions");
const {
  openProjectSyncStorageBridge,
} = require("../../electron/project-sync-storage");

function fixture(t) {
  const parent = path.resolve("tests/test-results/r2-paste-library-managed");
  fs.mkdirSync(parent, { recursive: true });
  const directory = fs.mkdtempSync(path.join(parent, "case-"));
  const root = path.join(directory, "project"),
    external = path.join(directory, "external"),
    name = "@aily-project/lib-r2-paste";
  fs.mkdirSync(root);
  fs.mkdirSync(external);
  fs.writeFileSync(
    path.join(root, "package.json"),
    ' {"name":"paste-project","dependencies":{}}',
  );
  fs.writeFileSync(
    path.join(external, "package.json"),
    JSON.stringify({ name, version: "1.0.0" }),
  );
  fs.writeFileSync(
    path.join(external, "definition.json"),
    "original external source",
  );
  fs.mkdirSync(path.join(root, ".aily/abs-sync"), { recursive: true });
  const programs = [
    "project.abi",
    "project.abs",
    "project.abs.map.json",
    ".aily/abs-sync/committed.json",
  ].map((file) => {
    const bytes = Buffer.from("unchanged canonical " + file);
    fs.writeFileSync(path.join(root, file), bytes);
    return [file, bytes];
  });
  const calls = [],
    checkpoints = [];
  let workers = 0;
  const manager = new LibraryDependencies({
    run: async (project, request, hooks) => {
      assert.ok(manager.environment.owned.get(project));
      checkpoints.push(manager.environment.owned.get(project).record.requestId);
      workers++;
      try {
        return await runDependencyWorker(
          project,
          { ...request, options: { ...request.options, offline: true } },
          hooks,
        );
      } finally {
        workers--;
      }
    },
  });
  const sessions = new LibraryDependencySessions(manager),
    port = { capabilities: async () => sessions.capabilities() };
  for (const operation of [
    "mutate",
    "observeEnvironment",
    "historyBegin",
    "historyCommit",
    "historyDiscard",
    "save",
    "status",
  ])
    port[operation] = async (project, request) => {
      calls.push({ operation, request });
      return sessions.run(operation, project, request);
    };
  t.after(() => {
    assert.equal(workers, 0);
    assert.ok(directory.startsWith(parent + path.sep));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return {
    root,
    external,
    name,
    directory,
    manager,
    sessions,
    port,
    calls,
    checkpoints,
    programs,
    get workers() {
      return workers;
    },
  };
}
function subject(f, t) {
  const source = fs.readFileSync(
      "src/app/editors/blockly-editor/components/blockly/blockly.component.ts",
      "utf8",
    ),
    parsed = ts.createSourceFile(
      "component.ts",
      source,
      ts.ScriptTarget.Latest,
      true,
    );
  const declaration = parsed.statements.find(
    (node) =>
      ts.isClassDeclaration(node) && node.name?.text === "BlocklyComponent",
  );
  let callback;
  const visit = (node) => {
    if (
      ts.isBinaryExpression(node) &&
      node.left.getText(parsed).includes("__ailyBlockPasteNeedsInstall")
    )
      callback = node.right.getText(parsed);
    ts.forEachChild(node, visit);
  };
  visit(declaration);
  assert.ok(callback);
  const projectSource = fs.readFileSync(
      "src/app/services/domains/project/project.service.ts",
      "utf8",
    ),
    projectParsed = ts.createSourceFile(
      "project.ts",
      projectSource,
      ts.ScriptTarget.Latest,
      true,
    ),
    projectClass = projectParsed.statements.find(
      (node) =>
        ts.isClassDeclaration(node) && node.name?.text === "ProjectService",
    );
  const domainNames = [
    "beginLibraryMutation",
    "abortLibraryMutation",
    "finishLibraryMutation",
    "saveLibraryChanges",
    "captureCurrentProjectGuard",
  ];
  const domainMethods = domainNames.map((name) =>
    projectClass.members
      .find((node) => node.name?.getText(projectParsed) === name)
      .getText(projectParsed),
  );
  const controller = new AbortController(),
    session = { projectPath: f.root, signal: controller.signal },
    workspace = {},
    working = {
      schemaVersion: 3,
      pages: [{ id: "original", content: { fields: { C: 201 } } }],
      sharedModel: { opaque: "keep" },
    };
  let currentWorkspace = workspace,
    dialog,
    close,
    leaseCount = 0,
    editCount = 0,
    captures = 0,
    runtime;
  const context = vm.createContext({
    module: { exports: {} },
    require,
    console,
    crypto: webcrypto,
    AbortController,
    DOMException,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    setTimeout,
    clearTimeout,
    window: {
      crypto: webcrypto,
      platform: { isWindows: process.platform === "win32" },
      fs: { ...fs, openProjectSyncStorage: openProjectSyncStorageBridge },
      libraryDependencies: f.port,
      ipcRenderer: {
        invoke: (_channel, body) => {
          f.calls.push({ operation: body.operation, request: body.request });
          return f.sessions.run(body.operation, body.projectPath, body.request);
        },
      },
    },
    isAilyLibraryPackageName: (value) =>
      /^@aily-project\/lib-[\w.-]+$/.test(value),
    ProjectLifecycleError: class extends Error {},
    PasteInstallDialogComponent: class {},
  });
  const load = (entry) => {
    context.module = { exports: {} };
    vm.runInContext(
      buildSync({
        entryPoints: [entry],
        alias: {
          "@shared/public-api": path.resolve(
            "src/app/services/shared/development-resource-routing.ts",
          ),
        },
        bundle: true,
        platform: "node",
        format: "cjs",
        write: false,
        logLevel: "silent",
      }).outputFiles[0].text,
      context,
    );
    Object.assign(context, context.module.exports);
  };
  load(
    "src/app/services/domains/project/project-managed-library-environment.ts",
  );
  load("src/app/editors/blockly-editor/services/missing-project-libraries.ts");
  if (
    fs.existsSync(
      "src/app/editors/blockly-editor/services/paste-project-libraries.ts",
    )
  )
    load("src/app/editors/blockly-editor/services/paste-project-libraries.ts");
  context.module = { exports: {} };
  vm.runInContext(
    transformSync(
      `class Domain {${domainMethods.join("\n")}};module.exports=Domain`,
      { loader: "ts", format: "cjs", target: "es2022" },
    ).code,
    context,
  );
  const domain = Object.assign(new context.module.exports(), {
    currentProjectPath: f.root,
    currentPackageData: {},
    dependencyLifecycleState: new Map([[f.root, session]]),
    getProjectDependencySession: () => session,
    assertProjectDependencySession: () => {
      if (controller.signal.aborted) throw controller.signal.reason;
      if (domain.currentProjectPath !== f.root)
        throw Error("PROJECT_OWNER_CHANGED");
    },
    getProjectMode: () => "blockly",
    isLibraryMutationInProgress() {
      return !!this.libraryMutation;
    },
    acceptLibraryStatus() {},
    acquireProjectLifecycle: () => {
      leaseCount++;
      return {
        release() {
          leaseCount--;
        },
      };
    },
    application: {
      hasActiveBlocklyBuildOrUpload: () => false,
      prepareBlocklyLibraryEdit: async () => {
        editCount++;
        return {
          document: structuredClone(working),
          release() {
            editCount--;
          },
          record() {},
        };
      },
      captureBlocklyLibraryDocument: async () => {
        captures++;
        return structuredClone(working);
      },
    },
    ensureBlocklyLibraryRuntimeReady: async () => {
      if (runtime) await runtime();
      assert.deepEqual(working, {
        schemaVersion: 3,
        pages: [{ id: "original", content: { fields: { C: 201 } } }],
        sharedModel: { opaque: "keep" },
      });
    },
  });
  const method = declaration.members.find(
    (node) => node.name?.getText(parsed) === "restorePasteLibraries",
  );
  context.module = { exports: {} };
  vm.runInContext(
    transformSync(
      `class Component {${method ? method.getText(parsed) : ""}};module.exports=Component`,
      { loader: "ts", format: "cjs", target: "es2022" },
    ).code,
    context,
  );
  const component = Object.assign(new context.module.exports(), {
    projectService: domain,
    destroy$: { isStopped: false },
    blocklyService: {
      get workspace() {
        return currentWorkspace;
      },
      loadLibrary: async () => {},
    },
    configService: {
      getNpmRegistryForProject: () => undefined,
      withProjectNpmRegistry: (value) => value,
    },
    electronService: {
      exists: fs.existsSync,
      pathJoin: path.join,
      readFile: (file) => fs.readFileSync(file, "utf8"),
    },
    cmdService: {
      runAsync: () => {
        f.calls.push({ operation: "RAW_NPM" });
        throw Error("RAW_NPM_BEFORE_MAIN_ADMISSION");
      },
    },
    crossPlatformCmdService: {
      removeItem: () => {
        f.calls.push({ operation: "RAW_REMOVE" });
        throw Error("RAW_COPY_BEFORE_MAIN_ADMISSION");
      },
      copyItem: () => {
        f.calls.push({ operation: "RAW_COPY" });
        throw Error("RAW_COPY_BEFORE_MAIN_ADMISSION");
      },
    },
    modal: {
      create: (options) => {
        dialog = options;
        return {
          afterClose: {
            subscribe(callback) {
              close = callback;
            },
          },
          destroy() {
            close?.(undefined);
          },
        };
      },
    },
  });
  Object.defineProperty(component, "workspace", {
    get: () => currentWorkspace,
  });
  context.subject = component;
  context.module = { exports: {} };
  vm.runInContext(
    transformSync(
      `module.exports=(function(){return ${callback}}).call(subject)`,
      { loader: "ts", format: "cjs", target: "es2022" },
    ).code,
    context,
  );
  const invoke = context.module.exports;
  t.after(async () => {
    if (domain.libraryMutation)
      await domain.abortLibraryMutation(domain.libraryMutation.token);
    assert.equal(leaseCount, 0);
    assert.equal(editCount, 0);
  });
  return {
    invoke,
    controller,
    domain,
    working,
    get dialog() {
      return dialog;
    },
    close: (value) => close(value),
    replaceWorkspace: () => (currentWorkspace = {}),
    destroy: () => (component.destroy$.isStopped = true),
    runtime: (value) => (runtime = value),
    get captures() {
      return captures;
    },
  };
}
test(
  "actual registered paste modal installFn uses Main checkpoint/offline npm and preserves full Working C without raw copy/npm",
  { timeout: 60000 },
  async (t) => {
    const f = fixture(t),
      c = subject(f, t),
      libs = [{ name: f.name, version: "1.0.0", localPath: f.external }];
    const done = c.invoke(libs);
    void done.catch(() => {});
    await c.dialog.nzData.installFn(libs);
    c.close({ result: "installed" });
    await done;
    assert.equal(
      f.calls.filter((call) => call.operation === "mutate").length,
      1,
    );
    assert.equal(
      f.calls.some((call) => call.operation.startsWith("RAW_")),
      false,
    );
    assert.ok(f.checkpoints.length);
    assert.equal(c.working.pages[0].content.fields.C, 201);
    assert.equal(c.captures, 1);
    assert.equal(f.workers, 0);
    for (const [file, bytes] of f.programs)
      assert.ok(fs.readFileSync(path.join(f.root, file)).equals(bytes));
  },
);
test(
  "runtime late reply cannot capture or commit a replaced workspace even when the project path/session are unchanged",
  { timeout: 60000 },
  async (t) => {
    const f = fixture(t),
      c = subject(f, t),
      libs = [{ name: f.name, localPath: f.external }];
    let entered, release;
    const waiting = new Promise((resolve) => (entered = resolve));
    c.runtime(async () => {
      entered();
      await new Promise((resolve) => (release = resolve));
    });
    const done = c.invoke(libs);
    void done.catch(() => {});
    const installing = c.dialog.nzData.installFn(libs);
    void installing.catch(() => {});
    await Promise.race([
      waiting,
      installing.then(() => assert.fail("Runtime did not pause")),
    ]);
    c.replaceWorkspace();
    release();
    await assert.rejects(installing, /workspace changed/);
    c.close({ result: "installed" });
    await assert.rejects(done, /workspace changed/);
    assert.equal(
      c.captures,
      0,
      "No after-document or history adoption may consume the replacement workspace",
    );
    assert.equal(
      f.calls.filter((call) => call.operation === "historyCommit").length,
      0,
    );
    assert.equal(f.workers, 0);
    assert.equal(
      fs.existsSync(
        path.join(
          f.root,
          "local-libraries",
          ...f.name.split("/"),
          "definition.json",
        ),
      ),
      true,
      "Completed Main bytes are retained",
    );
  },
);

test("old Main capability and changed project both reject before Domain historyBegin or any target mutation", async (t) => {
  const f = fixture(t),
    c = subject(f, t),
    libs = [{ name: f.name, localPath: f.external }];
  f.port.capabilities = async () => ({ dependencyEnvironmentVersion: 1 });
  const done = c.invoke(libs);
  void done.catch(() => {});
  await assert.rejects(
    c.dialog.nzData.installFn(libs),
    (error) => error.code === "LIBRARY_ENVIRONMENT_UNAVAILABLE",
  );
  assert.equal(f.calls.length, 0);
  assert.equal(f.checkpoints.length, 0);
  c.domain.currentProjectPath = path.join(f.directory, "foreign-project");
  await assert.rejects(
    c.dialog.nzData.installFn(libs),
    /PROJECT_OWNER_CHANGED/,
  );
  c.close({ result: "installed" });
  await assert.rejects(done, /PROJECT_OWNER_CHANGED/);
  assert.equal(f.calls.length, 0);
});

test("Stop during capability await keeps the original abort reason and dispatches no history or npm mutation", async (t) => {
  const f = fixture(t),
    c = subject(f, t),
    libs = [{ name: f.name, localPath: f.external }];
  let release, entered;
  const ready = new Promise((resolve) => (entered = resolve));
  f.port.capabilities = async () => {
    entered();
    await new Promise((resolve) => (release = resolve));
    return { dependencyEnvironmentVersion: 2 };
  };
  const done = c.invoke(libs);
  void done.catch(() => {});
  const installing = c.dialog.nzData.installFn(libs);
  void installing.catch(() => {});
  await ready;
  const reason = new Error("user_stop");
  c.controller.abort(reason);
  release();
  await assert.rejects(installing, (error) => error === reason);
  await assert.rejects(done, (error) => error === reason);
  assert.equal(f.calls.length, 0);
  assert.equal(f.checkpoints.length, 0);
  assert.equal(f.workers, 0);
});

test("Stop reaching Main before mutate uses the original env1 cancellation and runs no npm worker", async (t) => {
  const f = fixture(t),
    c = subject(f, t),
    libs = [{ name: f.name, localPath: f.external }],
    mutate = f.port.mutate;
  let originalId;
  const reason = new Error("user_stop_before_admission");
  f.port.mutate = async (project, request) => {
    originalId = request.requestId;
    c.controller.abort(reason);
    await new Promise((resolve) => setImmediate(resolve));
    return mutate(project, request);
  };
  const before = fs.readFileSync(path.join(f.root, "package.json"));
  const done = c.invoke(libs);
  void done.catch(() => {});
  await assert.rejects(
    c.dialog.nzData.installFn(libs),
    (error) => error === reason,
  );
  await assert.rejects(done, (error) => error === reason);
  assert.match(originalId, /^env1-/);
  assert.deepEqual(
    f.calls
      .filter((call) => call.operation === "cancelEnvironment")
      .map((call) => call.request.requestId),
    [originalId],
  );
  assert.equal(f.checkpoints.length, 0);
  assert.equal(f.workers, 0);
  assert.ok(fs.readFileSync(path.join(f.root, "package.json")).equals(before));
  assert.equal(c.domain.libraryMutation, undefined);
});

test(
  "lost completion ACK observes only the original env1 and retains its actual installed bytes and live C",
  { timeout: 60000 },
  async (t) => {
    const f = fixture(t),
      c = subject(f, t),
      libs = [{ name: f.name, localPath: f.external }],
      mutate = f.port.mutate;
    f.port.mutate = async (project, request) => {
      await mutate(project, request);
      throw Object.assign(new Error("reply lost"), { code: "ECONNRESET" });
    };
    const done = c.invoke(libs);
    void done.catch(() => {});
    await c.dialog.nzData.installFn(libs);
    c.close({ result: "installed" });
    await done;
    const writes = f.calls.filter((call) => call.operation === "mutate");
    assert.equal(writes.length, 1);
    assert.deepEqual(
      [...new Set(f.checkpoints)],
      [writes[0].request.requestId],
      "The original Main transaction may run its existing prepare/reify/save phases, never another installation identity",
    );
    const reads = f.calls.filter(
      (call) => call.operation === "observeEnvironment",
    );
    assert.ok(reads.length >= 3);
    assert.ok(
      reads.every(
        (call) => call.request.requestId === writes[0].request.requestId,
      ),
    );
    assert.equal(c.captures, 1);
    assert.equal(c.working.pages[0].content.fields.C, 201);
    assert.equal(f.workers, 0);
    assert.equal(
      fs.readFileSync(
        path.join(
          f.root,
          "local-libraries",
          ...f.name.split("/"),
          "definition.json",
        ),
        "utf8",
      ),
      "original external source",
    );
    assert.equal(
      fs.realpathSync(path.join(f.root, "node_modules", ...f.name.split("/"))),
      fs.realpathSync(
        path.join(f.root, "local-libraries", ...f.name.split("/")),
      ),
    );
    for (const [file, bytes] of f.programs)
      assert.ok(fs.readFileSync(path.join(f.root, file)).equals(bytes));
  },
);

test(
  "each local paste plan has its own Domain history scope and matching immutable environment ID",
  { timeout: 90000 },
  async (t) => {
    const f = fixture(t),
      c = subject(f, t),
      second = path.join(f.directory, "external-second"),
      secondName = "@aily-project/lib-r2-paste-second";
    fs.mkdirSync(second);
    fs.writeFileSync(
      path.join(second, "package.json"),
      JSON.stringify({ name: secondName, version: "1.0.0" }),
    );
    fs.writeFileSync(
      path.join(second, "definition.json"),
      "second original source",
    );
    const libs = [
        { name: f.name, localPath: f.external },
        { name: secondName, localPath: second },
      ],
      done = c.invoke(libs);
    void done.catch(() => {});
    await c.dialog.nzData.installFn(libs);
    c.close({ result: "installed" });
    await done;
    const mutations = f.calls.filter((call) => call.operation === "mutate"),
      begins = f.calls.filter((call) => call.operation === "historyBegin"),
      commits = f.calls.filter((call) => call.operation === "historyCommit");
    assert.equal(mutations.length, 2);
    assert.equal(begins.length, 2);
    assert.equal(commits.length, 2);
    assert.notEqual(
      mutations[0].request.requestId,
      mutations[1].request.requestId,
    );
    for (let index = 0; index < 2; index++) {
      assert.deepEqual(
        [...begins[index].request.packages],
        [
          `${index ? secondName : f.name}@file:./local-libraries/${index ? secondName : f.name}`,
        ],
      );
      assert.deepEqual(
        [...mutations[index].request.packages],
        [
          `${index ? secondName : f.name}@file:./local-libraries/${index ? secondName : f.name}`,
        ],
      );
      assert.equal(mutations[index].request.localSource.force, false);
    }
    assert.equal(c.captures, 2);
    assert.equal(f.workers, 0);
    assert.equal(c.domain.libraryMutation, undefined);
  },
);

test(
  "Stop after Main completion releases the old Domain owner without rolling back committed local bytes",
  { timeout: 60000 },
  async (t) => {
    const f = fixture(t),
      c = subject(f, t),
      libs = [{ name: f.name, localPath: f.external }];
    let entered, release;
    const waiting = new Promise((resolve) => (entered = resolve));
    c.runtime(async () => {
      entered();
      await new Promise((resolve) => (release = resolve));
    });
    const done = c.invoke(libs);
    void done.catch(() => {});
    const installing = c.dialog.nzData.installFn(libs);
    void installing.catch(() => {});
    await Promise.race([
      waiting,
      installing.then(() => assert.fail("Runtime did not pause")),
    ]);
    const original = f.calls.find((call) => call.operation === "mutate").request
      .requestId;
    const beforeStop = await f.sessions.run("observeEnvironment", f.root, {
      requestId: original,
    });
    assert.equal(beforeStop.environment.status, "completed");
    assert.equal(beforeStop.environment.current, true);
    const reason = new Error("user_stop_after_commit");
    c.controller.abort(reason);
    release();
    await assert.rejects(installing, (error) => error === reason);
    await assert.rejects(done, (error) => error === reason);
    assert.equal(c.captures, 0);
    assert.equal(
      f.calls.filter((call) => call.operation === "historyCommit").length,
      0,
    );
    assert.equal(c.domain.libraryMutation, undefined);
    const afterStop = await f.sessions.run("observeEnvironment", f.root, {
      requestId: original,
    });
    assert.equal(afterStop.environment.status, "completed");
    assert.equal(afterStop.environment.current, true);
    assert.equal(
      fs.readFileSync(
        path.join(
          f.root,
          "local-libraries",
          ...f.name.split("/"),
          "definition.json",
        ),
        "utf8",
      ),
      "original external source",
    );
    assert.equal(f.workers, 0);
  },
);

test("wrong local package identity and destroyed original component cannot install or adopt", async (t) => {
  const f = fixture(t),
    c = subject(f, t),
    libs = [{ name: f.name, localPath: f.external }],
    done = c.invoke(libs);
  void done.catch(() => {});
  fs.writeFileSync(
    path.join(f.external, "package.json"),
    JSON.stringify({ name: "@aily-project/lib-foreign", version: "1.0.0" }),
  );
  await assert.rejects(
    c.dialog.nzData.installFn(libs),
    /Selected source is not/,
  );
  assert.equal(f.calls.length, 0);
  c.destroy();
  await assert.rejects(c.dialog.nzData.installFn(libs), /workspace changed/);
  c.close({ result: "installed" });
  await assert.rejects(done, /workspace changed/);
  assert.equal(f.calls.length, 0);
});
