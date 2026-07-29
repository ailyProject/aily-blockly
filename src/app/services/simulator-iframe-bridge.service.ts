import { Injectable } from '@angular/core';

export type SimulatorIframeSessionOperation =
  | 'session.start'
  | 'session.pause'
  | 'session.resume'
  | 'session.reset'
  | 'session.stop'
  | 'session.recover';

export type SimulatorIframeDebugOperation =
  | 'debug.snapshot'
  | 'debug.connect'
  | 'debug.disconnect'
  | 'debug.continue'
  | 'debug.interrupt'
  | 'debug.step-block'
  | 'debug.step-over'
  | 'debug.step-into'
  | 'debug.configuration.restore'
  | 'debug.configuration.remove'
  | 'debug.breakpoint.add'
  | 'debug.breakpoint.remove'
  | 'debug.watch.add'
  | 'debug.watch.remove'
  | 'debug.thread.select'
  | 'debug.frame.select'
  | 'debug.registers.read'
  | 'debug.memory.read'
  | 'debug.variable.toggle'
  | 'debug.variable.load-more'
  | 'project.debug.run-to-selected'
  | 'project.debug.breakpoint.capture-selected'
  | 'project.debug.breakpoint.set-enabled'
  | 'project.debug.breakpoint.remove'
  | 'project.debug.configuration.apply';

export type SimulatorIframeDebugOperationRequest =
  | {
      protocolVersion: 1;
      operation:
        | 'debug.snapshot'
        | 'debug.connect'
        | 'debug.disconnect'
        | 'debug.continue'
        | 'debug.interrupt'
        | 'debug.step-block'
        | 'debug.step-over'
        | 'debug.step-into'
        | 'debug.configuration.restore'
        | 'project.debug.run-to-selected'
        | 'project.debug.breakpoint.capture-selected'
        | 'project.debug.configuration.apply';
      payload: Record<string, never>;
    }
  | {
      protocolVersion: 1;
      operation: 'debug.configuration.remove';
      payload: {
        kind: 'breakpoints' | 'watches';
        configurationId: number;
      };
    }
  | {
      protocolVersion: 1;
      operation: 'debug.breakpoint.add';
      payload:
        | { kind: 'function'; functionName: string }
        | {
            kind: 'source';
            file: string;
            line: number;
            sourceRevision?: string;
          }
        | { kind: 'block'; blockId: string; sourceMapRevision: string };
    }
  | {
      protocolVersion: 1;
      operation: 'debug.breakpoint.remove' | 'debug.watch.remove';
      payload: { id: number };
    }
  | {
      protocolVersion: 1;
      operation: 'debug.watch.add';
      payload: { expression: string };
    }
  | {
      protocolVersion: 1;
      operation: 'debug.thread.select';
      payload: { threadId: number };
    }
  | {
      protocolVersion: 1;
      operation: 'debug.frame.select';
      payload: { level: number };
    }
  | {
      protocolVersion: 1;
      operation: 'debug.registers.read';
      payload: { offset: number };
    }
  | {
      protocolVersion: 1;
      operation: 'debug.memory.read';
      payload: { regionId: string; address: string; length: number };
    }
  | {
      protocolVersion: 1;
      operation: 'debug.variable.toggle' | 'debug.variable.load-more';
      payload: { handle: string };
    }
  | {
      protocolVersion: 1;
      operation: 'project.debug.breakpoint.set-enabled';
      payload: { blockId: string; enabled: boolean };
    }
  | {
      protocolVersion: 1;
      operation: 'project.debug.breakpoint.remove';
      payload: { blockId: string };
    };

export type SimulatorIframeSessionState =
  | 'disconnected'
  | 'preparing'
  | 'idle'
  | 'preflighting'
  | 'ready'
  | 'starting'
  | 'running'
  | 'paused'
  | 'stopping'
  | 'stopped'
  | 'crashed'
  | 'unsupported';

export interface SimulatorIframeUartInput {
  uart: 0;
  dataEncoding: 'base64';
  dataByteLength: number;
  dataBase64: string;
}

export interface SimulatorIframeDeviceAction {
  instanceId: string;
  action: string;
  parameters?: Record<string, string | number | boolean>;
}

