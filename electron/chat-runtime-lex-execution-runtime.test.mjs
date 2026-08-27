import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  readManagedChatImageMedia,
  updateChatImageSessionReferences,
} from './chat-image-media-store.mjs';
import {
  buildEditingSessionProjection,
  createElectronInstalledSubappInventorySignature,
  createLexApprovalRuntimeConfig,
  createElectronBlocklyToolContributions,
  createElectronSkillRegistry,
  createElectronEditingTimelineOwner,
  createExternalSubappAgent,
  ensureExternalAgentSessionLease,
  externalAgentSessionLeasePath,
  releaseExternalAgentSessionLease,
  resolveEditingTimelineWorkspaceBinding,
  resolveElectronInstalledSubappAgentToolBindings,
  resolveElectronInstalledSubappSkillFiles,
  createExternalProject,
  createRuntimeOwner,
  invokeElectronBlocklyTool,
  invokeElectronSaveArchTool,
  hydrateChatImageSnapshot,
  normalizeHostToolUseResult,
} from './chat-runtime-lex-execution-runtime.mjs';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));

test('auto review remains independent from strict auto review in the Lex runtime projection', () => {
  assert.deepEqual(createLexApprovalRuntimeConfig({
    permissionMode: 'default',
    permissionProfile: 'workspace-write',
    approvalPolicy: 'on_request',
    approvalsReviewer: 'auto_review',
  }), {
    permissionMode: 'default',
    permissionProfile: 'workspace-write',
    approvalPolicy: 'on_request',
    approvalsReviewer: 'auto_review',
    strictAutoReview: false,
  });
});

test('worker approval lifecycle emits canonical request and resolution events for the same tool invocation', async () => {
  const owner = createRuntimeOwner();
  const events = [];
  const subscription = owner.onEvent(event => events.push(event));
  const session = {
    sessionId: 'session-approval-resolution',
    activeTurnId: 'turn-approval-resolution',
    revision: 4,
    handle: { respondToApproval() {} },
    pendingConfirmations: new Map(),
    pendingQuestions: new Map(),
    commandProcesses: new Map(),
  };
  owner.sessions.set(session.sessionId, session);

  try {
    const decisionPromise = owner.requestApproval(session, {
      approvalTraceId: 'approval-trace-1',
      toolCallId: 'tool-call-1',
      toolName: 'command_exec',
      title: 'Run command?',
      actions: [
        { id: 'allow-once', scope: 'once', label: 'Allow once' },
        { id: 'allow-session', scope: 'session', label: 'Allow all terminal commands' },
      ],
    });

    await owner.resolveInteraction({
      sessionId: session.sessionId,
      interactionId: 'tool-call-1',
      request: {
        kind: 'confirmation.resolve',
        payload: {
          result: {
            approved: true,
            scope: 'session',
            actionId: 'allow-session',
          },
        },
      },
    });

    assert.deepEqual(await decisionPromise, {
      approved: true,
      scope: 'session',
      actionId: 'allow-session',
    });
    const renderEvents = events.filter(event => event.kind === 'render-event');
    assert.equal(renderEvents.length, 2);
    assert.deepEqual(renderEvents[0], {
      kind: 'render-event',
      sessionId: session.sessionId,
      turnId: session.activeTurnId,
      revision: 5,
      renderEvent: {
        type: 'approval_request',
        approvalTraceId: 'approval-trace-1',
        toolCallId: 'tool-call-1',
        toolName: 'command_exec',
        input: {},
        message: 'command_exec requires approval',
        title: 'Run command?',
        subtitle: 'command_exec',
        actions: [
          { id: 'allow-once', scope: 'once', label: 'Allow once' },
          { id: 'allow-session', scope: 'session', label: 'Allow all terminal commands' },
        ],
        primaryScope: 'once',
        timestamp: renderEvents[0].renderEvent.timestamp,
      },
    });
    assert.deepEqual(renderEvents[1], {
      kind: 'render-event',
      sessionId: session.sessionId,
      turnId: session.activeTurnId,
      revision: 7,
      renderEvent: {
        type: 'approval_resolve',
        approvalTraceId: 'approval-trace-1',
        toolCallId: 'tool-call-1',
        result: 'approved',
        scope: 'session',
        selectedActionId: 'allow-session',
        selectedActionLabel: 'Allow all terminal commands',
        timestamp: renderEvents[1].renderEvent.timestamp,
      },
    });
    assert.equal(Number.isFinite(renderEvents[0].renderEvent.timestamp), true);
    assert.equal(Number.isFinite(renderEvents[1].renderEvent.timestamp), true);
  } finally {
    subscription.dispose();
    owner.sessions.delete(session.sessionId);
    await owner.dispose();
  }
});

test('worker library discovery exposes canonical packageName and direct install guidance', async () => {
  const searches = [];
  const hostAPI = {
    boardSearch: {
      search: async (query, scope) => {
        searches.push({ query, scope });
        return {
          libraries: [{ name: 'lib-seeed-aht20', description: 'AHT20 sensor blocks' }],
        };
      },
    },
  };

  const result = await invokeElectronBlocklyTool('search_boards_libraries', {
    query: 'AHT20',
    type: 'libraries',
  }, hostAPI);
  const payload = JSON.parse(result.content[0].text);
  assert.deepEqual(searches, [{ query: 'AHT20', scope: 'libraries' }]);
  assert.equal(payload.libraries[0].packageName, '@aily-project/lib-seeed-aht20');

  const boardSearchResult = await invokeElectronBlocklyTool('boardSearch', {
    action: 'search',
    query: 'AHT20',
    type: 'libraries',
  }, hostAPI);
  const boardSearchPayload = JSON.parse(boardSearchResult.content[0].text);
  assert.equal(boardSearchPayload.libraries[0].packageName, '@aily-project/lib-seeed-aht20');

  const contributions = createElectronBlocklyToolContributions(hostAPI);
  for (const name of ['boardSearch', 'search_boards_libraries']) {
    const contribution = contributions.find(tool => tool.name === name);
    assert.match(contribution.prompt, /packageName/);
    assert.match(contribution.prompt, /npm install <packageName>/);
    assert.match(contribution.prompt, /Do not use tool_search/);
  }
});

async function startImageVerticalServicesFixture(capturePath) {
  const serviceRoot = path.resolve(currentDirectory, '..', '..', 'aily-services', 'services', 'ai');
  const fixturePath = path.join(
    serviceRoot,
    'tests',
    'fixtures',
    'image_vertical_server.py',
  );
  const child = spawn(
    process.env.PYTHON || 'python',
    [fixturePath, '--port', '0', '--capture', capturePath],
    {
      cwd: serviceRoot,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => {
    stdout += chunk;
  });
  child.stderr.on('data', chunk => {
    stderr += chunk;
  });

  const port = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out starting image vertical services fixture.\n${stderr}`));
    }, 15_000);
    const inspectOutput = () => {
      const match = stdout.match(/(?:^|\r?\n)READY (\d+)(?:\r?\n|$)/u);
      if (!match) {
        return;
      }
      clearTimeout(timeout);
      resolve(Number(match[1]));
    };
    child.stdout.on('data', inspectOutput);
    child.once('error', error => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', code => {
      clearTimeout(timeout);
      reject(new Error(
        `Image vertical services fixture exited before ready (code=${code}).\n${stderr}`,
      ));
    });
    inspectOutput();
  });

  return {
    endpoint: `http://127.0.0.1:${port}`,
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      child.kill();
      await new Promise(resolve => {
        const timeout = setTimeout(resolve, 5_000);
        child.once('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    },
  };
}

test('external terminal session lease is durable and removed on release', async () => {
  const appDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'aily-agent-session-lease-'));
  const env = { AILY_APPDATA_PATH: appDataPath };
  const session = { sessionId: 'session:/serial debug' };

  try {
    const expectedPath = externalAgentSessionLeasePath(session.sessionId, env);
    const leaseFile = ensureExternalAgentSessionLease(session, env);
    const lease = JSON.parse(await fs.readFile(leaseFile, 'utf8'));

    assert.equal(leaseFile, expectedPath);
    assert.equal(lease.sessionId, session.sessionId);
    assert.equal(lease.ownerPid, process.pid);
    assert.equal(session.agentSessionLeaseFile, leaseFile);

    releaseExternalAgentSessionLease(session.sessionId, session, env);
    await assert.rejects(fs.stat(leaseFile), error => error?.code === 'ENOENT');
    assert.equal(session.agentSessionLeaseFile, '');
  } finally {
    await fs.rm(appDataPath, { recursive: true, force: true });
  }
});

test('disposing a chat session releases semantic subapp and CLI daemon leases', async () => {
  const appDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'aily-agent-session-dispose-'));
  const requests = [];
  const runtime = createRuntimeOwner({
    env: { AILY_APPDATA_PATH: appDataPath },
    requestResourceOperation: async request => {
      requests.push(request);
      return { result: { released: true } };
    }
  });
  const session = { sessionId: 'serial-session-dispose' };

  try {
    const leaseFile = ensureExternalAgentSessionLease(session, runtime.env);
    runtime.sessions.set(session.sessionId, session);

    await runtime.disposeSessionResources({ sessionId: session.sessionId });

    assert.equal(runtime.sessions.has(session.sessionId), false);
    assert.equal(requests.some(request => (
      request.kind === 'subapp-agent'
      && request.payload?.action === 'releaseSession'
    )), true);
    await assert.rejects(fs.stat(leaseFile), error => error?.code === 'ENOENT');
  } finally {
    await runtime.dispose();
    await fs.rm(appDataPath, { recursive: true, force: true });
  }
});

