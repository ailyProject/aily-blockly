"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const ts = require("typescript");
const root = path.resolve(__dirname, "../..");
const app = path.join(root, "src/app");
const modules = new Map();

function load(relative) {
  const file = path.resolve(app, relative);
  if (modules.has(file)) return modules.get(file).exports;
  const module = { exports: {} };
  modules.set(file, module);
  const source = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
  }).outputText;
  const resolve = (name) => {
    if (
      name === "@domain/project/public-api" ||
      name === "@domain/project/project-document/public-api"
    ) {
      return load("services/domains/project/project-document-json.ts");
    }
    if (name === "@domain/project/project-data/public-api")
      return {
        ...load("services/domains/project/project-document-json.ts"),
        ...load(
          "services/domains/project/project-data/project-data-payloads.ts",
        ),
      };
    if (name === "@shared/public-api")
      return load("services/shared/abs/abs-json-tokens.ts");
    if (name.startsWith("."))
      return load(
        path.relative(app, path.resolve(path.dirname(file), name + ".ts")),
      );
    return require(name);
  };
  vm.runInThisContext("(function(require,module,exports){" + source + "\n})", {
    filename: file,
  })(resolve, module, module.exports);
  return module.exports;
}

const json = load("services/domains/project/project-document-json.ts");
const model = load("editors/blockly-editor/services/blockly-project-model.ts");
const { assertAbsReadback } = load("integrations/blockly/abs/abs-readback.ts");
const { assertProjectLoadPreserved } = load(
  "editors/blockly-editor/services/blockly-project-clean-state.ts",
);
const { layoutAbsNewRoots } = load(
  "integrations/blockly/abs/abs-new-root-layout.ts",
);
const { sameAbsProgram } = load(
  "integrations/blockly/abs/abs-program-state.ts",
);

function actualApplyReadback() {
  const file = path.join(
    app,
    "integrations/blockly/abs/abs-workspace-sync.service.ts",
  );
  const source = fs.readFileSync(file, "utf8");
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  let statements;
  function visit(node) {
    if (
      ts.isBlock(node) &&
      node.statements.some(
        (statement) =>
          ts.isVariableStatement(statement) &&
          statement.declarationList.declarations.some(
            (declaration) => declaration.name.getText(tree) === "loadOptions",
          ),
      )
    ) {
      statements = node.statements;
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.ok(
    statements,
    "the production apply load/readback block must be located exactly",
  );
  const last = statements.findIndex(
    (statement) =>
      ts.isIfStatement(statement) &&
      statement.getText(tree).includes("assertProjectLoadPreserved"),
  );
  assert.ok(last > 0);
  const body = statements
    .slice(0, last + 1)
    .map((statement) => statement.getText(tree))
    .join("\n");
  const code = ts.transpileModule(
    `
    module.exports = function(ports) {
      const { layoutAbsNewRoots, sameAbsProgram, cloneBlocklyJson, absJson, replaceBlocklyPageWorkspace,
        assertAbsWorkspaceReadback, assertProjectLoadPreserved, captureAbsWorkspaceState } = ports;
      return async function({context,lease,options,candidate,materialized,fullDocument,before,rollback}) {
        ${body}
        return { materialized, fullDocument, applied };
      };
    };`,
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
      },
    },
  ).outputText;
  const module = { exports: {} };
  vm.runInThisContext("(function(module){" + code + "\n})", {
    filename: file + ":actual-apply-readback",
  })(module);
  return module.exports({
    layoutAbsNewRoots,
    sameAbsProgram,
    cloneBlocklyJson: json.cloneBlocklyJson,
    replaceBlocklyPageWorkspace: model.replaceBlocklyPageWorkspace,
    absJson: json.canonicalProjectJsonStringify,
    assertProjectLoadPreserved,
    assertAbsWorkspaceReadback: (expected, actual, captured) =>
      assertAbsReadback(expected, actual, captured),
    captureAbsWorkspaceState: (workspace) => ({
      state: json.cloneBlocklyJson(workspace.state),
    }),
  });
}