export interface SimulatorIframeDeviceActionResult {
  instanceId: string;
  action: string;
  changed: boolean;
  state: Record<string, string | number | boolean>;
}

export type SimulatorIframeOperationResult =
  | {
      protocolVersion: 1;
      operation: SimulatorIframeSessionOperation;
      result: { state: SimulatorIframeSessionState };
    }
  | {
      protocolVersion: 1;
      operation: 'device.action';
      result: SimulatorIframeDeviceActionResult;
    }
  | {
      protocolVersion: 1;
      operation: 'uart.write';
      result: {
        uart: 0;
        acceptedBytes: number;
      };
    }
  | {
      protocolVersion: 1;
      operation: SimulatorIframeDebugOperation;
      result: {
        snapshot: unknown;
      };
    };

export interface SimulatorIframeOperationHandlers {
  session(
    operation: SimulatorIframeSessionOperation,
  ): Promise<{ state: SimulatorIframeSessionState }>;
  deviceAction(
    input: SimulatorIframeDeviceAction,
  ): Promise<SimulatorIframeDeviceActionResult>;
  uartWrite(
    input: SimulatorIframeUartInput,
  ): Promise<{ uart: number; acceptedBytes: number }>;
  debug(input: SimulatorIframeDebugOperationRequest): Promise<unknown>;
}

@Injectable({ providedIn: 'root' })
export class SimulatorIframeBridgeService {
  private handlers: SimulatorIframeOperationHandlers | null = null;

  registerHandlers(handlers: SimulatorIframeOperationHandlers): () => void {
    this.handlers = handlers;
    return () => {
      if (this.handlers === handlers) this.handlers = null;
    };
  }

  async invoke(value: unknown): Promise<SimulatorIframeOperationResult> {
    const request = validateOperation(value);
    const handlers = this.handlers;
    if (!handlers) {
      throw new Error('当前没有活动的本地仿真适配器。');
    }
    if (isSessionOperation(request.operation)) {
      const result = await handlers.session(request.operation);
      if (!isSessionState(result.state)) {
        throw new Error('本地仿真服务返回了无效的会话状态。');
      }
      return {
        protocolVersion: 1,
        operation: request.operation,
        result,
      };
    }
    if (request.operation === 'device.action') {
      const result = await handlers.deviceAction(request.payload);
      if (
        result.instanceId !== request.payload.instanceId
        || result.action !== request.payload.action
        || typeof result.changed !== 'boolean'
        || !isScalarRecord(result.state)
      ) {
        throw new Error('本地仿真服务返回了无效的器件操作结果。');
      }
      return {
        protocolVersion: 1,
        operation: 'device.action',
        result,
      };
    }

    if (isDebugOperation(request.operation)) {
      const snapshot = await handlers.debug({
        protocolVersion: 1,
        operation: request.operation,
        payload: request.payload,
      } as SimulatorIframeDebugOperationRequest);
      if (!isRecord(snapshot)) {
        throw new Error('本地仿真服务返回了无效的调试快照。');
      }
      return {
        protocolVersion: 1,
        operation: request.operation,
        result: { snapshot },
      };
    }

    if (request.operation !== 'uart.write') {
      throw new Error('仿真 iframe 操作类型无效。');
    }
    const result = await handlers.uartWrite(request.payload);
    if (
      result.uart !== 0
      || !Number.isSafeInteger(result.acceptedBytes)
      || result.acceptedBytes !== request.payload.dataByteLength
    ) {
      throw new Error('本地仿真服务返回了无效的 UART 写入结果。');
    }
    return {
      protocolVersion: 1,
      operation: 'uart.write',
      result: {
        uart: 0,
        acceptedBytes: result.acceptedBytes,
      },
    };
  }
}

type ValidatedOperation =
  | {
      operation: SimulatorIframeSessionOperation;
      payload: Record<string, never>;
    }
  | {
      operation: 'device.action';
      payload: SimulatorIframeDeviceAction;
    }
  | {
      operation: 'uart.write';
      payload: SimulatorIframeUartInput;
    }
  | SimulatorIframeDebugOperationRequest;