test('agent skill discovery uses installed subapp manifests and ignores legacy child/tools copies', async () => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'aily-subapp-skills-'));
  const appDataPath = path.join(sandbox, 'appdata');
  const installRoot = path.join(appDataPath, 'npm-global', 'app');
  const packagePath = path.join(
    installRoot,
    'node_modules',
    '@aily-project',
    'subapp-serial-debugger',
  );
  const installedSkillPath = path.join(
    packagePath,
    'skill',
    'serial-device-debugger',
    'SKILL.md',
  );
  const legacyChildPath = path.join(sandbox, 'legacy-child');
  const legacySkillPath = path.join(
    legacyChildPath,
    'tools',
    'serial-debugger',
    'skill',
    'serial-device-debugger',
    'SKILL.md',
  );
  const env = {
    AILY_APPDATA_PATH: appDataPath,
    AILY_CHILD_PATH: legacyChildPath,
  };

  try {
    await fs.mkdir(path.dirname(installedSkillPath), { recursive: true });
    await fs.mkdir(path.dirname(legacySkillPath), { recursive: true });
    await fs.writeFile(path.join(installRoot, 'package.json'), JSON.stringify({
      name: 'aily-installed-subapps',
      private: true,
      dependencies: {
        '@aily-project/subapp-serial-debugger': '0.1.0',
      },
    }), 'utf8');
    await fs.writeFile(path.join(packagePath, 'package.json'), JSON.stringify({
      name: '@aily-project/subapp-serial-debugger',
      version: '0.1.0',
      ailySubapp: {
        agent: {
          skills: ['skill/serial-device-debugger/SKILL.md'],
        },
      },
    }), 'utf8');
    await fs.writeFile(installedSkillPath, [
      '---',
      'name: serial-device-debugger',
      'description: Current manifest skill',
      '---',
      '## Agent Workflow',
      'Prefer semantic serial tools over shell commands.',
    ].join('\n'), 'utf8');
    await fs.writeFile(legacySkillPath, [
      '---',
      'name: serial-device-debugger',
      'description: Stale child tools skill',
      '---',
      'Use one-shot CLI write.',
    ].join('\n'), 'utf8');

    assert.deepEqual(resolveElectronInstalledSubappSkillFiles(env), [installedSkillPath]);

    const registry = createElectronSkillRegistry(path.join(sandbox, 'workspace'), {}, {}, env);
    const context = registry.getContext('serial-device-debugger');
    assert.equal(context.skillMdPath, installedSkillPath.replace(/\\/g, '/'));
    assert.match(context.body, /Prefer semantic serial tools/);
    assert.doesNotMatch(context.body, /one-shot CLI write/);

    const before = createElectronInstalledSubappInventorySignature(env);
    await fs.writeFile(installedSkillPath, [
      '---',
      'name: serial-device-debugger',
      'description: Updated manifest skill',
      '---',
      'Updated tool-first workflow.',
    ].join('\n'), 'utf8');
    const after = createElectronInstalledSubappInventorySignature(env);
    assert.notEqual(after, before);
  } finally {
    await fs.rm(sandbox, { recursive: true, force: true });
  }
});

test('installed subapp Agent tools are contributed by the worker and preserve UI presentation evidence', async () => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'aily-subapp-agent-tools-'));
  const appDataPath = path.join(sandbox, 'appdata');
  const installRoot = path.join(appDataPath, 'npm-global', 'app');
  const packageName = '@aily-project/subapp-fixture';
  const packagePath = path.join(installRoot, 'node_modules', '@aily-project', 'subapp-fixture');
  const manifestPath = path.join(packagePath, 'agent', 'tools.json');
  const env = { AILY_APPDATA_PATH: appDataPath };

  try {
    await fs.mkdir(path.dirname(manifestPath), { recursive: true });
    await fs.writeFile(path.join(installRoot, 'package.json'), JSON.stringify({
      name: 'aily-installed-subapps',
      private: true,
      dependencies: { [packageName]: '0.1.0' },
    }), 'utf8');
    await fs.writeFile(path.join(packagePath, 'package.json'), JSON.stringify({
      name: packageName,
      version: '0.1.0',
      ailySubapp: {
        agent: {
          protocolVersion: 1,
          tools: {
            transport: 'aily-child-rpc',
            manifest: 'agent/tools.json',
          },
        },
      },
    }), 'utf8');
    await fs.writeFile(manifestPath, JSON.stringify({
      protocolVersion: 1,
      transport: 'aily-child-rpc',
      tools: [{
        name: 'fixture_session_manage',
        description: 'Open a fixture session.',
        permission: 'change',
        rpc: { method: 'fixture.session.open' },
        inputSchema: {
          type: 'object',
          properties: {
            presentUi: { type: 'string', enum: ['none', 'embedded', 'window'] },
          },
        },
      }],
    }), 'utf8');

    const bindings = resolveElectronInstalledSubappAgentToolBindings(env);
    assert.equal(bindings.length, 1);
    assert.equal(bindings[0].packageName, packageName);
    assert.equal(bindings[0].definition.name, 'fixture_session_manage');

    const requests = [];
    const subappAgent = createExternalSubappAgent('session-subapp', async request => {
      requests.push(request);
      return {
        result: {
          ok: true,
          toolId: 'fixture',
          tool: 'fixture_session_manage',
          result: { state: 'connected' },
          presentation: {
            ok: true,
            requestedMode: 'embedded',
            operation: 'child_app_open',
          },
        },
      };
    }, env);
    const contributions = createElectronBlocklyToolContributions({ subappAgent });
    assert.ok(contributions.some(tool => tool.name === 'fixture_session_manage'));

    const result = await invokeElectronBlocklyTool('fixture_session_manage', {
      action: 'open',
      presentUi: 'embedded',
    }, { subappAgent }, {
      trace: { turnId: 'turn-subapp' },
      toolCallId: 'tool-subapp',
    });

    assert.equal(requests.length, 1);
    assert.equal(requests[0].kind, 'subapp-agent');
    assert.equal(requests[0].turnId, 'turn-subapp');
    assert.equal(requests[0].toolCallId, 'tool-subapp');
    assert.deepEqual(requests[0].payload.input, {
      tool: 'fixture_session_manage',
      params: {
        action: 'open',
        presentUi: 'embedded',
      },
    });
    const response = JSON.parse(result.content[0].text);
    assert.equal(response.ok, true);
    assert.equal(response.presentation.ok, true);
    assert.equal(response.presentation.requestedMode, 'embedded');
    assert.equal(result.metadata.presentation.requestedMode, 'embedded');
  } finally {
    await fs.rm(sandbox, { recursive: true, force: true });
  }
});

test('custom model credentials stay on the Aily services proxy model config', () => {
  const owner = createRuntimeOwner({
    env: {
      AILY_SERVICES_API_ENDPOINT: 'https://service.example.test',
    },
  });
  const model = {
    model: 'claude-custom',
    baseUrl: 'https://api.anthropic.com/v1',
    apiKey: 'sk-ant-test',
  };

  const endpoint = owner.createEndpoint(model, null);
  const config = owner.createModelConfig(model);

  assert.equal(endpoint.constructor.name, 'AilyServicesEndpoint');
  assert.deepEqual(config.llmConfig, {
    apiKey: 'sk-ant-test',
    baseUrl: 'https://api.anthropic.com/v1',
  });
});

test('explicit execution-host credentials override renderer runtime snapshots as one pair', () => {
  const owner = createRuntimeOwner({
    env: {
      AILY_EXECUTION_HOST_API_ENDPOINT: 'https://execution-host.example.test',
      AILY_EXECUTION_HOST_AUTH_TOKEN: 'execution-host-token',
      AILY_SERVICES_API_ENDPOINT: 'https://environment-fallback.example.test',
      AILY_AUTH_TOKEN: 'environment-fallback-token',
    },
  });
  const model = {
    apiEndpoint: 'https://model.example.test',
    authToken: 'model-token',
  };
  const runtimeConfig = {
    apiEndpoint: 'https://renderer.example.test',
    authToken: 'renderer-token',
  };

  assert.equal(
    owner.resolveAilyServicesBaseUrl(model, runtimeConfig),
    'https://execution-host.example.test',
  );
  assert.equal(
    owner.resolveAuthToken(model, runtimeConfig),
    'execution-host-token',
  );
});

test('execution host uses the active project as cwd instead of its project-list parent', () => {
  const owner = createRuntimeOwner({ env: {} });
  assert.equal(
    owner.resolveCwd({
      projectPath: 'D:/projects/demo',
      projectRootPath: 'D:/projects',
    }, null),
    'D:/projects/demo',
  );
});

test('editing-session projection follows the current timeline pointer instead of future operations', () => {
  const beforeRef = { hash: 'before', encoding: 'utf8', byteLength: 6 };
  const middleRef = { hash: 'middle', encoding: 'utf8', byteLength: 6 };
  const afterRef = { hash: 'after', encoding: 'utf8', byteLength: 5 };
  const projection = buildEditingSessionProjection({
    version: 4,
    sessionId: 'session-pointer',
    workspaceIdentity: 'global',
    workspaceRoot: '',
    revision: 3,
    checkpoints: [],
    baselines: [{
      requestId: 'request-1',
      uri: '/workspace/main.ts',
      epoch: 0,
      contentRef: beforeRef,
      contentKind: 'text',
      existed: true,
    }],
    operations: [
      {
        requestId: 'request-1',
        epoch: 1,
        uri: '/workspace/main.ts',
        contentKind: 'text',
        type: 'replace',
        beforeRef,
        afterRef: middleRef,
      },
      {
        requestId: 'request-2',
        epoch: 2,
        uri: '/workspace/main.ts',
        contentKind: 'text',
        type: 'replace',
        beforeRef: middleRef,
        afterRef,
      },
    ],
    requestScopes: [],
    currentPointer: { epoch: 1 },
    epochCounter: 2,
    entries: [],
  });

  assert.equal(projection.entries[0].currentRef.hash, 'middle');
  assert.equal(projection.entries[0].lastEpoch, 1);
});

test('editing-session projection never publishes malformed content references', () => {
  const projection = buildEditingSessionProjection({
    version: 4,
    sessionId: 'session-invalid-ref',
    workspaceIdentity: 'global',
    workspaceRoot: '',
    revision: 1,
    checkpoints: [],
    baselines: [{
      requestId: 'request-1',
      uri: '/workspace/main.ts',
      epoch: 0,
      contentRef: { hash: '', encoding: 'utf8', byteLength: -1 },
      contentKind: 'text',
      existed: true,
    }],
    operations: [],
    requestScopes: [],
    currentPointer: { epoch: 0 },
    epochCounter: 0,
    entries: [],
  });

  assert.equal(projection.baselines[0].contentRef, null);
  assert.equal(projection.entries[0].originalRef, null);
  assert.equal(projection.entries[0].currentRef, null);
});

