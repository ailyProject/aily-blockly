const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const { transformSync } = require("esbuild");
const {
  LibraryDependencySessions,
} = require("../../electron/library-dependency-sessions");

const files = {
  settlement: "src/app/integrations/blockly/environment-settlement.ts",
  editor: "src/app/editors/blockly-editor/blockly-editor.component.ts",
  npm: "src/app/services/domains/dependencies/npm.service.ts",
};
function find(node, predicate) {
  if (predicate(node)) return node;
  let result;
  ts.forEachChild(node, (child) => {
    if (!result) result = find(child, predicate);
  });
  return result;
}
function actualDeclaration(file, name, method = false) {
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const found = find(
    source,
    (node) =>
      (method
        ? ts.isMethodDeclaration(node)
        : ts.isFunctionDeclaration(node)) &&
      node.name?.getText(source) === name,
  );
  assert.ok(found, `Actual producer method missing: ${name}`);
  const input = method
    ? `class Subject {${found.getText(source)}}\nmodule.exports=Subject.prototype[${JSON.stringify(name)}];`
    : `${found.getText(source)}\nmodule.exports=${name};`;
  return transformSync(input, { loader: "ts", format: "cjs", target: "node22" })
    .code;
}
function load(code, ports) {
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, ...ports });
  return module.exports;
}
const actualVersion = () =>
  new LibraryDependencySessions({}).capabilities().dependencyEnvironmentVersion;

function settlementFixture(
  version = actualVersion(),
  pending = [
    {
      version: 1,
      requestId: "env1-original",
      programRef: { version: 1, operationId: "original-program" },
    },
  ],
) {
  const calls = [];
  const window = {
    libraryDependencies:
      version === undefined
        ? undefined
        : {
            environmentVersion: version,
            async pendingEnvironment(project) {
              calls.push(["pending", project]);
              return pending;
            },
            async settleLinkedEnvironment(project, fact) {
              calls.push(["settle", project, JSON.parse(JSON.stringify(fact))]);
            },
          },
  };
  const run = load(
    actualDeclaration(files.settlement, "settleLinkedProjectEnvironment"),
    {
      window,
      openAbsHostStorage: async () => {
        calls.push(["open"]);
        return {};
      },
      settleAbsProjectTransaction: async () => {
        calls.push(["program-settlement"]);
      },
      observeRuntimePublication: async () => ({
        observation: {
          state: "completed",
          result: { publication: { status: "COMMITTED" } },
        },
      }),
    },
  );
  return { calls, run: () => run("exact-project", () => {}) };
}

test("current Main capability 2 reaches linked settlement without changing version-1 environment records", async () => {
  assert.equal(actualVersion(), 2);
  const f = settlementFixture();
  await f.run();
  assert.deepEqual(
    f.calls.map((call) => call[0]),
    ["pending", "open", "program-settlement", "settle"],
  );
  assert.equal(f.calls.at(-1)[2].version, 1);
  assert.equal(f.calls.at(-1)[2].requestId, "env1-original");
});
test("current capability with no linked pending request remains one readonly lookup and opens no program storage", async () => {
  const f = settlementFixture(actualVersion(), []);
  await f.run();
  assert.deepEqual(f.calls, [["pending", "exact-project"]]);
});
test("legacy or absent settlement capability does not acquire storage or invent a recovery operation", async () => {
  for (const version of [1, null]) {
    const f = settlementFixture(version);
    await f.run();
    assert.deepEqual(f.calls, []);
  }
});