function validateOperation(value: unknown): ValidatedOperation {
  if (!isRecord(value) || value['protocolVersion'] !== 1) {
    throw new Error('仿真 iframe 操作协议版本无效。');
  }
  const operation = value['operation'];
  if (isSessionOperation(operation)) {
    if (
      !isRecord(value['payload'])
      || Object.keys(value['payload']).length !== 0
    ) {
      throw new Error('仿真会话操作不接受参数。');
    }
    return { operation, payload: {} };
  }
  if (operation === 'device.action') {
    return {
      operation,
      payload: validateDeviceAction(value['payload']),
    };
  }
  if (operation === 'uart.write') {
    return {
      operation,
      payload: validateUartWrite(value['payload']),
    };
  }
  if (isDebugOperation(operation)) {
    return validateDebugOperation(operation, value['payload']);
  }
  throw new Error('仿真 iframe 操作不在允许列表中。');
}

function validateDeviceAction(value: unknown): SimulatorIframeDeviceAction {
  if (
    !isRecord(value)
    || typeof value['instanceId'] !== 'string'
    || value['instanceId'].length < 1
    || value['instanceId'].length > 128
    || typeof value['action'] !== 'string'
    || !/^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(value['action'])
  ) {
    throw new Error('仿真 iframe 器件操作无效。');
  }
  const parameters = value['parameters'];
  if (
    parameters !== undefined
    && (
      !isRecord(parameters)
      || Object.keys(parameters).length > 16
      || !isScalarRecord(parameters)
    )
  ) {
    throw new Error('仿真 iframe 器件操作参数无效。');
  }
  const validatedParameters = parameters as
    Record<string, string | number | boolean> | undefined;
  return {
    instanceId: value['instanceId'],
    action: value['action'],
    ...(validatedParameters === undefined
      ? {}
      : { parameters: { ...validatedParameters } }),
  };
}

function validateUartWrite(value: unknown): SimulatorIframeUartInput {
  if (
    !isRecord(value)
    || value['uart'] !== 0
    || value['dataEncoding'] !== 'base64'
    || !Number.isSafeInteger(value['dataByteLength'])
    || Number(value['dataByteLength']) < 1
    || Number(value['dataByteLength']) > 4096
    || typeof value['dataBase64'] !== 'string'
  ) {
    throw new Error('仿真 iframe UART 输入无效。');
  }
  const dataByteLength = Number(value['dataByteLength']);
  const dataBase64 = value['dataBase64'];
  if (
    dataBase64.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      dataBase64,
    )
    || decodedBase64Length(dataBase64) !== dataByteLength
  ) {
    throw new Error('仿真 iframe UART base64 数据无效。');
  }
  return {
    uart: 0,
    dataEncoding: 'base64',
    dataByteLength,
    dataBase64,
  };
}

function isSessionOperation(
  value: unknown,
): value is SimulatorIframeSessionOperation {
  return value === 'session.start'
    || value === 'session.pause'
    || value === 'session.resume'
    || value === 'session.reset'
    || value === 'session.stop'
    || value === 'session.recover';
}

function isDebugOperation(
  value: unknown,
): value is SimulatorIframeDebugOperation {
  return isEmptyDebugOperation(value)
    || value === 'debug.configuration.remove'
    || value === 'debug.breakpoint.add'
    || value === 'debug.breakpoint.remove'
    || value === 'debug.watch.add'
    || value === 'debug.watch.remove'
    || value === 'debug.thread.select'
    || value === 'debug.frame.select'
    || value === 'debug.registers.read'
    || value === 'debug.memory.read'
    || value === 'debug.variable.toggle'
    || value === 'debug.variable.load-more'
    || value === 'project.debug.breakpoint.set-enabled'
    || value === 'project.debug.breakpoint.remove';
}

function isEmptyDebugOperation(
  value: unknown,
): value is
  | 'debug.snapshot'
  | 'debug.connect'
  | 'debug.disconnect'
  | 'debug.continue'
  | 'debug.interrupt'
  | 'debug.step-block'
  | 'debug.step-over'
  | 'debug.step-into'
  | 'debug.configuration.restore'
  | 'project.debug.run-to-selected'
  | 'project.debug.breakpoint.capture-selected'
  | 'project.debug.configuration.apply' {
  return value === 'debug.snapshot'
    || value === 'debug.connect'
    || value === 'debug.disconnect'
    || value === 'debug.continue'
    || value === 'debug.interrupt'
    || value === 'debug.step-block'
    || value === 'debug.step-over'
    || value === 'debug.step-into'
    || value === 'debug.configuration.restore'
    || value === 'project.debug.run-to-selected'
    || value === 'project.debug.breakpoint.capture-selected'
    || value === 'project.debug.configuration.apply';
}