test('editing-session projection preserves canonical binary content references', () => {
  const binaryRef = { hash: 'binary', encoding: 'base64', byteLength: 3 };
  const projection = buildEditingSessionProjection({
    sessionId: 'session-binary',
    revision: 1,
    currentPointer: { epoch: 1 },
    baselines: [{
      uri: 'D:/workspace/image.bin',
      contentKind: 'binary',
      contentRef: null,
      existed: false,
      epoch: 0,
      requestId: 'turn-1',
    }],
    operations: [{
      type: 'write',
      uri: 'D:/workspace/image.bin',
      contentKind: 'binary',
      beforeRef: null,
      afterRef: binaryRef,
      epoch: 1,
      requestId: 'turn-1',
    }],
    checkpoints: [],
    requestScopes: [],
  });

  assert.deepEqual(projection.entries[0].currentRef, binaryRef);
});

test('electron editing timeline publishes a Git-compatible aggregate turn diff after commit', async () => {
  const appDataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aily-turn-diff-'));
  const workspaceRoot = path.join(appDataRoot, 'project');
  const events = [];
  try {
    await fs.mkdir(workspaceRoot, { recursive: true });
    const binding = resolveEditingTimelineWorkspaceBinding(
      { path: workspaceRoot },
      null,
      { AILY_CHAT_APP_DATA_PATH: appDataRoot },
    );
    const timeline = createElectronEditingTimelineOwner(
      'session-turn-diff',
      binding,
      null,
      event => events.push(event),
    );
    await timeline.recordFileWrite({
      turnId: 'turn-1',
      filePath: path.join(workspaceRoot, 'main.ts'),
      existedBefore: true,
      beforeContent: 'const value = 1;\n',
      afterContent: 'const value = 2;\n',
    });

    assert.equal(events.length, 1);
    assert.equal(events[0].turnId, 'turn-1');
    assert.equal(events[0].revision, 1);
    assert.match(events[0].diff, /^diff --git a\/main\.ts b\/main\.ts/m);
    assert.match(events[0].diff, /^index [a-f0-9]{40}\.\.[a-f0-9]{40}$/m);
    assert.match(events[0].diff, /^-const value = 1;$/m);
    assert.match(events[0].diff, /^\+const value = 2;$/m);
  } finally {
    await fs.rm(appDataRoot, { recursive: true, force: true });
  }
});

test('external project creation activates only after the prepared mutation request resolves', async () => {
  const requests = [];
  const adopted = [];
  const project = createExternalProject('session-a', async request => {
    requests.push(request);
    if (request.payload.action === 'createProject') {
      return {
        result: {
          projectPrepared: true,
          projectOpened: false,
          projectPath: 'D:/projects/demo',
          mutationBatch: { transactionId: 'project:turn-a:tool-a:createProject' },
        },
      };
    }
    if (request.payload.action === 'activateCreatedProject') {
      return { result: { projectOpened: true, projectPath: 'D:/projects/demo' } };
    }
    throw new Error(`Unexpected action: ${request.payload.action}`);
  }, {}, value => adopted.push(value));

  const result = await project.createProject({ name: 'demo', board: 'board-a', path: 'D:/projects' }, {
    trace: { turnId: 'turn-a' },
    toolCallId: 'tool-a',
  });

  assert.deepEqual(requests.map(request => request.payload.action), ['createProject', 'activateCreatedProject']);
  assert.deepEqual(requests.map(request => [request.turnId, request.toolCallId]), [
    ['turn-a', 'tool-a'],
    ['turn-a', 'tool-a'],
  ]);
  assert.equal(result.projectOpened, true);
  assert.equal(adopted.length, 1);
});

test('external project creation discards the prepared directory when timeline commit fails', async () => {
  const requests = [];
  const commitError = Object.assign(new Error('timeline commit failed'), {
    resourceOperationResult: {
      result: {
        projectPath: 'D:/projects/demo',
        mutationBatch: { transactionId: 'project:turn-a:tool-a:createProject' },
      },
    },
  });
  const project = createExternalProject('session-a', async request => {
    requests.push(request);
    if (request.payload.action === 'createProject') {
      throw commitError;
    }
    if (request.payload.action === 'discardCreatedProject') {
      return { result: { discarded: true } };
    }
    throw new Error(`Unexpected action: ${request.payload.action}`);
  }, {}, () => assert.fail('failed project must not be adopted'));

  await assert.rejects(() => project.createProject({ name: 'demo', board: 'board-a' }, {
    trace: { turnId: 'turn-a' },
    toolCallId: 'tool-a',
  }), commitError);

  assert.deepEqual(requests.map(request => request.payload.action), ['createProject', 'discardCreatedProject']);
  assert.equal(requests[1].payload.transactionId, 'project:turn-a:tool-a:createProject');
});

function createSnapshot(sessionId, turns) {
  return {
    sessionId,
    turns,
    revision: 0,
    createdAt: 1,
    updatedAt: 2,
  };
}

function createTurn(id, request, resultText) {
  return {
    id,
    index: 0,
    request: { content: request },
    rounds: [],
    response: { parts: [], resultText },
    status: 'completed',
    createdAt: 1,
  };
}

test('hydrates persisted managed image references only inside the Lex runtime snapshot', async () => {
  const appDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'aily-image-snapshot-'));
  const env = { AILY_APPDATA_PATH: appDataPath };
  const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mNk+M/wHwAF/gL+Xb7qWQAAAABJRU5ErkJggg==';
  let owner;
  try {
    owner = createRuntimeOwner({ env });
    const preflight = await owner.preflightTurnImages({
      request: {
        currentModel: { inputModalities: ['text', 'image'] },
        imageAttachments: [{
          id: 'image-a',
          type: 'image',
          name: 'pixel.png',
          origin: 'clipboard',
          source: { kind: 'inline-base64', data: pngBase64 },
          mimeType: 'image/png',
        }],
      },
    });
    const mediaRef = preflight.imageAttachments[0].source.mediaRef;
    const persisted = createSnapshot('session-image', [{
      ...createTurn('turn-image', 'describe', 'done'),
      request: {
        content: 'describe',
        attachments: [{ type: 'image', name: 'pixel.png', uri: mediaRef, mimeType: 'image/png' }],
      },
      rounds: [{
        id: 'round-image',
        assistantText: 'capturing',
        toolCalls: [{
          id: 'tool-image',
          name: 'capture_screen',
          input: {},
          output: [{
            type: 'image',
            mediaRef,
            source: { type: 'managed-ref', mediaRef, mediaType: 'image/png' },
            dataOmitted: true,
          }],
        }],
        timestamp: 1,
      }],
    }]);

    const hydrated = await hydrateChatImageSnapshot(persisted, env);
    assert.equal(persisted.turns[0].request.attachments[0].content, undefined);
    assert.equal(persisted.turns[0].rounds[0].toolCalls[0].output[0].source.data, undefined);
    assert.equal(hydrated.turns[0].request.attachments[0].content, pngBase64);
    assert.equal(hydrated.turns[0].request.attachments[0].uri, mediaRef);
    assert.equal(hydrated.turns[0].rounds[0].toolCalls[0].output[0].source.type, 'base64');
    assert.equal(hydrated.turns[0].rounds[0].toolCalls[0].output[0].source.data, pngBase64);
    assert.equal(hydrated.turns[0].rounds[0].toolCalls[0].output[0].dataOmitted, undefined);
  } finally {
    await owner?.dispose();
    await fs.rm(appDataPath, { recursive: true, force: true });
  }
});

for (const scenario of [
  {
    name: 'auto image routing',
    key: 'auto',
    currentModel: {
      model: 'auto',
      modelId: 'auto',
      presetId: 'auto',
      inputModalities: ['text', 'image'],
      maxInputImages: 4,
    },
    routingMethod: 'image_input',
  },
  {
    name: 'fixed hosted vision preset',
    key: 'hosted-vision',
    currentModel: {
      model: 'vision-model',
      modelId: 'vision-model',
      presetId: 'auto-vision',
      inputModalities: ['text', 'image'],
      maxInputImages: 4,
    },
    routingMethod: 'profile_locked',
  },
]) {
  test(`worker carries a managed image through real Lex and Services using ${scenario.name}`, async () => {
    const appDataPath = await fs.mkdtemp(path.join(os.tmpdir(), `aily-image-worker-${scenario.key}-`));
    const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), `aily-image-workspace-${scenario.key}-`));
    const servicesCapturePath = path.join(appDataPath, 'services-image-capture.json');
    const servicesFixture = await startImageVerticalServicesFixture(servicesCapturePath);
    const sessionId = `session-image-${scenario.key}`;
    const turnId = `turn-image-${scenario.key}`;
    const env = {
      AILY_APPDATA_PATH: appDataPath,
      AILY_SERVICES_API_ENDPOINT: servicesFixture.endpoint,
      AILY_AUTH_TOKEN: 'test-token',
    };
    const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNg+M8AAAICAQB7CYF4AAAAAElFTkSuQmCC';
    let owner;
    let completionTimeout;
    try {
      owner = createRuntimeOwner({ env });
      const completion = new Promise((resolve, reject) => {
        completionTimeout = setTimeout(
          () => reject(new Error('Timed out waiting for the worker image turn to complete.')),
          10_000,
        );
        owner.onEvent(event => {
          if (
            event?.kind === 'runtime-status'
            && event?.sessionId === sessionId
            && event?.state?.status === 'completed'
            && event?.state?.requestInProgress === false
          ) {
            resolve();
          }
        });
      });
      const preflight = await owner.preflightTurnImages({
        currentModel: scenario.currentModel,
        request: {
          imageAttachments: [{
            id: `image-${scenario.key}`,
            type: 'image',
            name: 'pixel.png',
            origin: 'clipboard',
            source: { kind: 'inline-base64', data: pngBase64 },
            mimeType: 'image/png',
            detail: 'high',
          }],
        },
      });

      assert.match(
        preflight.imageAttachments[0].source.mediaRef,
        /^aily-media:v1:[a-f0-9]{64}$/,
      );
      await owner.startTurn({
        sessionId,
        turnId,
        currentModel: scenario.currentModel,
        providerOptions: { folderPath: workspacePath },
        request: {
          sessionId,
          activeResponseHandle: turnId,
          requestText: 'Describe this image.',
          currentModel: scenario.currentModel,
          imageAttachments: preflight.imageAttachments,
        },
      });
      await completion;
      const activeTurnPromise = owner.sessions.get(sessionId)?.activeTurnPromise;
      await activeTurnPromise;
      await new Promise(resolve => setImmediate(resolve));

      const servicesCapture = JSON.parse(await fs.readFile(servicesCapturePath, 'utf8'));
      assert.deepEqual(servicesCapture, {
        contractVersion: 'aily.chat.image-wire.v1',
        requestContainsManagedRef: false,
        validatedImageCount: 1,
        selectedPresetId: 'auto-vision',
        selectedModel: 'vision-model',
        routingMethod: scenario.routingMethod,
        providerFamily: 'openai',
        providerImageType: 'image_url',
        providerImageDetail: 'high',
        providerImageMime: 'image/png',
        assistantText: 'The image is a green pixel.',
        assetsToolAvailable: true,
        assetsToolInvoked: false,
        assetsToolRequired: false,
      });
      const snapshot = owner.sessions
        .get(sessionId)
        ?.handle
        ?.getSessionSnapshot?.();
      assert.ok(
        JSON.stringify(snapshot).includes('The image is a green pixel.'),
        'the provider description should return through Services and Lex into the worker snapshot',
      );
      assert.equal(
        owner.readSessionExecutionState({ sessionId }).requestInProgress,
        false,
      );
    } finally {
      if (completionTimeout) {
        clearTimeout(completionTimeout);
      }
      await owner?.dispose();
      await servicesFixture.stop();
      await fs.rm(appDataPath, { recursive: true, force: true });
      await fs.rm(workspacePath, { recursive: true, force: true });
    }
  });
}