function npmFixture(
  version = actualVersion(),
  installed = false,
  coder = false,
) {
  const calls = [],
    window = { fs: { readFileSync: () => '{"devmode":"arduino"}' }, path };
  if (version !== null)
    window.libraryDependencies = {
      environmentVersion: version,
      async reconcile(project, request) {
        calls.push(["reconcile", project, JSON.parse(JSON.stringify(request))]);
        installed = true;
      },
    };
  const run = load(
    actualDeclaration(files.npm, "installProjectDependencies", true),
    { window, setTimeout() {} },
  );
  const service = {
    configService: {
      isCoderProduct: () => coder,
      getNpmRegistryForProject: () => "https://registry.invalid/owned",
    },
    installedOk: async () => installed,
    assertDependencySession() {},
    ensureCoderDependencyLibrarySources: async () => true,
    invalidateCloudDependencyInventory() {},
    isAilyCodeProjectRoot: () => false,
    installCoderProjectDependencies: async () => {
      calls.push(["coder"]);
      return true;
    },
    cmdService: {
      runAsync: async () => {
        calls.push(["raw-npm"]);
        throw Error("No raw fallback");
      },
    },
  };
  return {
    calls,
    window,
    run: () =>
      run.call(service, "exact-project", undefined, { original: "load-owner" }),
  };
}
test("NpmService actual Blockly install method delegates once to the current environment publisher", async () => {
  const f = npmFixture();
  assert.equal(await f.run(), true);
  assert.deepEqual(f.calls, [
    [
      "reconcile",
      "exact-project",
      {
        options: { "@aily-project:registry": "https://registry.invalid/owned" },
      },
    ],
  ]);
});
test("NpmService rejects old/missing capability and never runs a raw mutation fallback", async () => {
  for (const version of [1, null]) {
    const f = npmFixture(version);
    await assert.rejects(f.run(), /publisher is unavailable/);
    assert.deepEqual(f.calls, []);
  }
});
test("already installed and Coder dependency paths retain their existing lightweight behavior", async () => {
  for (const coder of [false, true]) {
    const f = npmFixture(null, true, coder);
    Object.defineProperty(f.window, "libraryDependencies", {
      get() {
        assert.fail(
          "A readonly/legacy Coder path must not require the Blockly mutation capability",
        );
      },
    });
    assert.equal(await f.run(), true);
    assert.deepEqual(f.calls, coder ? [["coder"]] : []);
  }
});

function editorFixture(version = actualVersion(), installed = false) {
  const calls = [],
    warnings = [],
    checkpoint = Error(
      "after dependency admission; no renderer loading executed",
    );
  const manifest = {
    name: "fixture",
    dependencies: { "@aily-project/board-test": "1.0.0" },
  };
  const window = {};
  if (version !== null)
    window.libraryDependencies = {
      environmentVersion: version,
      async reconcile(project, request) {
        calls.push(["reconcile", project, JSON.parse(JSON.stringify(request))]);
        installed = true;
      },
    };
  const run = load(actualDeclaration(files.editor, "prepareProject", true), {
    window,
    setTimeout() {},
    normalizeProjectMode: () => "arduino",
    console: { warn: (...args) => warnings.push(args), error() {} },
  });
  const service = {
    stopPackageJsonDependencyWatch() {},
    clearProjectLoadedCodeRefreshTimer() {},
    projectService: {
      discardLibraryChanges: async () => {},
      addRecentlyProject() {},
      loadBoardMenuConfig: async () => {
        throw checkpoint;
      },
    },
    electronService: {
      readFile: () => JSON.stringify(manifest),
      setTitle() {},
    },
    configService: {
      ensureLibraryListForProject: async () => {},
      getApplicationName: () => "fixture",
      getNpmRegistryForProject: () => undefined,
    },
    applyProjectPackageJson() {},
    getDeclaredBlocklyLibraryDependencies: () => [],
    npmService: {
      ensureProjectDependenciesInstalled: async () => true,
      installedOk: async () => installed,
    },
    readProjectPackageJson: () => manifest,
    getMissingDeclaredDependencies: () => ["@aily-project/board-test"],
    isBlocklyLibraryPackageName: () => false,
    uiService: { updateFooterState() {} },
    translate: { instant: (key) => key },
  };
  return {
    calls,
    warnings,
    window,
    checkpoint,
    run: () => run.call(service, "exact-project", {}, () => {}),
  };
}
test("Blockly editor actual preparation admits Main version 2 before proceeding to the next existing load phase", async () => {
  const f = editorFixture();
  await assert.rejects(f.run(), (error) => error === f.checkpoint);
  assert.deepEqual(f.calls, [["reconcile", "exact-project", { options: {} }]]);
  assert.deepEqual(f.warnings, []);
});
test("Blockly editor old/missing capability cannot mutate dependencies or silently continue with missing board dependencies", async () => {
  for (const version of [1, null]) {
    const f = editorFixture(version);
    await assert.rejects(f.run(), /项目依赖不完整/);
    assert.deepEqual(f.calls, []);
    assert.match(String(f.warnings[0]?.[1]), /publisher is unavailable/);
  }
});
test("Blockly editor already-installed path does not read a dependency mutation capability", async () => {
  const f = editorFixture(null, true);
  Object.defineProperty(f.window, "libraryDependencies", {
    get() {
      assert.fail("No install is needed");
    },
  });
  await assert.rejects(f.run(), (error) => error === f.checkpoint);
  assert.deepEqual(f.calls, []);
});