function validateDebugOperation(
  operation: SimulatorIframeDebugOperation,
  value: unknown,
): SimulatorIframeDebugOperationRequest {
  const payload = requireRecord(
    value,
    `仿真 iframe ${operation} 参数无效。`,
  );
  if (isEmptyDebugOperation(operation)) {
    requireExactKeys(payload, []);
    return { protocolVersion: 1, operation, payload: {} };
  }
  if (operation === 'debug.configuration.remove') {
    requireExactKeys(payload, ['kind', 'configurationId']);
    const kind = payload['kind'];
    if (kind !== 'breakpoints' && kind !== 'watches') {
      throw new Error('待删除调试配置类型无效。');
    }
    return {
      protocolVersion: 1,
      operation,
      payload: {
        kind,
        configurationId: requirePositiveInteger(
          payload['configurationId'],
          '调试配置 ID 无效。',
        ),
      },
    };
  }
  if (operation === 'debug.breakpoint.add') {
    const kind = payload['kind'];
    if (kind === 'function') {
      requireExactKeys(payload, ['kind', 'functionName']);
      const functionName = requireString(payload['functionName'], 128);
      if (
        !/^(?:[A-Za-z_~][A-Za-z0-9_~]*)(?:::[A-Za-z_~][A-Za-z0-9_~]*)*$/.test(
          functionName,
        )
      ) {
        throw new Error('函数断点名称无效。');
      }
      return {
        protocolVersion: 1,
        operation,
        payload: { kind, functionName },
      };
    }
    if (kind === 'source') {
      const hasSourceRevision = payload['sourceRevision'] !== undefined;
      requireExactKeys(
        payload,
        hasSourceRevision
          ? ['kind', 'file', 'line', 'sourceRevision']
          : ['kind', 'file', 'line'],
      );
      const file = requireRelativePath(payload['file']);
      const sourceRevision = hasSourceRevision
        ? requireString(payload['sourceRevision'], 64)
        : undefined;
      if (
        sourceRevision !== undefined
        && !/^[a-f0-9]{64}$/.test(sourceRevision)
      ) {
        throw new Error('Artifact 源码 revision 无效。');
      }
      return {
        protocolVersion: 1,
        operation,
        payload: {
          kind,
          file,
          line: requirePositiveInteger(payload['line'], '源码行号无效。'),
          ...(sourceRevision === undefined ? {} : { sourceRevision }),
        },
      };
    }
    if (kind === 'block') {
      requireExactKeys(payload, ['kind', 'blockId', 'sourceMapRevision']);
      const sourceMapRevision = requireString(
        payload['sourceMapRevision'],
        64,
      );
      if (!/^[a-f0-9]{64}$/.test(sourceMapRevision)) {
        throw new Error('块断点 source-map revision 无效。');
      }
      return {
        protocolVersion: 1,
        operation,
        payload: {
          kind,
          blockId: requireString(payload['blockId'], 256),
          sourceMapRevision,
        },
      };
    }
    throw new Error('断点类型无效。');
  }
  if (
    operation === 'debug.breakpoint.remove'
    || operation === 'debug.watch.remove'
  ) {
    requireExactKeys(payload, ['id']);
    return {
      protocolVersion: 1,
      operation,
      payload: {
        id: requirePositiveInteger(payload['id'], '调试项 ID 无效。'),
      },
    };
  }
  if (operation === 'debug.watch.add') {
    requireExactKeys(payload, ['expression']);
    const expression = requireString(payload['expression'], 256);
    if (
      !/^(?:[A-Za-z_][A-Za-z0-9_]*|(?:0[xX][0-9A-Fa-f]+|\d+))(?:(?:\.[A-Za-z_][A-Za-z0-9_]*)|\[\d+\])*$/.test(
        expression,
      )
    ) {
      throw new Error('监视表达式无效。');
    }
    return {
      protocolVersion: 1,
      operation,
      payload: { expression },
    };
  }
  if (operation === 'debug.thread.select') {
    requireExactKeys(payload, ['threadId']);
    return {
      protocolVersion: 1,
      operation,
      payload: {
        threadId: requirePositiveInteger(
          payload['threadId'],
          'GDB 线程 ID 无效。',
        ),
      },
    };
  }
  if (operation === 'debug.frame.select') {
    requireExactKeys(payload, ['level']);
    return {
      protocolVersion: 1,
      operation,
      payload: {
        level: requireNonNegativeInteger(payload['level'], '栈帧层级无效。'),
      },
    };
  }
  if (operation === 'debug.registers.read') {
    requireExactKeys(payload, ['offset']);
    return {
      protocolVersion: 1,
      operation,
      payload: {
        offset: requireNonNegativeInteger(
          payload['offset'],
          '寄存器偏移无效。',
        ),
      },
    };
  }
  if (operation === 'debug.memory.read') {
    requireExactKeys(payload, ['regionId', 'address', 'length']);
    const address = requireString(payload['address'], 10);
    const length = requirePositiveInteger(payload['length'], '内存长度无效。');
    if (!/^0x[0-9A-Fa-f]{1,8}$/.test(address) || length > 256) {
      throw new Error('内存读取范围无效。');
    }
    return {
      protocolVersion: 1,
      operation,
      payload: {
        regionId: requireString(payload['regionId'], 128),
        address,
        length,
      },
    };
  }
  if (
    operation === 'debug.variable.toggle'
    || operation === 'debug.variable.load-more'
  ) {
    requireExactKeys(payload, ['handle']);
    const handle = requireString(payload['handle'], 96);
    if (!/^vt-[A-Za-z0-9_-]+$/.test(handle)) {
      throw new Error('变量句柄无效。');
    }
    return {
      protocolVersion: 1,
      operation,
      payload: { handle },
    };
  }
  if (operation === 'project.debug.breakpoint.set-enabled') {
    requireExactKeys(payload, ['blockId', 'enabled']);
    if (typeof payload['enabled'] !== 'boolean') {
      throw new Error('项目块断点启用状态无效。');
    }
    return {
      protocolVersion: 1,
      operation,
      payload: {
        blockId: requireString(payload['blockId'], 256),
        enabled: payload['enabled'],
      },
    };
  }
  requireExactKeys(payload, ['blockId']);
  return {
    protocolVersion: 1,
    operation: 'project.debug.breakpoint.remove',
    payload: {
      blockId: requireString(payload['blockId'], 256),
    },
  };
}