test('restored tool image remains model-visible through real Lex and Services', async () => {
  const appDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'aily-tool-image-vertical-'));
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'aily-tool-image-workspace-'));
  const servicesCapturePath = path.join(appDataPath, 'services-image-capture.json');
  const servicesFixture = await startImageVerticalServicesFixture(servicesCapturePath);
  const sessionId = 'session-tool-image-vertical';
  const turnId = 'turn-after-tool-image';
  const env = {
    AILY_APPDATA_PATH: appDataPath,
    AILY_SERVICES_API_ENDPOINT: servicesFixture.endpoint,
    AILY_AUTH_TOKEN: 'test-token',
  };
  const currentModel = {
    model: 'auto',
    modelId: 'auto',
    presetId: 'auto',
    inputModalities: ['text', 'image'],
    maxInputImages: 4,
  };
  const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNg+M8AAAICAQB7CYF4AAAAAElFTkSuQmCC';
  let owner;
  let completionTimeout;
  try {
    const normalizedToolResult = await normalizeHostToolUseResult({
      content: [
        { type: 'text', text: 'Captured screen' },
        { type: 'image', data: pngBase64, mimeType: 'image/png' },
      ],
    }, { env });
    const toolImage = normalizedToolResult.content.find(part => part.type === 'image');
    assert.ok(toolImage?.mediaRef);

    owner = createRuntimeOwner({ env });
    await owner.restoreRuntimeSession({
      sessionId,
      currentModel,
      providerOptions: { folderPath: workspacePath },
      snapshot: createSnapshot(sessionId, [{
        ...createTurn('turn-tool-image-source', 'Capture the screen.', 'The screen was captured.'),
        rounds: [{
          id: 'round-tool-image-source',
          assistantText: '',
          toolCalls: [{
            id: 'tool-image-source',
            toolName: 'capture_screen',
            input: {},
            output: [
              { type: 'text', text: 'Captured screen' },
              {
                type: 'image',
                mediaRef: toolImage.mediaRef,
                source: {
                  type: 'managed-ref',
                  mediaRef: toolImage.mediaRef,
                  mediaType: toolImage.mimeType,
                },
              },
            ],
          }],
          timestamp: 1,
        }],
      }]),
    });

    const restoredSnapshot = owner.sessions.get(sessionId)?.handle?.getSessionSnapshot?.();
    assert.equal(
      restoredSnapshot.turns[0].rounds[0].toolCalls[0].output[1].source.type,
      'base64',
    );

    const completion = new Promise((resolve, reject) => {
      completionTimeout = setTimeout(
        () => reject(new Error('Timed out waiting for the restored tool-image turn to complete.')),
        10_000,
      );
      owner.onEvent(event => {
        if (
          event?.kind === 'runtime-status'
          && event?.sessionId === sessionId
          && event?.state?.status === 'completed'
          && event?.state?.requestInProgress === false
        ) {
          resolve();
        }
      });
    });
    await owner.startTurn({
      sessionId,
      turnId,
      currentModel,
      providerOptions: { folderPath: workspacePath },
      request: {
        sessionId,
        activeResponseHandle: turnId,
        requestText: 'What color was the captured pixel?',
        currentModel,
      },
    });
    await completion;
    await owner.sessions.get(sessionId)?.activeTurnPromise;
    await new Promise(resolve => setImmediate(resolve));

    const servicesCapture = JSON.parse(await fs.readFile(servicesCapturePath, 'utf8'));
    assert.deepEqual(servicesCapture, {
      contractVersion: 'aily.chat.image-wire.v1',
      requestContainsManagedRef: false,
      validatedImageCount: 1,
      selectedPresetId: 'auto-vision',
      selectedModel: 'vision-model',
      routingMethod: 'image_input',
      providerFamily: 'openai',
      providerImageType: 'image_url',
      providerImageDetail: 'auto',
      providerImageMime: 'image/png',
      assistantText: 'The image is a green pixel.',
      assetsToolAvailable: true,
      assetsToolInvoked: false,
      assetsToolRequired: false,
    });
    assert.ok(
      JSON.stringify(owner.sessions.get(sessionId)?.handle?.getSessionSnapshot?.())
        .includes('The image is a green pixel.'),
    );
  } finally {
    if (completionTimeout) {
      clearTimeout(completionTimeout);
    }
    await owner?.dispose();
    await servicesFixture.stop();
    await fs.rm(appDataPath, { recursive: true, force: true });
    await fs.rm(workspacePath, { recursive: true, force: true });
  }
});

test('restores a snapshot with missing historical images by preserving visible placeholders', async () => {
  const appDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'aily-image-snapshot-missing-'));
  const env = { AILY_APPDATA_PATH: appDataPath };
  const mediaRef = `aily-media:v1:${'a'.repeat(64)}`;
  const persisted = createSnapshot('session-image-missing', [{
    ...createTurn('turn-image-missing', 'describe', 'done'),
    request: {
      content: 'describe',
      attachments: [{ type: 'image', name: 'old screenshot.png', uri: mediaRef, mimeType: 'image/png' }],
    },
    rounds: [{
      id: 'round-image-missing',
      assistantText: 'capturing',
      toolCalls: [{
        id: 'tool-image-missing',
        name: 'capture_screen',
        input: {},
        output: [{
          type: 'image',
          name: 'tool screenshot.png',
          mediaRef,
          source: { type: 'managed-ref', mediaRef, mediaType: 'image/png' },
          dataOmitted: true,
        }],
      }],
      timestamp: 1,
    }],
  }]);
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));

  try {
    const hydrated = await hydrateChatImageSnapshot(persisted, env);
    assert.deepEqual(
      hydrated.turns[0].request.attachments[0],
      {
        type: 'image',
        name: 'old screenshot.png',
        uri: mediaRef,
        mimeType: 'image/png',
        unavailable: true,
        errorCode: 'IMAGE_MEDIA_MISSING',
      },
    );
    assert.deepEqual(
      hydrated.turns[0].rounds[0].toolCalls[0].output[0],
      {
        type: 'text',
        text: '[Historical tool image unavailable: tool screenshot.png (IMAGE_MEDIA_MISSING)]',
        mediaRef,
        unavailable: true,
        errorCode: 'IMAGE_MEDIA_MISSING',
      },
    );
    assert.equal(persisted.turns[0].request.attachments[0].unavailable, undefined);
    assert.equal(warnings.length, 2);
    assert.ok(warnings.every(line => line.includes('image.restore.missing')));
    assert.ok(warnings.every(line => line.includes('IMAGE_MEDIA_MISSING')));
    assert.ok(warnings.every(line => !line.includes(mediaRef)));
    assert.ok(warnings.every(line => !line.includes(appDataPath)));
  } finally {
    console.warn = originalWarn;
    await fs.rm(appDataPath, { recursive: true, force: true });
  }
});

test('normalizes tool-returned images into managed content without flattening them to text', async () => {
  const appDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'aily-tool-image-result-'));
  const env = { AILY_APPDATA_PATH: appDataPath };
  const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mNk+M/wHwAF/gL+Xb7qWQAAAABJRU5ErkJggg==';
  try {
    const result = await normalizeHostToolUseResult({
      content: [
        { type: 'text', text: 'captured screen' },
        { type: 'image', data: pngBase64, mimeType: 'image/png' },
      ],
      metadata: { source: 'test' },
    }, { env });

    assert.equal(result.isError, undefined);
    assert.deepEqual(result.content[0], { type: 'text', text: 'captured screen' });
    assert.equal(result.content[1].type, 'image');
    assert.equal(result.content[1].data, pngBase64);
    assert.equal(result.content[1].mimeType, 'image/png');
    assert.match(result.content[1].mediaRef, /^aily-media:v1:[a-f0-9]{64}$/u);
    assert.equal(result.content[1].width, 1);
    assert.equal(result.content[1].height, 1);
    assert.deepEqual(result.metadata, { source: 'test' });

    const hydrated = await hydrateChatImageSnapshot(createSnapshot('session-tool-image', [{
      ...createTurn('turn-tool-image', 'capture', 'done'),
      rounds: [{
        id: 'round-tool-image',
        assistantText: 'capturing',
        toolCalls: [{
          id: 'tool-image',
          name: 'capture_screen',
          input: {},
          output: [{
            type: 'image',
            mediaRef: result.content[1].mediaRef,
            source: {
              type: 'managed-ref',
              mediaRef: result.content[1].mediaRef,
              mediaType: result.content[1].mimeType,
            },
          }],
        }],
        timestamp: 1,
      }],
    }]), env);
    assert.equal(hydrated.turns[0].rounds[0].toolCalls[0].output[0].source.data, pngBase64);
  } finally {
    await fs.rm(appDataPath, { recursive: true, force: true });
  }
});

