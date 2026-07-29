import type { IToolContribution, ToolResultContent } from 'aily-lex/browser';

import type { InvokeHandler } from './blockly-contributed-tool-runtime';

export const GET_PROJECT_SCENE_REGENERATION_CONTEXT_TOOL =
  'get_project_scene_regeneration_context';
export const COMMIT_PROJECT_SCENE_REGENERATION_TOOL =
  'commit_project_scene_regeneration';

const SHA_256_PATTERN = /^[a-f0-9]{64}$/u;
const PORTABLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;
const COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/u;
const SIGNAL_KINDS = new Set([
  'ground',
  'power',
  'gpio',
  'analog',
  'pwm',
  'i2c',
  'spi',
  'uart',
]);
const MAX_COMMANDS = 64;
const MAX_SUMMARY_LENGTH = 512;

export interface ProjectSceneRegenerationRequirement {
  readonly schemaVersion: 1;
  readonly kind: 'aily-project-scene-legacy-regeneration-required';
  readonly regenerationId: string;
  readonly projectIdentity: string;
  readonly sceneId: string;
  readonly legacySourceKind: 'connection-output-v1';
  readonly legacySourceRevision: string;
  readonly legacySourceBytes: number;
  readonly catalogRevision: string;
  readonly draftVisualRevision: string;
  readonly draftGraphSemanticRevision: string;
  readonly expiresAtUnixMs: number;
}

export interface ProjectSceneRegenerationBridge {
  status(): Promise<unknown>;
  resolveProjectSceneRegeneration(options: {
    readonly regenerationId: string;
    readonly resolution: 'commit';
    readonly proposal: Record<string, unknown>;
  }): Promise<unknown>;
}

interface ProjectSceneToolInvocationContext {
  readonly toolCallId?: string;
  readonly trace?: { readonly turnId?: string };
}

interface RegenerationComponentInput {
  readonly instanceId: string;
  readonly package: {
    readonly id: string;
    readonly version: string;
  };
  readonly placement: {
    readonly x: number;
    readonly y: number;
  };
}

interface RegenerationEndpointInput {
  readonly instanceId: string;
  readonly pinId: string;
  readonly function: string;
}

interface RegenerationConnectionInput {
  readonly segmentId: string;
  readonly from: RegenerationEndpointInput;
  readonly to: RegenerationEndpointInput;
  readonly signalKind: string;
  readonly label?: string;
  readonly color?: string;
}

interface CommitProjectSceneRegenerationInput {
  readonly regenerationId: string;
  readonly summary: string;
  readonly components: readonly RegenerationComponentInput[];
  readonly connections: readonly RegenerationConnectionInput[];
}

const COMPONENT_PACKAGE_GUIDE = Object.freeze([
  Object.freeze({
    id: 'aily.component-package.xiao-esp32s3',
    version: '1.0.0',
    instanceIdPrefix: 'xiao_esp32s3_',
    maxInstances: 1,
    pins: Object.freeze([
      'pin_1:D0/A0/GPIO1/TOUCH1',
      'pin_2:D1/A1/GPIO2/TOUCH2',
      'pin_3:D2/A2/GPIO3/TOUCH3',
      'pin_4:D3/A3/GPIO4/TOUCH4',
      'pin_5:D4/A4/SDA/GPIO5/TOUCH5',
      'pin_6:D5/A5/SCL/GPIO6/TOUCH6',
      'pin_7:D6/TX/GPIO43',
      'pin_8:5V',
      'pin_9:GND',
      'pin_10:3V3',
      'pin_11:D10/A10/MOSI/GPIO9/TOUCH9',
      'pin_12:D9/A9/MISO/GPIO8/TOUCH8',
      'pin_13:D8/A8/SCK/GPIO7/TOUCH7',
      'pin_14:D7/RX/GPIO44',
    ]),
  }),
  Object.freeze({
    id: 'aily.component-package.gpio-led',
    version: '1.0.0',
    instanceIdPrefix: 'led_',
    pins: Object.freeze(['anode:A(IO)/A(3V3)', 'cathode:C(IO)/C(GND)']),
  }),
  Object.freeze({
    id: 'aily.component-package.gpio-button',
    version: '1.0.0',
    instanceIdPrefix: 'button_',
    pins: Object.freeze([
      'terminal_a:A(IO)/A(3V3)/A(GND)',
      'terminal_b:B(IO)/B(3V3)/B(GND)',
    ]),
  }),
  Object.freeze({
    id: 'aily.component-package.resistor',
    version: '1.0.0',
    instanceIdPrefix: 'resistor_',
    pins: Object.freeze([
      'terminal_a:A(IO)/A(3V3)/A(GND)',
      'terminal_b:B(IO)/B(3V3)/B(GND)',
    ]),
  }),
]);