function fixture(unexpectedMove) {
  const existing = { type: "arduino_global", id: "existing", x: 30, y: 60 };
  const added = { type: "async_http_on_error", id: "on_error", x: 30, y: 6430 };
  const fullDocument = {
    schemaVersion: 3,
    activePageId: "page-1",
    openedPageIds: ["page-1"],
    pages: [
      {
        id: "page-1",
        title: "main",
        content: { blocks: { languageVersion: 0, blocks: [existing, added] } },
      },
    ],
    sharedModel: { procedureBlocks: [] },
  };
  const materialized = model.composeBlocklyPage(
    json.cloneBlocklyJson(fullDocument),
    "page-1",
  );
  const before = { document: json.cloneBlocklyJson(fullDocument) };
  before.document.pages[0].content.blocks.blocks.pop();
  const workspace = {
    state: null,
    render() {},
    RTL: false,
    getTopBlocks() {
      return this.state.blocks.blocks.map((block) =>
        this.getBlockById(block.id),
      );
    },
    getBlockById(id) {
      const state = this.state.blocks.blocks.find((block) => block.id === id);
      if (!state) return null;
      return {
        id,
        getParent: () => null,
        getRelativeToSurfaceXY: () => ({ x: state.x, y: state.y }),
        getBoundingRectangle: () => ({
          left: state.x,
          right: state.x + 100,
          top: state.y,
          bottom: state.y + (id === "existing" ? 835 : 40),
        }),
        moveBy(x, y) {
          state.x += x;
          state.y += y;
        },
      };
    },
  };
  const runtime = { Events: { disable() {}, enable() {} } };
  const editor = {
    async loadProjectDocumentSettled(document) {
      workspace.state = model.composeBlocklyPage(
        json.cloneBlocklyJson(document),
        "page-1",
      );
    },
    async prepareProjectCode() {
      unexpectedMove?.(workspace);
    },
    assertWorkspaceSharedChange() {},
    captureProjectSnapshot() {
      return {
        revision: 7,
        document: model.replaceBlocklyPageWorkspace(
          fullDocument,
          "page-1",
          workspace.state,
          () => undefined,
        ),
      };
    },
    getWorkspaceLoadReadbackView: (value) => value,
  };
  return {
    runtime,
    editor,
    input: {
      context: {
        workspace,
        scope: { pageId: "page-1" },
        assertCurrent() {},
        definitions: {},
      },
      lease: {},
      options: {},
      candidate: { added: ["on_error"], contracts: {} },
      materialized,
      fullDocument,
      before,
      rollback: { state: model.composeBlocklyPage(before.document, "page-1") },
    },
  };
}

test("authorized new-root placement must update the full-document expectation before complete readback", async (t) => {
  const f = fixture(),
    previous = global.window;
  global.window = { Blockly: f.runtime };
  try {
    let result;
    try {
      result = await actualApplyReadback().call(
        { editor: f.editor, withoutViewChecks: (work) => work() },
        f.input,
      );
    } catch (error) {
      t.diagnostic(
        JSON.stringify({ code: error.code, diagnostic: error.diagnostic }),
      );
      throw error;
    }
    assert.equal(
      result.materialized.blocks.blocks.find((block) => block.id === "on_error")
        .y,
      943,
    );
  } finally {
    global.window = previous;
  }
});

for (const id of ["existing", "on_error"])
  test(`an unplanned later move of ${id} remains a readback failure`, async () => {
    const f = fixture((workspace) => workspace.getBlockById(id).moveBy(0, 17)),
      previous = global.window;
    global.window = { Blockly: f.runtime };
    try {
      await assert.rejects(
        actualApplyReadback().call(
          { editor: f.editor, withoutViewChecks: (work) => work() },
          f.input,
        ),
        (error) =>
          error.code === "ABS_READBACK_MISMATCH" &&
          error.diagnostic.blockType ===
            (id === "existing" ? "arduino_global" : "async_http_on_error"),
      );
    } finally {
      global.window = previous;
    }
  });

test("inactive-page changes remain a full-document readback failure after planned placement", async () => {
  const f = fixture(),
    previous = global.window;
  const page = {
    id: "page-2",
    title: "untouched",
    content: {
      blocks: {
        languageVersion: 0,
        blocks: [
          {
            type: "dormant_probe",
            id: "dormant",
            x: 400,
            y: 900,
            fields: { LABEL: "keep" },
          },
        ],
      },
    },
  };
  f.input.fullDocument.pages.push(json.cloneBlocklyJson(page));
  f.input.before.document.pages.push(json.cloneBlocklyJson(page));
  const capture = f.editor.captureProjectSnapshot;
  f.editor.captureProjectSnapshot = () => {
    const snapshot = capture();
    snapshot.document.pages[1].content.blocks.blocks[0].fields.LABEL =
      "unplanned";
    return snapshot;
  };
  global.window = { Blockly: f.runtime };
  try {
    await assert.rejects(
      actualApplyReadback().call(
        { editor: f.editor, withoutViewChecks: (work) => work() },
        f.input,
      ),
      (error) =>
        error.code === "ABS_READBACK_MISMATCH" &&
        error.diagnostic.blockType === "dormant_probe",
    );
  } finally {
    global.window = previous;
  }
});

test("planned placement retains comments models and the immutable pre-layout document", async () => {
  const f = fixture(),
    previous = global.window;
  for (const document of [f.input.fullDocument, f.input.before.document]) {
    document.pages[0].content.blocks.blocks[0].icons = {
      comment: {
        text: "keep original comment",
        pinned: false,
        width: 160,
        height: 80,
      },
    };
    document.sharedModel.variables = [
      { id: "kept-variable", name: "flag", type: "" },
    ];
  }
  f.input.materialized = model.composeBlocklyPage(
    f.input.fullDocument,
    "page-1",
  );
  const original = json.cloneBlocklyJson(f.input.fullDocument);
  global.window = { Blockly: f.runtime };
  try {
    const result = await actualApplyReadback().call(
      { editor: f.editor, withoutViewChecks: (work) => work() },
      f.input,
    );
    assert.deepEqual(f.input.fullDocument, original);
    assert.deepEqual(result.applied.document.sharedModel, original.sharedModel);
    assert.deepEqual(
      result.applied.document.pages[0].content.blocks.blocks[0].icons,
      original.pages[0].content.blocks.blocks[0].icons,
    );
    assert.equal(
      result.applied.document.pages[0].content.blocks.blocks.find(
        (block) => block.id === "on_error",
      ).y,
      943,
    );
  } finally {
    global.window = previous;
  }
});