test('restoreRuntimeSession atomically replaces the worker request list', async () => {
  const owner = createRuntimeOwner();
  owner.readProjectInfo = async () => null;
  const restoredSnapshots = [];
  let currentSnapshot = createSnapshot('session-a', []);
  const session = {
    sessionId: 'session-a',
    providerOptions: null,
    currentModel: null,
    runtimeConfigKey: 'cold-prewarm',
    revision: 0,
    activeTurnId: null,
    activeAbortController: null,
    activeTurnPromise: null,
    handlePromise: Promise.resolve(),
    handle: {
      getSessionSnapshot: () => currentSnapshot,
      restoreSession: snapshot => {
        currentSnapshot = snapshot;
        restoredSnapshots.push(snapshot);
      },
    },
    pendingConfirmations: new Map(),
    pendingQuestions: new Map(),
    commandProcesses: new Map(),
  };
  owner.sessions.set('session-a', session);

  const originalReplace = owner.replaceSessionRuntimeWithSnapshot.bind(owner);
  owner.replaceSessionRuntimeWithSnapshot = async (target, _projectInfo, nextConfig, snapshot) => {
    target.runtimeConfigKey = nextConfig.runtimeConfigKey;
    target.providerOptions = nextConfig.providerOptions;
    target.currentModel = nextConfig.currentModel;
    target.handle.restoreSession(snapshot);
  };

  const firstSnapshot = createSnapshot('session-a', [
    createTurn('turn-1', '1+1', '2'),
    createTurn('turn-2', 'add 2', '4'),
  ]);
  const firstResult = await owner.restoreRuntimeSession({
    sessionId: 'session-a',
    snapshot: firstSnapshot,
  });
  assert.deepEqual(firstResult, { sessionId: 'session-a', restored: true, turnCount: 2 });
  assert.deepEqual(currentSnapshot.turns.map(turn => turn.id), ['turn-1', 'turn-2']);

  owner.replaceSessionRuntimeWithSnapshot = originalReplace;
  const secondSnapshot = createSnapshot('session-a', [
    createTurn('turn-1', '1+1', '2'),
    createTurn('turn-2', 'add 2', '4'),
    createTurn('turn-3', 'add 2', '6'),
  ]);
  const secondResult = await owner.restoreRuntimeSession({
    sessionId: 'session-a',
    snapshot: secondSnapshot,
  });
  assert.deepEqual(secondResult, { sessionId: 'session-a', restored: true, turnCount: 3 });
  assert.deepEqual(currentSnapshot.turns.map(turn => turn.id), ['turn-1', 'turn-2', 'turn-3']);
  assert.equal(restoredSnapshots.length, 2);
});

test('restoreRuntimeSession leaves durable image retention to the canonical host record', async () => {
  const appDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'aily-image-restore-references-'));
  const env = { AILY_APPDATA_PATH: appDataPath };
  const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mNk+M/wHwAF/gL+Xb7qWQAAAABJRU5ErkJggg==';
  const owner = createRuntimeOwner({ env });
  owner.readProjectInfo = async () => null;
  try {
    const preflight = await owner.preflightTurnImages({
      request: {
        currentModel: { inputModalities: ['text', 'image'] },
        imageAttachments: [{
          id: 'image-restore',
          type: 'image',
          name: 'restore.png',
          origin: 'clipboard',
          source: { kind: 'inline-base64', data: pngBase64 },
          mimeType: 'image/png',
        }],
      },
    });
    const mediaRef = preflight.imageAttachments[0].source.mediaRef;
    let currentSnapshot = createSnapshot('session-image-restore', [{
      ...createTurn('turn-image-restore', 'describe', 'done'),
      request: {
        content: 'describe',
        attachments: [{
          id: 'image-restore',
          type: 'image',
          name: 'restore.png',
          uri: mediaRef,
          mimeType: 'image/png',
        }],
      },
    }]);
    await updateChatImageSessionReferences(
      'session-image-restore',
      [mediaRef],
      { env },
    );

    const session = {
      sessionId: 'session-image-restore',
      providerOptions: null,
      currentModel: null,
      runtimeConfigKey: 'cold-prewarm',
      revision: 0,
      activeTurnId: null,
      activeAbortController: null,
      activeTurnPromise: null,
      handlePromise: Promise.resolve(),
      handle: {
        getSessionSnapshot: () => currentSnapshot,
        restoreSession: snapshot => {
          currentSnapshot = snapshot;
        },
      },
      pendingConfirmations: new Map(),
      pendingQuestions: new Map(),
      commandProcesses: new Map(),
    };
    owner.sessions.set(session.sessionId, session);
    owner.replaceSessionRuntimeWithSnapshot = async (target, _projectInfo, nextConfig, snapshot) => {
      target.runtimeConfigKey = nextConfig.runtimeConfigKey;
      target.handle.restoreSession(snapshot);
    };

    const result = await owner.restoreRuntimeSession({
      sessionId: session.sessionId,
      snapshot: createSnapshot(session.sessionId, []),
    });

    assert.deepEqual(result, {
      sessionId: session.sessionId,
      restored: true,
      turnCount: 0,
    });
    const retained = await readManagedChatImageMedia(mediaRef, { env });
    assert.equal(retained.mediaRef, mediaRef);
    assert.equal(retained.mimeType, 'image/png');
  } finally {
    await owner.dispose();
    await fs.rm(appDataPath, { recursive: true, force: true });
  }
});

test('restoreRuntimeSession rejects replacement while a turn is active', async () => {
  const owner = createRuntimeOwner();
  owner.readProjectInfo = async () => null;
  owner.sessions.set('session-running', {
    sessionId: 'session-running',
    providerOptions: null,
    currentModel: null,
    runtimeConfigKey: 'runtime',
    activeTurnId: 'turn-running',
    activeAbortController: new AbortController(),
    activeTurnPromise: Promise.resolve(),
    handlePromise: Promise.resolve(),
    handle: { getSessionSnapshot: () => createSnapshot('session-running', []) },
  });

  await assert.rejects(
    owner.restoreRuntimeSession({
      sessionId: 'session-running',
      snapshot: createSnapshot('session-running', [createTurn('turn-1', 'hello', 'world')]),
    }),
    /Cannot restore a running session/,
  );
});

test('worker editing timeline persists a managed write without a renderer owner', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aily-editing-timeline-'));
  const appDataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aily-editing-timeline-appdata-'));
  try {
    const legacyHistoryDir = path.join(workspaceRoot, '.aily', 'file-history', 'session-worker');
    await fs.mkdir(legacyHistoryDir, { recursive: true });
    await fs.writeFile(path.join(legacyHistoryDir, 'project.abs.backup'), 'legacy safety net');
    const workspaceBinding = resolveEditingTimelineWorkspaceBinding(
      { path: workspaceRoot },
      null,
      { AILY_CHAT_APP_DATA_PATH: appDataRoot },
    );
    const timeline = createElectronEditingTimelineOwner('session-worker', workspaceBinding);
    await timeline.beginRequest({
      requestId: 'turn-1',
      turnId: 'turn-1',
      checkpointId: 'checkpoint-1',
      label: 'Request turn-1',
    });
    await timeline.recordFileWrite({
      turnId: 'turn-1',
      toolCallId: 'replace-1',
      filePath: path.join(workspaceRoot, 'main.ts'),
      existedBefore: true,
      beforeContent: 'const value = 1;\n',
      afterContent: 'const value = 2;\n',
    });
    await timeline.completeRequest('turn-1');

    const state = JSON.parse(await fs.readFile(
      path.join(
        workspaceBinding.workspaceStorageRoot,
        'chatEditingSessions',
        'session-worker',
        'timeline.json',
      ),
      'utf8',
    ));
    assert.equal(state.version, 4);
    assert.equal(state.workspaceIdentity, workspaceBinding.workspaceIdentity);
    assert.equal(state.revision, 3);
    assert.equal(state.checkpoints.length, 1);
    assert.equal(state.baselines.length, 1);
    assert.equal(state.operations.length, 1);
    assert.equal(state.requestScopes[0].status, 'completed');
    assert.equal(state.requestScopes[0].outcome, 'completed');
    assert.equal(state.operations[0].type, 'replace');
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
    await fs.rm(appDataRoot, { recursive: true, force: true });
  }
});

test('worker editing timeline publishes its revision only after each durable mutation', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aily-editing-revision-'));
  const appDataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aily-editing-revision-appdata-'));
  try {
    const binding = resolveEditingTimelineWorkspaceBinding(
      { path: workspaceRoot },
      null,
      { AILY_CHAT_APP_DATA_PATH: appDataRoot },
    );
    const revisions = [];
    const timeline = createElectronEditingTimelineOwner(
      'session-revision',
      binding,
      diagnostic => revisions.push(diagnostic.revision),
    );
    await timeline.beginRequest({
      requestId: 'turn-1',
      turnId: 'turn-1',
      checkpointId: 'checkpoint-1',
    });
    await timeline.recordFileWrite({
      turnId: 'turn-1',
      filePath: path.join(workspaceRoot, 'main.ts'),
      existedBefore: false,
      beforeContent: null,
      afterContent: 'created',
    });
    await timeline.completeRequest('turn-1');

    assert.deepEqual(revisions, [1, 2, 3]);
    const storedState = JSON.parse(await fs.readFile(
      path.join(binding.workspaceStorageRoot, 'chatEditingSessions', 'session-revision', 'timeline.json'),
      'utf8',
    ));
    assert.equal(storedState.revision, revisions.at(-1));
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
    await fs.rm(appDataRoot, { recursive: true, force: true });
  }
});