function result(value: unknown): ToolResultContent {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
  };
}

function error(message: string): ToolResultContent {
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true,
  };
}

function readProjectSceneBridge(): ProjectSceneRegenerationBridge | null {
  if (typeof window === 'undefined') return null;
  const api = (window as any).electronAPI?.simulatorSubapp;
  return typeof api?.status === 'function'
    && typeof api?.resolveProjectSceneRegeneration === 'function'
    ? api as ProjectSceneRegenerationBridge
    : null;
}

export function appendProjectSceneRegenerationContributions(
  contributions: IToolContribution[],
): void {
  contributions.push(
    {
      name: GET_PROJECT_SCENE_REGENERATION_CONTEXT_TOOL,
      toolSet: 'blockly-project-scene',
      description: 'Read the bounded pending v2 Project Scene regeneration requirement and Component Package guide.',
      prompt: `Use this read-only tool only when the simulator reports that a legacy connection_output.json must be regenerated as a v2 Project Scene.
It returns the pending requirement, exact revision baseline, and a bounded Component Package/pin guide. It never returns a host path, legacy JSON body, Scene body, capability token, iframe URL, or runtime process handle.
After inspecting current Blockly/project context, call ${COMMIT_PROJECT_SCENE_REGENERATION_TOOL} with only the components and point-to-point connections needed for a fresh Scene.`,
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      annotations: { readOnly: true, idempotent: true },
      runtimeModes: ['blockly'],
      requiredCapabilities: ['runtime:blockly'],
      agentScope: ['main', 'SchematicAgent'],
    },
    {
      name: COMMIT_PROJECT_SCENE_REGENERATION_TOOL,
      toolSet: 'blockly-project-scene',
      description: 'Submit a bounded Component Package proposal and atomically commit a fresh v2 Project Scene after user approval.',
      prompt: `Use this only after ${GET_PROJECT_SCENE_REGENERATION_CONTEXT_TOOL} returns a live pending requirement and you have inferred the circuit from current Blockly/project context.
This is a destructive, user-confirmed operation. The host—not the model—fills projectIdentity, sceneId, revision baseline, reason, proposalId, and agentRunId. The tool cannot replace a Scene document or write connection_output.json.
components declares exact Component Package instances in the new empty Scene. connections creates point-to-point segments between declared component pins. The endpoint function must be one function advertised for that pin (for example GPIO1, A(IO), C(GND), 3V3, or GND). signalKind must be ground, power, gpio, analog, pwm, i2c, spi, or uart.
Use stable unique portable IDs that follow each Component Package instanceIdPrefix. Include the XIAO board and every required physical component. LED and button each have two electrical terminals; model pull-up/pull-down or LED current limiting with explicit resistor components when required.`,
      inputSchema: {
        type: 'object',
        properties: {
          regenerationId: {
            type: 'string',
            description: `The exact regenerationId returned by ${GET_PROJECT_SCENE_REGENERATION_CONTEXT_TOOL}.`,
          },
          summary: {
            type: 'string',
            description: 'Concise user-facing description of the proposed components and wiring.',
            minLength: 1,
            maxLength: MAX_SUMMARY_LENGTH,
          },
          components: {
            type: 'array',
            minItems: 1,
            maxItems: MAX_COMMANDS,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                instanceId: { type: 'string' },
                package: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    id: { type: 'string' },
                    version: { type: 'string' },
                  },
                  required: ['id', 'version'],
                },
                placement: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    x: { type: 'number' },
                    y: { type: 'number' },
                  },
                  required: ['x', 'y'],
                },
              },
              required: ['instanceId', 'package', 'placement'],
            },
          },
          connections: {
            type: 'array',
            maxItems: MAX_COMMANDS,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                segmentId: { type: 'string' },
                from: { $ref: '#/$defs/endpoint' },
                to: { $ref: '#/$defs/endpoint' },
                signalKind: {
                  type: 'string',
                  enum: [...SIGNAL_KINDS],
                },
                label: { type: 'string', maxLength: 128 },
                color: { type: 'string', pattern: '^#[0-9A-Fa-f]{6}$' },
              },
              required: ['segmentId', 'from', 'to', 'signalKind'],
            },
          },
        },
        $defs: {
          endpoint: {
            type: 'object',
            additionalProperties: false,
            properties: {
              instanceId: { type: 'string' },
              pinId: { type: 'string' },
              function: { type: 'string' },
            },
            required: ['instanceId', 'pinId', 'function'],
          },
        },
        required: ['regenerationId', 'summary', 'components', 'connections'],
        additionalProperties: false,
      },
      annotations: {
        readOnly: false,
        destructive: true,
        idempotent: true,
      },
      runtimeModes: ['blockly'],
      requiredCapabilities: ['runtime:blockly'],
      agentScope: ['main', 'SchematicAgent'],
    },
  );
}

