import {
  inferArduinoHardwareHints,
  type ProjectHardwareIntentHintV1,
} from '@aily-project/simulator-host-sdk';

export interface SimulatorSceneGpioBuildMetadata {
  readonly directions: Readonly<Record<string, 'input' | 'output'>>;
  readonly pulls: Readonly<Record<string, 'up' | 'down'>>;
}

/**
 * Projects firmware GPIO intent onto the exact board terminals present in the
 * revision-locked Scene. This emits Artifact metadata only and owns no
 * Simulator runtime or Scene mutation authority.
 */
export function createSimulatorSceneGpioBuildMetadata(
  sceneHead: unknown,
  sourceText: string,
  graphSemanticRevision: string,
): SimulatorSceneGpioBuildMetadata {
  if (!/^[a-f0-9]{64}$/u.test(graphSemanticRevision)) {
    throw new Error('Simulator Scene graph revision is invalid.');
  }
  const document = sceneDocument(sceneHead);
  if (document['graphSemanticRevision'] !== graphSemanticRevision) {
    throw new Error(
      'Simulator Scene changed before GPIO build metadata was generated.',
    );
  }
  const endpoints = collectSceneGpioEndpoints(document);
  const directions = new Map<string, 'input' | 'output'>();
  const pulls = new Map<string, 'up' | 'down'>();
  for (const hint of inferArduinoHardwareHints(sourceText)) {
    const direction = gpioDirection(hint);
    if (!direction) continue;
    for (const pin of hint.pins) {
      const endpoint = endpoints.get(normalizePinAlias(pin));
      if (!endpoint) continue;
      const previous = directions.get(endpoint);
      if (previous && previous !== direction) {
        throw new Error(
          `Firmware GPIO direction is ambiguous for Scene endpoint ${endpoint}.`,
        );
      }
      directions.set(endpoint, direction);
      if (direction === 'input' && (hint.pull === 'up' || hint.pull === 'down')) {
        pulls.set(endpoint, hint.pull);
      }
    }
  }
  return Object.freeze({
    directions: Object.freeze(Object.fromEntries(
      [...directions.entries()].sort(([left], [right]) => left.localeCompare(right)),
    )),
    pulls: Object.freeze(Object.fromEntries(
      [...pulls.entries()].sort(([left], [right]) => left.localeCompare(right)),
    )),
  });
}

function collectSceneGpioEndpoints(
  document: Record<string, unknown>,
): Map<string, string> {
  const components = records(document['components']);
  const terminals = records(document['terminals']);
  const configs = record(document['componentConfigs']);
  const terminalPins = new Map<string, Set<string>>();
  for (const terminal of terminals) {
    const instanceId = text(terminal['instanceId']);
    const pinId = text(terminal['pinId']);
    if (!instanceId || !pinId) continue;
    const pins = terminalPins.get(instanceId) ?? new Set<string>();
    pins.add(pinId);
    terminalPins.set(instanceId, pins);
  }

  const endpoints = new Map<string, string>();
  const ambiguousAliases = new Set<string>();
  for (const component of components) {
    const instanceId = text(component['instanceId']);
    if (!instanceId) continue;
    const connectedPins = terminalPins.get(instanceId);
    if (!connectedPins) continue;
    const config = resolveComponentConfig(configs, component, instanceId);
    for (const pin of records(config['pins'])) {
      const pinId = text(pin['id']);
      if (!pinId || !connectedPins.has(pinId)) continue;
      const endpoint = `${instanceId}.${pinId}`;
      const aliases = new Set<string>([
        pinId,
        text(pin['name']),
        ...records(pin['functions']).map((fn) => text(fn['name'])),
      ]);
      for (const alias of aliases) {
        if (!alias) continue;
        const normalized = normalizePinAlias(alias);
        if (ambiguousAliases.has(normalized)) continue;
        const existing = endpoints.get(normalized);
        if (existing && existing !== endpoint) {
          endpoints.delete(normalized);
          ambiguousAliases.add(normalized);
        } else if (!existing) {
          endpoints.set(normalized, endpoint);
        }
      }
    }
  }
  return endpoints;
}

function resolveComponentConfig(
  configs: Record<string, unknown>,
  component: Record<string, unknown>,
  instanceId: string,
): Record<string, unknown> {
  const direct = record(configs[instanceId]);
  if (Object.keys(direct).length > 0) return direct;
  const componentId = text(component['componentId']);
  for (const value of Object.values(configs)) {
    const candidate = record(value);
    if (componentId && text(candidate['id']) === componentId) return candidate;
  }
  return {};
}

function gpioDirection(
  hint: ProjectHardwareIntentHintV1,
): 'input' | 'output' | null {
  if (
    hint.kind === 'gpio-digital-output'
    || hint.kind === 'gpio-pwm-output'
  ) return 'output';
  if (
    hint.kind === 'gpio-digital-input'
    || hint.kind === 'gpio-analog-input'
  ) return 'input';
  return null;
}

function normalizePinAlias(value: string): string {
  const normalized = value.trim().toUpperCase();
  return /^\d{1,3}$/u.test(normalized) ? `GPIO${normalized}` : normalized;
}

function sceneDocument(value: unknown): Record<string, unknown> {
  const head = record(value);
  const descriptor = record(head['descriptor']);
  const document = record(descriptor['document']);
  if (
    head['schemaVersion'] !== 1
    || head['kind'] !== 'aily-blockly-simulator-project-scene-head'
    || descriptor['kind'] !== 'aily-project-scene-network-descriptor'
    || document['schemaVersion'] !== 2
    || document['kind'] !== 'aily-scene-editor-document'
  ) {
    throw new Error('Active Simulator Scene head is invalid.');
  }
  return document;
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(record) : [];
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