test('worker exposes revision-bound editing-session entries and referenced snapshot content', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aily-editing-projection-'));
  const appDataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aily-editing-projection-appdata-'));
  const env = { AILY_CHAT_APP_DATA_PATH: appDataRoot };
  let runtime;
  try {
    const binding = resolveEditingTimelineWorkspaceBinding({ path: workspaceRoot }, null, env);
    const timeline = createElectronEditingTimelineOwner('session-projection', binding);
    await timeline.beginRequest({
      requestId: 'turn-1',
      turnId: 'turn-1',
      checkpointId: 'checkpoint-1',
    });
    await timeline.recordFileWrite({
      turnId: 'turn-1',
      filePath: path.join(workspaceRoot, 'main.ts'),
      existedBefore: true,
      beforeContent: 'before',
      afterContent: 'after',
    });
    await timeline.recordFileWrite({
      turnId: 'turn-1',
      filePath: path.join(workspaceRoot, 'main.ts'),
      existedBefore: true,
      beforeContent: 'after',
      afterContent: 'final',
    });
    await timeline.completeRequest('turn-1');

    runtime = createRuntimeOwner({ env });
    const state = await runtime.readEditingSessionState({
      sessionId: 'session-projection',
      projectPath: workspaceRoot,
    });
    assert.equal(state.revision, 4);
    assert.equal(state.summary.entryCount, 1);
    assert.equal(state.summary.operationCount, 2);
    assert.equal(state.summary.modifiedEntryCount, 1);
    assert.equal(state.requestSummaries[0].operationCount, 2);
    assert.equal(state.requestSummaries[0].entries.length, 1);
    assert.deepEqual(
      state.requestSummaries[0].entries[0].originalRef,
      state.entries[0].originalRef,
    );
    assert.deepEqual(
      state.requestSummaries[0].entries[0].currentRef,
      state.entries[0].currentRef,
    );
    assert.equal(state.entries[0].uri, path.join(workspaceRoot, 'main.ts'));
    assert.equal(state.entries[0].deleted, false);

    const content = await runtime.readEditingSessionContent({
      sessionId: 'session-projection',
      projectPath: workspaceRoot,
      contentRef: state.entries[0].currentRef,
    });
    assert.equal(content.revision, state.revision);
    assert.equal(Buffer.from(content.dataBase64, 'base64').toString('utf8'), 'final');
    const restorePlan = await runtime.buildEditingSessionNavigationPlan({
      sessionId: 'session-projection',
      projectPath: workspaceRoot,
      checkpointId: 'checkpoint-1',
      direction: 'restore',
    });
    assert.equal(restorePlan.expectedRevision, state.revision);
    assert.equal(restorePlan.fromEpoch, 2);
    assert.equal(restorePlan.restoreToEpoch, 0);
    assert.equal(restorePlan.navigateToEpoch, 0);
    assert.equal(restorePlan.files.length, 1);
    assert.deepEqual(restorePlan.files[0].contentRef, state.entries[0].originalRef);
    await assert.rejects(
      runtime.readEditingSessionContent({
        sessionId: 'session-projection',
        projectPath: workspaceRoot,
        contentRef: { hash: 'deadbeef', encoding: 'utf8', byteLength: 4 },
      }),
      /does not belong to this session/,
    );
  } finally {
    await runtime?.dispose();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
    await fs.rm(appDataRoot, { recursive: true, force: true });
  }
});

test('worker owns persisted accept and transactional reject for editing-session entries', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aily-editing-entry-'));
  const appDataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aily-editing-entry-appdata-'));
  const env = { AILY_CHAT_APP_DATA_PATH: appDataRoot };
  const filePath = path.join(workspaceRoot, 'main.ts');
  let runtime;
  try {
    await fs.writeFile(filePath, 'after', 'utf8');
    const binding = resolveEditingTimelineWorkspaceBinding({ path: workspaceRoot }, null, env);
    const timeline = createElectronEditingTimelineOwner('session-entry', binding);
    await timeline.recordFileWrite({
      turnId: 'turn-1',
      filePath,
      existedBefore: true,
      beforeContent: 'before',
      afterContent: 'after',
    });

    runtime = createRuntimeOwner({ env });
    const accepted = await runtime.operateEditingSessionEntry({
      sessionId: 'session-entry',
      projectPath: workspaceRoot,
      uri: filePath,
      action: 'accept',
    });
    assert.equal(accepted.entries[0].state, 'accepted');
    assert.equal(await fs.readFile(filePath, 'utf8'), 'after');

    await fs.writeFile(filePath, 'changed again', 'utf8');
    await timeline.recordFileWrite({
      turnId: 'turn-2',
      filePath,
      existedBefore: true,
      beforeContent: 'after',
      afterContent: 'changed again',
    });
    const rejected = await runtime.operateEditingSessionEntry({
      sessionId: 'session-entry',
      projectPath: workspaceRoot,
      uri: filePath,
      action: 'reject',
    });
    assert.equal(rejected.entries[0].state, 'rejected');
    assert.equal(rejected.summary.modifiedEntryCount, 0);
    assert.equal(await fs.readFile(filePath, 'utf8'), 'after');
  } finally {
    runtime?.dispose();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
    await fs.rm(appDataRoot, { recursive: true, force: true });
  }
});

test('worker accepts all modified editing-session entries in one owner mutation', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aily-editing-accept-all-'));
  const appDataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aily-editing-accept-all-appdata-'));
  const env = { AILY_CHAT_APP_DATA_PATH: appDataRoot };
  let runtime;
  try {
    const binding = resolveEditingTimelineWorkspaceBinding({ path: workspaceRoot }, null, env);
    const timeline = createElectronEditingTimelineOwner('session-accept-all', binding);
    await timeline.recordFileWrite({
      turnId: 'turn-1',
      filePath: path.join(workspaceRoot, 'a.ts'),
      existedBefore: true,
      beforeContent: 'a0',
      afterContent: 'a1',
    });
    await timeline.recordFileWrite({
      turnId: 'turn-1',
      filePath: path.join(workspaceRoot, 'b.ts'),
      existedBefore: false,
      beforeContent: null,
      afterContent: 'b1',
    });

    runtime = createRuntimeOwner({ env });
    const accepted = await runtime.acceptEditingSession({
      sessionId: 'session-accept-all',
      projectPath: workspaceRoot,
    });

    assert.equal(accepted.summary.modifiedEntryCount, 0);
    assert.deepEqual(accepted.entries.map(entry => entry.state), ['accepted', 'accepted']);
  } finally {
    await runtime?.dispose();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
    await fs.rm(appDataRoot, { recursive: true, force: true });
  }
});

test('worker checkpoint navigation applies bytes before committing the canonical pointer and can roll back', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aily-editing-navigation-'));
  const appDataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aily-editing-navigation-appdata-'));
  const env = { AILY_CHAT_APP_DATA_PATH: appDataRoot };
  const filePath = path.join(workspaceRoot, 'main.ts');
  let runtime;
  try {
    const binding = resolveEditingTimelineWorkspaceBinding({ path: workspaceRoot }, null, env);
    const timeline = createElectronEditingTimelineOwner('session-navigation', binding);
    await timeline.beginRequest({
      requestId: 'turn-1',
      turnId: 'turn-1',
      checkpointId: 'checkpoint-1',
    });
    await timeline.recordFileWrite({
      turnId: 'turn-1',
      filePath,
      existedBefore: true,
      beforeContent: 'before',
      afterContent: 'after',
    });
    await timeline.completeRequest('turn-1');
    await fs.writeFile(filePath, 'after');

    runtime = createRuntimeOwner({ env });
    const prepared = await runtime.applyEditingSessionNavigation({
      sessionId: 'session-navigation',
      projectPath: workspaceRoot,
      checkpointId: 'checkpoint-1',
      direction: 'restore',
    });
    assert.equal(await fs.readFile(filePath, 'utf8'), 'before');
    assert.equal((await runtime.readEditingSessionState({
      sessionId: 'session-navigation',
      projectPath: workspaceRoot,
    })).currentPointer.epoch, 1);

    const rolledBack = await runtime.rollbackEditingSessionNavigation({
      transactionId: prepared.transactionId,
    });
    assert.equal(rolledBack.rolledBackOnError, true);
    assert.equal(await fs.readFile(filePath, 'utf8'), 'after');
    assert.equal((await runtime.readEditingSessionState({
      sessionId: 'session-navigation',
      projectPath: workspaceRoot,
    })).currentPointer.epoch, 1);

    const preparedRestore = await runtime.applyEditingSessionNavigation({
      sessionId: 'session-navigation',
      projectPath: workspaceRoot,
      checkpointId: 'checkpoint-1',
      direction: 'restore',
    });
    const committedRestore = await runtime.commitEditingSessionNavigation({
      transactionId: preparedRestore.transactionId,
    });
    assert.equal(committedRestore.appliedFiles, 1);
    assert.equal(await fs.readFile(filePath, 'utf8'), 'before');
    assert.equal((await runtime.readEditingSessionState({
      sessionId: 'session-navigation',
      projectPath: workspaceRoot,
    })).currentPointer.epoch, 0);

    const preparedRedo = await runtime.applyEditingSessionNavigation({
      sessionId: 'session-navigation',
      projectPath: workspaceRoot,
      checkpointId: 'checkpoint-1',
      direction: 'redo',
    });
    await runtime.commitEditingSessionNavigation({ transactionId: preparedRedo.transactionId });
    assert.equal(await fs.readFile(filePath, 'utf8'), 'after');
    assert.equal((await runtime.readEditingSessionState({
      sessionId: 'session-navigation',
      projectPath: workspaceRoot,
    })).currentPointer.epoch, 1);
  } finally {
    await runtime?.dispose();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
    await fs.rm(appDataRoot, { recursive: true, force: true });
  }
});

test('worker checkpoint navigation restores the workspace when its prepared revision becomes stale', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aily-editing-navigation-stale-'));
  const appDataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aily-editing-navigation-stale-appdata-'));
  const env = { AILY_CHAT_APP_DATA_PATH: appDataRoot };
  const filePath = path.join(workspaceRoot, 'main.ts');
  let runtime;
  try {
    const binding = resolveEditingTimelineWorkspaceBinding({ path: workspaceRoot }, null, env);
    const timeline = createElectronEditingTimelineOwner('session-navigation-stale', binding);
    await timeline.beginRequest({
      requestId: 'turn-1',
      turnId: 'turn-1',
      checkpointId: 'checkpoint-1',
    });
    await timeline.recordFileWrite({
      turnId: 'turn-1',
      filePath,
      existedBefore: true,
      beforeContent: 'before',
      afterContent: 'after',
    });
    await timeline.completeRequest('turn-1');
    await fs.writeFile(filePath, 'after');

    runtime = createRuntimeOwner({ env });
    const prepared = await runtime.applyEditingSessionNavigation({
      sessionId: 'session-navigation-stale',
      projectPath: workspaceRoot,
      checkpointId: 'checkpoint-1',
      direction: 'restore',
    });
    await timeline.beginRequest({
      requestId: 'turn-2',
      turnId: 'turn-2',
      checkpointId: 'checkpoint-2',
    });

    await assert.rejects(
      runtime.commitEditingSessionNavigation({ transactionId: prepared.transactionId }),
      /navigation revision mismatch/,
    );
    assert.equal(await fs.readFile(filePath, 'utf8'), 'after');
    const rollback = await runtime.rollbackEditingSessionNavigation({
      transactionId: prepared.transactionId,
    });
    assert.equal(rollback.rolledBackOnError, true);
  } finally {
    await runtime?.dispose();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
    await fs.rm(appDataRoot, { recursive: true, force: true });
  }
});