export function createProjectSceneRegenerationHandlers(
  bridgeFactory: () => ProjectSceneRegenerationBridge | null = readProjectSceneBridge,
): Record<string, InvokeHandler> {
  return {
    [GET_PROJECT_SCENE_REGENERATION_CONTEXT_TOOL]: async () => {
      const bridge = bridgeFactory();
      if (!bridge) return error('独立仿真服务的 Project Scene 接口不可用。');
      const requirement = await readPendingRequirement(bridge);
      return result({
        schemaVersion: 1,
        kind: 'aily-project-scene-agent-regeneration-context',
        state: 'legacy-scene-regeneration-required',
        requirement,
        componentPackages: COMPONENT_PACKAGE_GUIDE,
        constraints: {
          sceneStartsEmpty: true,
          maxCommands: MAX_COMMANDS,
          authority: 'electron-main-project-scene',
          forbiddenInputs: [
            'host-path',
            'legacy-json-body',
            'scene-document',
            'capability-token',
            'runtime-process-handle',
          ],
        },
      });
    },
    [COMMIT_PROJECT_SCENE_REGENERATION_TOOL]: async (
      input,
      _hostAPI,
      invocationContext,
    ) => {
      const bridge = bridgeFactory();
      if (!bridge) return error('独立仿真服务的 Project Scene 接口不可用。');
      const requirement = await readPendingRequirement(bridge);
      const normalized = validateCommitInput(input);
      if (normalized.regenerationId !== requirement.regenerationId) {
        return error('regenerationId 与当前 pending requirement 不一致，请重新读取上下文。');
      }
      if (requirement.expiresAtUnixMs <= Date.now()) {
        return error('Project Scene regeneration requirement 已过期，请重新打开仿真器。');
      }
      const proposal = buildRegenerationProposal(
        requirement,
        normalized,
        invocationContext,
      );
      const response = await bridge.resolveProjectSceneRegeneration({
        regenerationId: requirement.regenerationId,
        resolution: 'commit',
        proposal,
      });
      const receipt = validateCommitResponse(response);
      return result({
        schemaVersion: 1,
        kind: 'aily-project-scene-agent-regeneration-commit-result',
        state: 'committed',
        regenerationId: requirement.regenerationId,
        proposalId: proposal['proposalId'],
        initialization: receipt.initialization,
        tool: receipt.tool,
      });
    },
  };
}