function isSessionState(
  value: unknown,
): value is SimulatorIframeSessionState {
  return value === 'disconnected'
    || value === 'preparing'
    || value === 'idle'
    || value === 'preflighting'
    || value === 'ready'
    || value === 'starting'
    || value === 'running'
    || value === 'paused'
    || value === 'stopping'
    || value === 'stopped'
    || value === 'crashed'
    || value === 'unsupported';
}

function requireRecord(
  value: unknown,
  message: string,
): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(message);
  return value;
}

function requireExactKeys(
  value: Record<string, unknown>,
  keys: string[],
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error('仿真 iframe 调试操作包含未允许的参数。');
  }
}

function requireString(
  value: unknown,
  maxLength: number,
): string {
  if (
    typeof value !== 'string'
    || !value
    || value.length > maxLength
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error('仿真 iframe 调试字符串参数无效。');
  }
  return value;
}

function requireNonNegativeInteger(
  value: unknown,
  message: string,
): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(message);
  }
  return Number(value);
}

function requirePositiveInteger(
  value: unknown,
  message: string,
): number {
  const result = requireNonNegativeInteger(value, message);
  if (result === 0) throw new Error(message);
  return result;
}

function requireRelativePath(value: unknown): string {
  const file = requireString(value, 512).replace(/\\/g, '/');
  if (
    file.startsWith('/')
    || /^[A-Za-z]:\//.test(file)
    || file.split('/').includes('..')
  ) {
    throw new Error('源码断点文件必须是相对路径。');
  }
  return file;
}

function decodedBase64Length(value: string): number {
  if (!value) return 0;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

function isScalarRecord(
  value: unknown,
): value is Record<string, string | number | boolean> {
  return isRecord(value)
    && Object.values(value).every((item) => (
      typeof item === 'string'
      || typeof item === 'number'
      || typeof item === 'boolean'
    ));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value);
}