test('worker checkpoint navigation rolls back earlier files when a later file cannot be applied', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aily-editing-navigation-apply-failure-'));
  const appDataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aily-editing-navigation-apply-failure-appdata-'));
  const env = { AILY_CHAT_APP_DATA_PATH: appDataRoot };
  const firstPath = path.join(workspaceRoot, 'a-first.txt');
  const blockedPath = path.join(workspaceRoot, 'z-blocked.txt');
  let runtime;
  try {
    const binding = resolveEditingTimelineWorkspaceBinding({ path: workspaceRoot }, null, env);
    const timeline = createElectronEditingTimelineOwner('session-navigation-apply-failure', binding);
    await timeline.beginRequest({
      requestId: 'turn-1',
      turnId: 'turn-1',
      checkpointId: 'checkpoint-1',
    });
    await timeline.recordMutationBatch({
      sessionId: 'session-navigation-apply-failure',
      turnId: 'turn-1',
      toolCallId: 'tool-1',
      transactionId: 'transaction-1',
      status: 'committed',
      receipts: [
        {
          sessionId: 'session-navigation-apply-failure',
          turnId: 'turn-1',
          toolCallId: 'tool-1',
          transactionId: 'transaction-1',
          operationId: 'transaction-1:0',
          sequence: 0,
          operationKind: 'replace',
          filePath: firstPath,
          existedBefore: true,
          contentKind: 'text',
          beforeContent: 'first before',
          afterContent: 'first after',
        },
        {
          sessionId: 'session-navigation-apply-failure',
          turnId: 'turn-1',
          toolCallId: 'tool-1',
          transactionId: 'transaction-1',
          operationId: 'transaction-1:1',
          sequence: 1,
          operationKind: 'replace',
          filePath: blockedPath,
          existedBefore: true,
          contentKind: 'text',
          beforeContent: 'blocked before',
          afterContent: 'blocked after',
        },
      ],
    });
    await timeline.completeRequest('turn-1');
    await fs.writeFile(firstPath, 'first after');
    await fs.mkdir(blockedPath);

    runtime = createRuntimeOwner({ env });
    await assert.rejects(
      runtime.applyEditingSessionNavigation({
        sessionId: 'session-navigation-apply-failure',
        projectPath: workspaceRoot,
        checkpointId: 'checkpoint-1',
        direction: 'restore',
      }),
      /not a regular file/,
    );

    assert.equal(await fs.readFile(firstPath, 'utf8'), 'first after');
    assert.equal((await fs.lstat(blockedPath)).isDirectory(), true);
    assert.equal((await runtime.readEditingSessionState({
      sessionId: 'session-navigation-apply-failure',
      projectPath: workspaceRoot,
    })).currentPointer.epoch, 2);
  } finally {
    await runtime?.dispose();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
    await fs.rm(appDataRoot, { recursive: true, force: true });
  }
});

test('editing timeline workspace storage isolates global and project snapshots for the same session id', async () => {
  const appDataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aily-editing-scope-isolation-'));
  const projectRoot = path.join(appDataRoot, 'projects');
  const projectPath = path.join(projectRoot, 'demo');
  const env = { AILY_CHAT_APP_DATA_PATH: appDataRoot };
  try {
    const globalBinding = resolveEditingTimelineWorkspaceBinding(
      { path: projectRoot, rootPath: projectRoot },
      null,
      env,
    );
    const projectBinding = resolveEditingTimelineWorkspaceBinding(
      { path: projectPath, rootPath: projectRoot },
      null,
      env,
    );
    const globalTimeline = createElectronEditingTimelineOwner('session-shared-id', globalBinding);
    const projectTimeline = createElectronEditingTimelineOwner('session-shared-id', projectBinding);

    await globalTimeline.recordFileWrite({
      turnId: 'turn-global',
      filePath: path.join(projectRoot, 'global-note.txt'),
      existedBefore: false,
      beforeContent: null,
      afterContent: 'global only',
    });

    assert.equal(globalBinding.workspaceIdentity, 'global-chat');
    assert.match(projectBinding.workspaceIdentity, /^project:[a-f0-9]{64}$/);
    assert.notEqual(globalBinding.workspaceStorageRoot, projectBinding.workspaceStorageRoot);
    assert.equal((await globalTimeline.getState()).operations.length, 1);
    assert.equal((await projectTimeline.getState()).operations.length, 0);
  } finally {
    await fs.rm(appDataRoot, { recursive: true, force: true });
  }
});

test('project adoption rebinds the active timeline without replacing the conversation owner', async () => {
  const appDataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aily-editing-adoption-'));
  const projectRoot = path.join(appDataRoot, 'projects');
  const projectPath = path.join(projectRoot, 'demo');
  const env = { AILY_CHAT_APP_DATA_PATH: appDataRoot };
  let runtime;
  try {
    runtime = createRuntimeOwner({ env });
    const globalBinding = resolveEditingTimelineWorkspaceBinding(
      { path: projectRoot, rootPath: projectRoot },
      null,
      env,
    );
    const timeline = createElectronEditingTimelineOwner('session-adopt', globalBinding);
    await timeline.recordFileWrite({
      turnId: 'turn-1',
      filePath: path.join(projectPath, 'project.abs'),
      existedBefore: false,
      beforeContent: null,
      afterContent: 'created',
    });
    const session = {
      sessionId: 'session-adopt',
      revision: 0,
      activeTurnId: 'turn-1',
      providerOptions: null,
      editingTimeline: timeline,
    };
    const globalSessionDir = path.join(
      globalBinding.workspaceStorageRoot,
      'chatEditingSessions',
      'session-adopt',
    );
    const targetBinding = resolveEditingTimelineWorkspaceBinding(
      { path: projectPath },
      { folderPath: projectPath },
      env,
    );
    const projectSessionDir = path.join(
      targetBinding.workspaceStorageRoot,
      'chatEditingSessions',
      'session-adopt',
    );
    assert.equal((await fs.stat(globalSessionDir)).isDirectory(), true);

    await runtime.applyProjectCreatedScope(session, { path: projectPath });

    const state = await timeline.getState();
    assert.match(state.workspaceIdentity, /^project:[a-f0-9]{64}$/);
    assert.equal(state.workspaceRoot, projectPath);
    assert.equal(state.operations.length, 1);
    assert.equal(
      Buffer.from(await timeline.readContent(state.operations[0].afterRef)).toString('utf8'),
      'created',
    );
    assert.equal(session.editingTimeline, timeline);
    assert.equal(session.activeTurnId, 'turn-1');
    assert.equal(session.cwd, projectPath);
    assert.equal((await fs.stat(projectSessionDir)).isDirectory(), true);
    await assert.rejects(fs.stat(globalSessionDir), error => error?.code === 'ENOENT');
  } finally {
    await runtime?.dispose();
    await fs.rm(appDataRoot, { recursive: true, force: true });
  }
});

test('worker forks the retained Lex request prefix and canonical editing timeline before target runtime creation', async () => {
  const appDataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aily-editing-fork-'));
  const projectPath = path.join(appDataRoot, 'project');
  const env = { AILY_CHAT_APP_DATA_PATH: appDataRoot };
  let runtime;
  try {
    const binding = resolveEditingTimelineWorkspaceBinding({ path: projectPath }, null, env);
    const sourceTimeline = createElectronEditingTimelineOwner('session-source', binding);
    await sourceTimeline.beginRequest({
      requestId: 'turn-1',
      turnId: 'turn-1',
      checkpointId: 'checkpoint-1',
    });
    await sourceTimeline.recordFileWrite({
      requestId: 'turn-1',
      filePath: path.join(projectPath, 'main.ts'),
      existedBefore: true,
      beforeContent: 'before',
      afterContent: 'first',
    });
    await sourceTimeline.completeRequest('turn-1');
    await sourceTimeline.beginRequest({
      requestId: 'turn-2',
      turnId: 'turn-2',
      checkpointId: 'checkpoint-2',
    });
    await sourceTimeline.recordFileWrite({
      requestId: 'turn-2',
      filePath: path.join(projectPath, 'main.ts'),
      existedBefore: true,
      beforeContent: 'first',
      afterContent: 'second',
    });
    await sourceTimeline.completeRequest('turn-2');

    runtime = createRuntimeOwner({ env });
    runtime.readProjectInfo = async () => ({ path: projectPath });
    const mediaRef = `aily-media:v1:${'c'.repeat(64)}`;
    const retainedImageTurn = {
      ...createTurn('turn-1', 'first', 'first result'),
      request: {
        content: 'first',
        attachments: [{
          id: 'fork-image',
          type: 'image',
          name: 'fork.png',
          uri: mediaRef,
          mimeType: 'image/png',
          content: 'aGVsbG8=',
        }],
      },
    };
    runtime.sessions.set('session-source', {
      sessionId: 'session-source',
      providerOptions: null,
      currentModel: null,
      activeTurnPromise: null,
      activeAbortController: null,
      handlePromise: Promise.resolve(),
      handle: {
        getSessionSnapshot: () => createSnapshot('session-source', [
          retainedImageTurn,
          createTurn('turn-2', 'second', 'second result'),
        ]),
      },
      editingTimeline: sourceTimeline,
      timelineWorkspace: binding,
    });
    let targetStateBeforeRuntime = null;
    let targetSnapshotBeforeRuntime = null;
    runtime.ensureSession = async (targetSessionId, command) => {
      targetStateBeforeRuntime = await createElectronEditingTimelineOwner(
        targetSessionId,
        binding,
      ).getState();
      targetSnapshotBeforeRuntime = command.initialSnapshot;
      return { handle: {} };
    };

    const result = await runtime.forkSession({
      sourceSessionId: 'session-source',
      targetSessionId: 'session-fork',
      beforeTurnId: 'turn-2',
      retainedTurnIds: ['turn-1'],
    });

    assert.equal(result.ensured, true);
    assert.equal(result.editingTimelineRevision, 1);
    assert.deepEqual(
      targetStateBeforeRuntime.requestScopes.map(scope => scope.requestId),
      ['turn-1'],
    );
    assert.deepEqual(
      targetStateBeforeRuntime.operations.map(operation => operation.requestId),
      ['turn-1'],
    );
    assert.deepEqual(
      (await sourceTimeline.getState()).requestScopes.map(scope => scope.requestId),
      ['turn-1', 'turn-2'],
    );
    assert.deepEqual(
      targetSnapshotBeforeRuntime.turns[0].request.attachments[0],
      retainedImageTurn.request.attachments[0],
    );
    assert.equal(targetSnapshotBeforeRuntime.turns.length, 1);
  } finally {
    await runtime?.dispose();
    await fs.rm(appDataRoot, { recursive: true, force: true });
  }
});