export function buildRegenerationProposal(
  requirement: ProjectSceneRegenerationRequirement,
  input: CommitProjectSceneRegenerationInput,
  invocationContext?: ProjectSceneToolInvocationContext,
): Record<string, unknown> {
  const proposalId = createPortableRuntimeId(
    'scene-proposal',
    invocationContext?.toolCallId,
    requirement.regenerationId,
  );
  const agentRunId = createPortableRuntimeId(
    'scene-agent-run',
    invocationContext?.trace?.turnId,
    invocationContext?.toolCallId ?? requirement.regenerationId,
  );
  return {
    schemaVersion: 1,
    kind: 'aily-agent-scene-change-proposal',
    proposalId,
    agentRunId,
    reason: 'legacy-regeneration',
    summary: input.summary,
    target: {
      projectIdentity: requirement.projectIdentity,
      sceneId: requirement.sceneId,
    },
    base: {
      visualRevision: requirement.draftVisualRevision,
      graphSemanticRevision: requirement.draftGraphSemanticRevision,
      catalogRevision: requirement.catalogRevision,
    },
    componentMutations: input.components.map((component) => ({
      type: 'instantiate-component',
      instanceId: component.instanceId,
      package: { ...component.package },
      placement: { ...component.placement },
    })),
    batch: input.connections.length === 0
      ? null
      : {
          schemaVersion: 1,
          kind: 'aily-scene-editor-network-command-batch',
          commands: input.connections.map((connection) => ({
            type: 'create-segment',
            segmentId: connection.segmentId,
            from: {
              kind: 'component-terminal',
              ...connection.from,
              extensions: {},
            },
            to: {
              kind: 'component-terminal',
              ...connection.to,
              extensions: {},
            },
            signalKind: connection.signalKind,
            presentation: {
              label: connection.label ?? '',
              color: connection.color ?? defaultSignalColor(connection.signalKind),
              vertices: [],
            },
            extensions: {},
          })),
        },
  };
}

async function readPendingRequirement(
  bridge: ProjectSceneRegenerationBridge,
): Promise<ProjectSceneRegenerationRequirement> {
  const status = requireRecord(await bridge.status(), 'simulator status');
  if (status['state'] !== 'legacy-scene-regeneration-required') {
    throw new Error('当前没有待处理的 legacy Project Scene regeneration requirement。');
  }
  return validateRequirement(status['requirement']);
}

function validateRequirement(value: unknown): ProjectSceneRegenerationRequirement {
  const requirement = requireRecord(value, 'regeneration requirement');
  requireExactKeys(requirement, [
    'schemaVersion',
    'kind',
    'regenerationId',
    'projectIdentity',
    'sceneId',
    'legacySourceKind',
    'legacySourceRevision',
    'legacySourceBytes',
    'catalogRevision',
    'draftVisualRevision',
    'draftGraphSemanticRevision',
    'expiresAtUnixMs',
  ], 'regeneration requirement');
  if (
    requirement['schemaVersion'] !== 1
    || requirement['kind'] !== 'aily-project-scene-legacy-regeneration-required'
    || requirement['legacySourceKind'] !== 'connection-output-v1'
  ) {
    throw new Error('Project Scene regeneration requirement schema 不受支持。');
  }
  requirePortableId(requirement['regenerationId'], 'regenerationId');
  requireText(requirement['projectIdentity'], 512, 'projectIdentity');
  requirePortableId(requirement['sceneId'], 'sceneId');
  for (const key of [
    'legacySourceRevision',
    'catalogRevision',
    'draftVisualRevision',
    'draftGraphSemanticRevision',
  ]) requireSha256(requirement[key], key);
  if (!Number.isSafeInteger(requirement['legacySourceBytes']) || Number(requirement['legacySourceBytes']) < 0) {
    throw new Error('legacySourceBytes 无效。');
  }
  if (!Number.isSafeInteger(requirement['expiresAtUnixMs']) || Number(requirement['expiresAtUnixMs']) <= 0) {
    throw new Error('expiresAtUnixMs 无效。');
  }
  return requirement as unknown as ProjectSceneRegenerationRequirement;
}

function validateCommitInput(value: unknown): CommitProjectSceneRegenerationInput {
  const input = requireRecord(value, 'commit input');
  requireExactKeys(input, [
    'regenerationId',
    'summary',
    'components',
    'connections',
  ], 'commit input');
  const regenerationId = requirePortableId(input['regenerationId'], 'regenerationId');
  const summary = requireText(input['summary'], MAX_SUMMARY_LENGTH, 'summary');
  if (!Array.isArray(input['components']) || !Array.isArray(input['connections'])) {
    throw new Error('components 与 connections 必须是数组。');
  }
  if (input['components'].length < 1) {
    throw new Error('新的 Project Scene 至少需要一个 Component Package。');
  }
  if (input['components'].length + input['connections'].length > MAX_COMMANDS) {
    throw new Error(`proposal 最多允许 ${MAX_COMMANDS} 个组件/连线命令。`);
  }

  const instanceIds = new Set<string>();
  const components = input['components'].map((entry, index) => {
    const component = requireRecord(entry, `components[${index}]`);
    requireExactKeys(component, ['instanceId', 'package', 'placement'], `components[${index}]`);
    const instanceId = requirePortableId(component['instanceId'], `components[${index}].instanceId`);
    if (instanceIds.has(instanceId)) throw new Error(`组件 instanceId 重复：${instanceId}`);
    instanceIds.add(instanceId);
    const packageReference = requireRecord(component['package'], `components[${index}].package`);
    requireExactKeys(packageReference, ['id', 'version'], `components[${index}].package`);
    const packageId = requirePortableId(packageReference['id'], `components[${index}].package.id`);
    const version = requireText(packageReference['version'], 64, `components[${index}].package.version`);
    if (!SEMVER_PATTERN.test(version)) throw new Error(`Component Package version 无效：${version}`);
    const placement = requireRecord(component['placement'], `components[${index}].placement`);
    requireExactKeys(placement, ['x', 'y'], `components[${index}].placement`);
    return {
      instanceId,
      package: { id: packageId, version },
      placement: {
        x: requireCoordinate(placement['x'], `components[${index}].placement.x`),
        y: requireCoordinate(placement['y'], `components[${index}].placement.y`),
      },
    };
  });

  const segmentIds = new Set<string>();
  const connections = input['connections'].map((entry, index) => {
    const connection = requireRecord(entry, `connections[${index}]`);
    requireAllowedKeys(connection, [
      'segmentId',
      'from',
      'to',
      'signalKind',
      'label',
      'color',
    ], `connections[${index}]`);
    for (const key of ['segmentId', 'from', 'to', 'signalKind']) {
      if (!(key in connection)) throw new Error(`connections[${index}].${key} 缺失。`);
    }
    const segmentId = requirePortableId(connection['segmentId'], `connections[${index}].segmentId`);
    if (segmentIds.has(segmentId)) throw new Error(`连线 segmentId 重复：${segmentId}`);
    segmentIds.add(segmentId);
    const from = validateEndpoint(connection['from'], `connections[${index}].from`, instanceIds);
    const to = validateEndpoint(connection['to'], `connections[${index}].to`, instanceIds);
    if (from.instanceId === to.instanceId && from.pinId === to.pinId) {
      throw new Error(`connections[${index}] 不能把同一引脚连接到自身。`);
    }
    const signalKind = requireText(connection['signalKind'], 16, `connections[${index}].signalKind`);
    if (!SIGNAL_KINDS.has(signalKind)) throw new Error(`signalKind 不受支持：${signalKind}`);
    const label = connection['label'] === undefined
      ? undefined
      : requireOptionalText(connection['label'], 128, `connections[${index}].label`);
    const color = connection['color'] === undefined
      ? undefined
      : requireText(connection['color'], 7, `connections[${index}].color`);
    if (color !== undefined && !COLOR_PATTERN.test(color)) {
      throw new Error(`connections[${index}].color 必须是 #RRGGBB。`);
    }
    return {
      segmentId,
      from,
      to,
      signalKind,
      ...(label !== undefined ? { label } : {}),
      ...(color !== undefined ? { color } : {}),
    };
  });

  return { regenerationId, summary, components, connections };
}