test('session deletion clears canonical timeline storage even when the runtime is not resident', async () => {
  const appDataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aily-editing-delete-'));
  const projectPath = path.join(appDataRoot, 'project');
  const env = { AILY_CHAT_APP_DATA_PATH: appDataRoot };
  let runtime;
  try {
    const binding = resolveEditingTimelineWorkspaceBinding({ path: projectPath }, null, env);
    const timeline = createElectronEditingTimelineOwner('session-delete', binding);
    await timeline.recordFileWrite({
      turnId: 'turn-1',
      filePath: path.join(projectPath, 'main.ts'),
      existedBefore: false,
      beforeContent: null,
      afterContent: 'created',
    });
    const sessionDir = path.join(
      binding.workspaceStorageRoot,
      'chatEditingSessions',
      'session-delete',
    );
    assert.equal((await fs.stat(sessionDir)).isDirectory(), true);

    runtime = createRuntimeOwner({ env });
    await runtime.disposeSessionResources({
      sessionId: 'session-delete',
      deleteStorage: true,
      projectPath,
    });

    await assert.rejects(fs.stat(sessionDir), error => error?.code === 'ENOENT');
  } finally {
    await runtime?.dispose();
    await fs.rm(appDataRoot, { recursive: true, force: true });
  }
});

test('session deletion waits for the aborted turn before clearing editing-session storage', async () => {
  const runtime = createRuntimeOwner();
  const abortController = new AbortController();
  let settleTurn;
  const activeTurnPromise = new Promise(resolve => {
    settleTurn = resolve;
  });
  const events = [];
  runtime.sessions.set('session-delete-running', {
    sessionId: 'session-delete-running',
    activeTurnId: 'turn-1',
    activeAbortController: abortController,
    activeTurnPromise,
    editingTimeline: {
      finishRequest: async (...args) => events.push(['finish', ...args]),
      clearState: async () => events.push(['clear']),
    },
    handle: {
      dispose: () => events.push(['dispose']),
    },
  });

  const deleting = runtime.disposeSessionResources({
    sessionId: 'session-delete-running',
    deleteStorage: true,
  });
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(abortController.signal.aborted, true);
  assert.deepEqual(events, []);

  settleTurn();
  await deleting;

  assert.deepEqual(events, [
    ['finish', 'turn-1', 'disposed'],
    ['dispose'],
    ['clear'],
  ]);
  assert.equal(runtime.sessions.has('session-delete-running'), false);
});

test('worker commits a resource mutation batch through the canonical active-turn owner', async () => {
  const owner = createRuntimeOwner();
  const committed = [];
  owner.sessions.set('session-worker', {
    sessionId: 'session-worker',
    activeTurnId: 'turn-1',
    editingTimeline: {
      recordMutationBatch: async batch => committed.push(batch),
    },
  });
  const batch = {
    sessionId: 'session-worker',
    turnId: 'turn-1',
    toolCallId: 'tool-1',
    transactionId: 'transaction-1',
    status: 'committed',
    receipts: [],
  };

  await owner.commitResourceMutationBatch({
    sessionId: 'session-worker',
    turnId: 'turn-1',
    toolCallId: 'tool-1',
  }, { result: { mutationBatch: batch } });

  assert.deepEqual(committed, [batch]);
  await assert.rejects(
    owner.commitResourceMutationBatch({
      sessionId: 'session-worker',
      turnId: 'turn-2',
      toolCallId: 'tool-2',
    }, { result: { mutationBatch: { ...batch, turnId: 'turn-2', toolCallId: 'tool-2' } } }),
    /outside the canonical active turn/,
  );
  assert.deepEqual(committed, [batch]);
});

test('worker finalizes a prepared workspace mutation only after the canonical timeline commits', async () => {
  const requests = [];
  const committed = [];
  const batch = {
    sessionId: 'session-prepared',
    turnId: 'turn-prepared',
    toolCallId: 'tool-prepared',
    transactionId: 'transaction-prepared',
    status: 'prepared',
    receipts: [],
  };
  const owner = createRuntimeOwner({
    requestResourceOperation: async request => {
      requests.push(request);
      if (request.payload?.adapter === 'workspaceMutation') {
        return { result: { status: 'committed', transactionId: batch.transactionId } };
      }
      return { result: { mutationBatch: batch } };
    },
  });
  owner.sessions.set(batch.sessionId, {
    sessionId: batch.sessionId,
    activeTurnId: batch.turnId,
    editingTimeline: {
      recordMutationBatch: async value => committed.push(value),
    },
  });

  await owner.requestResourceOperation({
    sessionId: batch.sessionId,
    turnId: batch.turnId,
    toolCallId: batch.toolCallId,
    kind: 'workspace-mutation',
    payload: { adapter: 'syncAbs', args: { operation: 'import' } },
  });

  assert.deepEqual(committed, [{ ...batch, status: 'committed' }]);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].payload, {
    adapter: 'workspaceMutation',
    action: 'commit',
    transactionId: batch.transactionId,
  });
});

test('worker rolls a prepared workspace mutation back when canonical timeline persistence fails', async () => {
  const requests = [];
  const batch = {
    sessionId: 'session-prepared-failure',
    turnId: 'turn-prepared-failure',
    toolCallId: 'tool-prepared-failure',
    transactionId: 'transaction-prepared-failure',
    status: 'prepared',
    receipts: [],
  };
  const owner = createRuntimeOwner({
    requestResourceOperation: async request => {
      requests.push(request);
      if (request.payload?.adapter === 'workspaceMutation') {
        return { result: { status: 'rolled-back', transactionId: batch.transactionId } };
      }
      return { result: { mutationBatch: batch } };
    },
  });
  owner.sessions.set(batch.sessionId, {
    sessionId: batch.sessionId,
    activeTurnId: batch.turnId,
    editingTimeline: {
      recordMutationBatch: async () => {
        throw new Error('timeline persistence failed');
      },
    },
  });

  await assert.rejects(
    owner.requestResourceOperation({
      sessionId: batch.sessionId,
      turnId: batch.turnId,
      toolCallId: batch.toolCallId,
      kind: 'workspace-mutation',
      payload: { adapter: 'syncAbs', args: { operation: 'import' } },
    }),
    error => {
      assert.match(error.message, /timeline persistence failed/);
      assert.equal(error.rolledBackOnError, true);
      assert.deepEqual(error.rollbackErrors, []);
      return true;
    },
  );
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].payload, {
    adapter: 'workspaceMutation',
    action: 'rollback',
    transactionId: batch.transactionId,
  });
});

test('worker save_arch records the exact managed write before returning artifact metadata', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aily-save-arch-'));
  const writes = [];
  const indexed = [];
  try {
    const result = await invokeElectronSaveArchTool({ code: 'flowchart TD\nA-->B' }, {
      project: {
        getProjectInfo: async () => ({ currentProjectPath: workspaceRoot }),
      },
      fs: {
        writeFile: (filePath, content, encoding) => fs.writeFile(filePath, content, encoding),
      },
      chronicle: {
        indexWorkspaceArtifact: async artifact => indexed.push(artifact),
      },
    }, {
      trace: { turnId: 'turn-arch' },
      toolCallId: 'tool-arch',
      host: {
        getExtension: id => id === 'editingTimeline'
          ? { recordFileWrite: async event => writes.push(event) }
          : undefined,
      },
    });

    const archPath = path.join(workspaceRoot, 'arch.md');
    const content = '```mermaid\nflowchart TD\nA-->B\n```\n';
    assert.equal(await fs.readFile(archPath, 'utf8'), content);
    assert.deepEqual(writes, [{
      turnId: 'turn-arch',
      toolCallId: 'tool-arch',
      mutationId: 'save-arch:turn-arch:tool-arch',
      filePath: archPath,
      existedBefore: false,
      beforeContent: null,
      afterContent: content,
    }]);
    assert.equal(indexed.length, 1);
    assert.equal(result.metadata.filePath, archPath);
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('worker save_arch restores the prior file when timeline recording fails', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aily-save-arch-rollback-'));
  const archPath = path.join(workspaceRoot, 'arch.md');
  await fs.writeFile(archPath, 'original', 'utf8');
  try {
    await assert.rejects(
      invokeElectronSaveArchTool({ code: 'flowchart LR\nA-->B' }, {
        project: {
          getProjectInfo: async () => ({ currentProjectPath: workspaceRoot }),
        },
        fs: {
          writeFile: (filePath, content, encoding) => fs.writeFile(filePath, content, encoding),
        },
      }, {
        trace: { turnId: 'turn-arch' },
        toolCallId: 'tool-arch',
        host: {
          getExtension: id => id === 'editingTimeline'
            ? { recordFileWrite: async () => { throw new Error('timeline unavailable'); } }
            : undefined,
        },
      }),
      /timeline unavailable/,
    );
    assert.equal(await fs.readFile(archPath, 'utf8'), 'original');
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});