function validateEndpoint(
  value: unknown,
  field: string,
  instanceIds: ReadonlySet<string>,
): RegenerationEndpointInput {
  const endpoint = requireRecord(value, field);
  requireExactKeys(endpoint, ['instanceId', 'pinId', 'function'], field);
  const instanceId = requirePortableId(endpoint['instanceId'], `${field}.instanceId`);
  if (!instanceIds.has(instanceId)) {
    throw new Error(`${field}.instanceId 未在 components 中声明：${instanceId}`);
  }
  return {
    instanceId,
    pinId: requirePortableId(endpoint['pinId'], `${field}.pinId`),
    function: requireText(endpoint['function'], 128, `${field}.function`),
  };
}

function validateCommitResponse(value: unknown): {
  readonly tool: 'scene';
  readonly initialization: 'regenerated-v2';
} {
  const response = requireRecord(value, 'commit response');
  if (
    response['schemaVersion'] !== 1
    || response['kind'] !== 'aily-simulator-subapp-surface'
    || response['state'] !== 'ready'
    || response['tool'] !== 'scene'
    || response['initialization'] !== 'regenerated-v2'
  ) throw new Error('Project Scene authority 未返回 regenerated-v2 surface。');
  return response as unknown as {
    readonly tool: 'scene';
    readonly initialization: 'regenerated-v2';
  };
}

function createPortableRuntimeId(
  prefix: string,
  value: string | undefined,
  fallback: string,
): string {
  const source = typeof value === 'string' && value.trim() ? value : fallback;
  const suffix = source
    .replace(/[^A-Za-z0-9._:-]+/gu, '-')
    .replace(/^-+/u, '')
    .slice(0, Math.max(1, 127 - prefix.length));
  return `${prefix}:${suffix || 'unknown'}`.slice(0, 128);
}

function defaultSignalColor(signalKind: string): string {
  switch (signalKind) {
    case 'ground': return '#111827';
    case 'power': return '#EF4444';
    case 'analog': return '#10B981';
    case 'pwm': return '#EAB308';
    case 'i2c': return '#8B5CF6';
    case 'spi': return '#EC4899';
    case 'uart': return '#F59E0B';
    case 'gpio':
    default: return '#3B82F6';
  }
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} 必须是对象。`);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  field: string,
): void {
  const actual = Object.keys(value).sort();
  const normalizedExpected = [...expected].sort();
  if (actual.join('\0') !== normalizedExpected.join('\0')) {
    throw new Error(`${field} 字段不完整或包含越权字段。`);
  }
}

function requireAllowedKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) throw new Error(`${field}.${key} 不受支持。`);
  }
}

function requirePortableId(value: unknown, field: string): string {
  const text = requireText(value, 128, field);
  if (!PORTABLE_ID_PATTERN.test(text)) throw new Error(`${field} 不是 portable ID。`);
  return text;
}

function requireSha256(value: unknown, field: string): string {
  if (typeof value !== 'string' || !SHA_256_PATTERN.test(value)) {
    throw new Error(`${field} 必须是 lowercase SHA-256。`);
  }
  return value;
}

function requireText(value: unknown, maxLength: number, field: string): string {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > maxLength
    || /[\u0000-\u001F\u007F]/u.test(value)
  ) throw new Error(`${field} 文本无效。`);
  return value;
}

function requireOptionalText(value: unknown, maxLength: number, field: string): string {
  if (value === '') return '';
  return requireText(value, maxLength, field);
}

function requireCoordinate(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1_000_000) {
    throw new Error(`${field} 坐标无效。`);
  }
  return value;
}
