function clonePayload(value) {
  if (value == null) {
    return value;
  }
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
}

function normalizeSessionId(sessionId) {
  return typeof sessionId === 'string' && sessionId.trim().length > 0
    ? sessionId.trim()
    : '';
}

function normalizeRevision(value) {
  const revision = Number(value);
  return Number.isFinite(revision) && revision > 0
    ? revision
    : 0;
}

function normalizeTurnId(turnId) {
  return typeof turnId === 'string' && turnId.trim().length > 0
    ? turnId.trim()
    : '';
}

function normalizeOptionalString(value) {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : '';
}

function normalizeProtocolTruncation(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const kind = normalizeOptionalString(value.kind);
  if (kind !== 'removeFrom') {
    return null;
  }
  const turnId = normalizeTurnId(value.turnId);
  if (!turnId) {
    return null;
  }
  return { kind, turnId };
}

function buildSubmittedTurnSeed({ turnId, request, timestamp }) {
  const requestContent = normalizeOptionalString(request && request.requestText);
  const displayContent = normalizeOptionalString(request && request.displayText);
  const metadata = request && request.metadata && typeof request.metadata === 'object'
    ? clonePayload(request.metadata)
    : undefined;
  return {
    turnId,
    request: {
      content: requestContent,
      ...(displayContent && displayContent !== requestContent ? { displayContent } : {}),
      ...(metadata ? { metadata } : {}),
    },
    rounds: [],
    response: {
      id: turnId,
      participant: 'main',
      usedContext: undefined,
      contentReferences: [],
      codeCitations: [],
      progressMessages: [],
      continuation: undefined,
      status: 'streaming',
      parts: [],
      resultText: '',
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function normalizeErrorPayload(error) {
  const record = error && typeof error === 'object' ? error : {};
  return {
    code: typeof record.code === 'string' && record.code.trim().length > 0 ? record.code.trim() : undefined,
    message: typeof record.message === 'string' && record.message.trim().length > 0
      ? record.message.trim()
      : String(error || 'Runtime owner turn failed.'),
    retryable: typeof record.retryable === 'boolean' ? record.retryable : undefined,
  };
}

function buildErrorPart(error) {
  const normalized = normalizeErrorPayload(error);
  const errorDetails = {
    ...(normalized.code ? { code: normalized.code } : {}),
    ...(typeof normalized.retryable === 'boolean' ? { retryable: normalized.retryable } : {}),
  };
  const metadata = {
    ...(normalized.code ? { code: normalized.code } : {}),
    ...(Object.keys(errorDetails).length > 0 ? { errorDetails } : {}),
  };
  return {
    type: 'error',
    partId: 'runtime-host-error',
    message: normalized.message,
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
}

function isTerminalRunningStatus(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return normalized === 'running'
    || normalized === 'pending'
    || normalized === 'starting'
    || normalized === 'doing'
    || normalized === 'in_progress';
}

function isOpenToolCallState(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return !normalized
    || normalized === 'pending'
    || normalized === 'running'
    || normalized === 'doing'
    || normalized === 'reviewing'
    || normalized === 'in_progress';
}

function cancelOpenResponsePart(part, timestamp) {
  if (!part || typeof part !== 'object') {
    return part;
  }
  switch (part.type) {
    case 'tool_call':
      if (!isOpenToolCallState(part.state || part.status)) {
        return part;
      }
      return {
        ...part,
        state: 'cancelled',
        status: part.status ? 'cancelled' : part.status,
        updatedAt: timestamp,
        metadata: {
          ...(part.metadata && typeof part.metadata === 'object' ? part.metadata : {}),
          phase: 'cancelled',
        },
      };
    case 'terminal':
      if (part.isRunning !== true && !isTerminalRunningStatus(part.status)) {
        return part;
      }
      return {
        ...part,
        status: 'cancelled',
        isRunning: false,
        updatedAt: timestamp,
      };
    case 'subagent':
    case 'subagent_tool_call':
      if (!isOpenToolCallState(part.state || part.status)) {
        return part;
      }
      return {
        ...part,
        state: 'cancelled',
        status: 'cancelled',
        updatedAt: timestamp,
      };
    default:
      return part;
  }
}

function renderEventStateKey(sessionId, turnId) {
  return `${sessionId}\u0000${turnId}`;
}

function isRenderEventLike(event) {
  return !!event
    && typeof event === 'object'
    && typeof event.type === 'string'
    && event.type.trim().length > 0;
}

function normalizeTimestamp(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : Date.now();
}

function cloneParts(turn) {
  return Array.isArray(turn && turn.response && turn.response.parts)
    ? clonePayload(turn.response.parts)
    : [];
}

function collectMarkdownResultText(parts) {
  return parts
    .filter(part => part && part.type === 'markdown' && typeof part.content === 'string')
    .map(part => part.content)
    .join('');
}

function hasPartScope(part) {
  const metadataScope = part && part.metadata && part.metadata.scope && typeof part.metadata.scope === 'object'
    ? part.metadata.scope
    : {};
  return !!(
    (part && part.sourceAgentRole)
    || (part && part.subAgentInvocationId)
    || (part && part.parentToolCallId)
    || metadataScope.sourceAgentRole
    || metadataScope.subAgentInvocationId
    || metadataScope.parentToolCallId
  );
}

function isMainMarkdownPart(part) {
  return !!part
    && part.type === 'markdown'
    && typeof part.content === 'string'
    && !hasPartScope(part);
}

function collectMainMarkdownResultText(parts) {
  return parts
    .filter(isMainMarkdownPart)
    .map(part => part.content)
    .join('');
}

function readRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function asString(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function asNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function readRequestMetadata(turn) {
  return readRecord(turn && turn.request && turn.request.metadata);
}

function isPlanTurnRequest(turn) {
  const metadata = readRequestMetadata(turn);
  if (!metadata) {
    return false;
  }
  const modeInfo = readRecord(metadata.modeInfo);
  const routing = readRecord(metadata.requestRouting);
  const candidates = [
    metadata.modeId,
    metadata.requestModeId,
    metadata.selectedModeId,
    modeInfo && modeInfo.modeId,
    modeInfo && modeInfo.kind,
    routing && routing.modeId,
    routing && routing.requestModeId,
    routing && routing.selectedModeId,
  ];
  return candidates.some(value => typeof value === 'string' && value.trim().toLowerCase() === 'plan');
}

function extractProposedPlanText(markdown) {
  if (typeof markdown !== 'string') {
    return { text: '', source: 'summary' };
  }
  const match = markdown.match(/<proposed_plan\b[^>]*>([\s\S]*?)<\/proposed_plan>/i);
  if (match) {
    return { text: match[1].trim(), source: 'proposed_plan' };
  }
  return { text: markdown.trim(), source: 'summary' };
}

function materializePlanTurnParts(parts, turn) {
  if (!isPlanTurnRequest(turn)) {
    return { parts, resultText: undefined };
  }
  const markdown = collectMainMarkdownResultText(parts);
  const plan = extractProposedPlanText(markdown);
  if (!plan.text) {
    return { parts, resultText: undefined };
  }
  const planPartId = `plan:${turn.turnId || 'proposed'}`;
  const nextParts = parts.filter(part => !isMainMarkdownPart(part));
  const existingIndex = nextParts.findIndex(part => part && part.type === 'plan' && part.partId === planPartId);
  const nextPlanPart = {
    type: 'plan',
    partId: planPartId,
    status: 'completed',
    text: plan.text,
    source: plan.source,
  };
  if (existingIndex >= 0) {
    nextParts[existingIndex] = {
      ...nextParts[existingIndex],
      ...nextPlanPart,
    };
  } else {
    nextParts.push(nextPlanPart);
  }
  return { parts: nextParts, resultText: plan.text };
}

function buildPartMetadata(event, patch) {
  const scope = {};
  if (typeof event.sourceAgentRole === 'string') scope.sourceAgentRole = event.sourceAgentRole;
  if (typeof event.subAgentInvocationId === 'string') scope.subAgentInvocationId = event.subAgentInvocationId;
  if (typeof event.parentToolCallId === 'string') scope.parentToolCallId = event.parentToolCallId;
  if (Number.isFinite(event.sequence)) scope.sequence = event.sequence;
  return {
    ...scope,
    ...(Object.keys(scope).length > 0 ? { scope } : {}),
    ...(patch && typeof patch === 'object' ? patch : {}),
  };
}

function buildPartScopeFields(event) {
  const scope = {};
  if (typeof event.sourceAgentRole === 'string') scope.sourceAgentRole = event.sourceAgentRole;
  if (typeof event.subAgentInvocationId === 'string') scope.subAgentInvocationId = event.subAgentInvocationId;
  if (typeof event.parentToolCallId === 'string') scope.parentToolCallId = event.parentToolCallId;
  if (Number.isFinite(event.sequence)) scope.sequence = event.sequence;
  return scope;
}

function readPartScope(part) {
  if (!part || typeof part !== 'object') {
    return {};
  }
  const metadata = part.metadata && typeof part.metadata === 'object'
    ? part.metadata
    : {};
  const nestedScope = metadata.scope && typeof metadata.scope === 'object'
    ? metadata.scope
    : {};
  return {
    sourceAgentRole: part.sourceAgentRole || metadata.sourceAgentRole || nestedScope.sourceAgentRole,
    subAgentInvocationId: part.subAgentInvocationId || metadata.subAgentInvocationId || nestedScope.subAgentInvocationId,
    parentToolCallId: part.parentToolCallId || metadata.parentToolCallId || nestedScope.parentToolCallId,
  };
}

function sameScopedPart(part, event) {
  const scope = readPartScope(part);
  return (scope.sourceAgentRole || undefined) === (event.sourceAgentRole || undefined)
    && (scope.subAgentInvocationId || undefined) === (event.subAgentInvocationId || undefined)
    && (scope.parentToolCallId || undefined) === (event.parentToolCallId || undefined);
}

function appendTextPart(parts, state, turnId, event, kind, text) {
  if (typeof text !== 'string' || text.length === 0) {
    return parts;
  }
  const nextParts = [...parts];
  const lastIndex = nextParts.length - 1;
  const lastPart = lastIndex >= 0 ? nextParts[lastIndex] : null;
  if (lastPart && lastPart.type === kind && sameScopedPart(lastPart, event)) {
    nextParts[lastIndex] = {
      ...lastPart,
      content: `${lastPart.content || ''}${text}`,
      ...(kind === 'thinking' ? { isComplete: false } : {}),
    };
  } else {
    nextParts.push({
      type: kind,
      partId: `host-${kind}:${turnId}:${nextParts.length}`,
      content: text,
      ...buildPartScopeFields(event),
      ...(kind === 'thinking' ? { isComplete: false } : {}),
      metadata: buildPartMetadata(event),
    });
  }
  state.activeTextKind = kind;
  return nextParts;
}

function completeThinkingPart(parts, event) {
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    if (part && part.type === 'thinking' && sameScopedPart(part, event)) {
      const nextParts = [...parts];
      nextParts[index] = {
        ...part,
        isComplete: true,
      };
      return nextParts;
    }
  }
  return parts;
}

function upsertToolBegin(parts, state, event) {
  const toolCallId = normalizeOptionalString(event.toolCallId);
  const toolName = normalizeOptionalString(event.toolName) || 'tool';
  if (!toolCallId) {
    return parts;
  }
  const nextParts = [...parts];
  const partId = `tool:${toolCallId}`;
  state.toolPartIds.set(toolCallId, partId);
  const existingIndex = nextParts.findIndex(part => part && part.type === 'tool_call' && part.toolCallId === toolCallId);
  const nextPart = {
    ...(existingIndex >= 0 ? nextParts[existingIndex] : {}),
    type: 'tool_call',
    partId,
    toolCallId,
    toolName,
    text: `${toolName}...`,
    state: 'doing',
    args: event.input && typeof event.input === 'object' ? clonePayload(event.input) : undefined,
    ...buildPartScopeFields(event),
    metadata: buildPartMetadata(event, {
      startedAt: event.timestamp,
    }),
  };
  if (existingIndex >= 0) {
    nextParts[existingIndex] = nextPart;
  } else {
    nextParts.push(nextPart);
  }
  state.activeTextKind = null;
  return nextParts;
}

function patchToolProgress(parts, event) {
  const toolCallId = normalizeOptionalString(event.toolCallId);
  if (!toolCallId) {
    return parts;
  }
  const index = parts.findIndex(part => part && part.type === 'tool_call' && part.toolCallId === toolCallId);
  if (index < 0) {
    return parts;
  }
  const current = parts[index];
  const nextParts = [...parts];
  nextParts[index] = {
    ...current,
    state: current.state === 'done' || current.state === 'error' ? current.state : 'doing',
    metadata: {
      ...(current.metadata && typeof current.metadata === 'object' ? current.metadata : {}),
      progress: clonePayload(event.data),
      updatedAt: event.timestamp,
    },
  };
  return nextParts;
}

function patchToolEnd(parts, event) {
  const toolCallId = normalizeOptionalString(event.toolCallId);
  const toolName = normalizeOptionalString(event.toolName) || 'tool';
  if (!toolCallId) {
    return parts;
  }
  const index = parts.findIndex(part => part && part.type === 'tool_call' && part.toolCallId === toolCallId);
  const resultText = typeof event.resultText === 'string' ? event.resultText : '';
  const nextPart = {
    ...(index >= 0 ? parts[index] : {}),
    type: 'tool_call',
    partId: `tool:${toolCallId}`,
    toolCallId,
    toolName,
    text: resultText,
    state: event.state === 'error' || event.isError === true ? 'error' : 'done',
    ...buildPartScopeFields(event),
    metadata: buildPartMetadata(event, {
      resultText,
      result: clonePayload(event.result),
      durationMs: Number.isFinite(event.durationMs) ? event.durationMs : undefined,
      completedAt: event.timestamp,
    }),
  };
  const nextParts = [...parts];
  if (index >= 0) {
    nextParts[index] = nextPart;
  } else {
    nextParts.push(nextPart);
  }
  return nextParts;
}

function terminalPartId(command, toolCallId, terminal) {
  const sessionId = normalizeOptionalString(terminal.processId)
    || normalizeOptionalString(terminal.outputSessionId)
    || normalizeOptionalString(terminal.terminalId);
  if (sessionId) {
    return `terminal:${sessionId}`;
  }
  if (toolCallId) {
    return `terminal:${toolCallId}`;
  }
  return `terminal:${command || 'command'}`;
}

function normalizeTerminalStatus(status, isRunning) {
  return normalizeOptionalString(status) || (isRunning ? 'running' : undefined);
}

function buildTerminalPart(event, terminal, defaultRunning, outputUpdateKind) {
  const toolCallId = normalizeOptionalString(event.toolCallId);
  const command = normalizeOptionalString(terminal.command) || 'terminal command';
  const isRunning = typeof terminal.isRunning === 'boolean'
    ? terminal.isRunning
    : typeof terminal.running === 'boolean'
      ? terminal.running
      : defaultRunning;
  return {
    type: 'terminal',
    partId: terminalPartId(command, toolCallId, terminal),
    command,
    output: typeof terminal.output === 'string'
      ? terminal.output
      : typeof terminal.stdout === 'string'
        ? terminal.stdout
        : '',
    ...(typeof terminal.stderr === 'string' ? { stderr: terminal.stderr } : {}),
    ...(asNumber(terminal.exitCode) !== undefined ? { exitCode: asNumber(terminal.exitCode) } : {}),
    isRunning,
    ...(toolCallId ? { toolCallId, sourceToolCallIds: [toolCallId] } : {}),
    ...(normalizeOptionalString(terminal.processId) ? { processId: normalizeOptionalString(terminal.processId) } : {}),
    ...(normalizeOptionalString(terminal.outputSessionId) ? { outputSessionId: normalizeOptionalString(terminal.outputSessionId) } : {}),
    ...(normalizeOptionalString(terminal.terminalId) ? { terminalId: normalizeOptionalString(terminal.terminalId) } : {}),
    ...(normalizeOptionalString(terminal.outputFilePath) ? { outputFilePath: normalizeOptionalString(terminal.outputFilePath) } : {}),
    ...(normalizeOptionalString(terminal.cwd) ? { cwd: normalizeOptionalString(terminal.cwd) } : {}),
    ...(normalizeTerminalStatus(terminal.status, isRunning) ? { status: normalizeTerminalStatus(terminal.status, isRunning) } : {}),
    ...(asNumber(terminal.bytesTotal) !== undefined ? { bytesTotal: asNumber(terminal.bytesTotal) } : {}),
    ...(normalizeOptionalString(terminal.lastOutputAt) ? { lastOutputAt: normalizeOptionalString(terminal.lastOutputAt) } : {}),
    outputUpdateKind,
    ...buildPartScopeFields(event),
    metadata: buildPartMetadata(event),
  };
}

function mergeTerminalPart(existing, incoming) {
  if (!existing) {
    return incoming;
  }
  const replacesOutput = incoming.outputUpdateKind === 'snapshot';
  const output = replacesOutput
    ? incoming.output
    : incoming.output
      ? `${existing.output || ''}${incoming.output}`
      : existing.output || '';
  const stderr = replacesOutput
    ? incoming.stderr
    : incoming.stderr
      ? `${existing.stderr || ''}${incoming.stderr}`
      : existing.stderr;
  const existingSourceToolCallIds = Array.isArray(existing.sourceToolCallIds) ? existing.sourceToolCallIds : [];
  const incomingSourceToolCallIds = Array.isArray(incoming.sourceToolCallIds) ? incoming.sourceToolCallIds : [];
  const sourceToolCallIds = [
    ...new Set([
      ...existingSourceToolCallIds,
      ...incomingSourceToolCallIds,
    ]),
  ];
  return {
    ...existing,
    ...incoming,
    output,
    ...(stderr ? { stderr } : {}),
    ...(sourceToolCallIds.length > 0 ? { sourceToolCallIds } : {}),
  };
}

function upsertTerminalPart(parts, event, terminal, defaultRunning, outputUpdateKind) {
  if (!terminal) {
    return parts;
  }
  const incoming = buildTerminalPart(event, terminal, defaultRunning, outputUpdateKind);
  const nextParts = [...parts];
  const index = nextParts.findIndex(part =>
    part && part.type === 'terminal'
    && (
      part.partId === incoming.partId
      || (incoming.processId && part.processId === incoming.processId)
      || (incoming.outputSessionId && part.outputSessionId === incoming.outputSessionId)
      || (incoming.terminalId && part.terminalId === incoming.terminalId)
      || (incoming.toolCallId && part.toolCallId === incoming.toolCallId)
    ));
  if (index >= 0) {
    nextParts[index] = mergeTerminalPart(nextParts[index], incoming);
  } else {
    nextParts.push(incoming);
  }
  return nextParts;
}

function normalizeCommandOutputProgress(data) {
  const record = readRecord(data);
  if (!record || asString(record.kind) !== 'command_output') {
    return null;
  }
  const text = asString(record.text) || asString(record.detail) || '';
  if (!text) {
    return null;
  }
  const stream = asString(record.stream) === 'stderr' ? 'stderr' : 'stdout';
  return {
    command: asString(record.command) || 'terminal command',
    output: stream === 'stdout' ? text : '',
    stderr: stream === 'stderr' ? text : '',
    processId: asString(record.processId),
    outputSessionId: asString(record.outputSessionId),
    outputFilePath: asString(record.outputFilePath),
    cwd: asString(record.cwd),
    status: asString(record.status),
    running: typeof record.running === 'boolean' ? record.running : undefined,
    bytesTotal: asNumber(record.bytesTotal),
    lastOutputAt: asString(record.lastOutputAt),
  };
}

function normalizeCommandSessionUpdate(data) {
  const record = readRecord(data);
  if (!record || asString(record.kind) !== 'command_session_update') {
    return null;
  }
  return {
    command: asString(record.command) || 'terminal command',
    output: typeof record.stdout === 'string' ? record.stdout : '',
    stderr: typeof record.stderr === 'string' ? record.stderr : '',
    processId: asString(record.processId),
    outputSessionId: asString(record.outputSessionId),
    outputFilePath: asString(record.outputFilePath),
    cwd: asString(record.cwd),
    status: asString(record.status),
    running: typeof record.running === 'boolean' ? record.running : undefined,
    exitCode: asNumber(record.exitCode),
    bytesTotal: asNumber(record.bytesTotal),
    lastOutputAt: asString(record.lastOutputAt),
  };
}

function extractRawToolResultPayloadText(result) {
  if (typeof result === 'string') {
    return result;
  }
  const record = readRecord(result);
  if (!record) {
    return '';
  }
  if (typeof record.text === 'string') {
    return record.text;
  }
  if (typeof record.output === 'string' || typeof record.stdout === 'string' || typeof record.stderr === 'string') {
    return JSON.stringify(record);
  }
  const content = Array.isArray(record.content) ? record.content : [];
  for (const part of content) {
    if (part && typeof part === 'object' && part.type === 'terminal_command') {
      const terminal = {
        command: typeof part.text === 'string' ? part.text : '',
        terminalId: part.terminalId,
        processId: part.processId,
        outputSessionId: part.outputSessionId,
        outputFilePath: part.outputFilePath,
        cwd: part.cwd,
        exitCode: part.exitCode,
        isRunning: part.isRunning,
        status: part.status,
        bytesTotal: part.bytesTotal,
        lastOutputAt: part.lastOutputAt,
        output: content
          .filter(candidate => candidate && typeof candidate === 'object' && candidate.type === 'terminal_stdout')
          .map(candidate => typeof candidate.text === 'string' ? candidate.text : '')
          .join(''),
        stderr: content
          .filter(candidate => candidate && typeof candidate === 'object' && candidate.type === 'terminal_stderr')
          .map(candidate => typeof candidate.text === 'string' ? candidate.text : '')
          .join(''),
      };
      return JSON.stringify(terminal);
    }
    if (part && typeof part === 'object' && typeof part.text === 'string') {
      return part.text;
    }
  }
  return '';
}

function cleanTerminalStream(value, emptyMarker) {
  if (!value) {
    return '';
  }
  const trimmed = value.trim();
  if (trimmed === emptyMarker) {
    return '';
  }
  if (value.startsWith(emptyMarker)) {
    return value.slice(emptyMarker.length).replace(/^\r?\n+/, '');
  }
  return value;
}

function parseTerminalPayload(text) {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return null;
  }
  try {
    const data = JSON.parse(text);
    if (!readRecord(data)) {
      return null;
    }
    if (!isTerminalPayloadRecord(data)) {
      return null;
    }
    const status = asString(data.status);
    return {
      command: asString(data.command) || '',
      output: cleanTerminalStream(asString(data.output) || asString(data.stdout) || '', '(terminal stdout completed with no output)'),
      stderr: cleanTerminalStream(asString(data.stderr) || '', '(terminal stderr completed with no output)'),
      exitCode: asNumber(data.exit_code) ?? asNumber(data.exitCode),
      isRunning: status === 'running',
      terminalId: asString(data.terminalId),
      processId: asString(data.processId) || asString(data.id),
      outputSessionId: asString(data.outputSessionId),
      outputFilePath: asString(data.outputFilePath),
      cwd: asString(data.cwd),
      status,
      bytesTotal: asNumber(data.bytesTotal),
      lastOutputAt: asString(data.lastOutputAt),
    };
  } catch {
    const lines = text.split(/\r?\n/);
    const headers = new Map();
    const stdout = [];
    const stderr = [];
    let section = 'headers';
    for (const line of lines) {
      if (line === 'stdout:') {
        section = 'stdout';
        continue;
      }
      if (line === 'stderr:') {
        section = 'stderr';
        continue;
      }
      if (section === 'headers') {
        const match = line.match(/^([A-Za-z]+):\s*(.*)$/);
        if (match) {
          headers.set(match[1].toLowerCase(), match[2]);
        }
        continue;
      }
      if (section === 'stdout') {
        stdout.push(line);
      } else {
        stderr.push(line);
      }
    }
    const command = headers.get('command') || '';
    if (!command && stdout.length === 0 && stderr.length === 0) {
      return null;
    }
    return {
      command,
      output: cleanTerminalStream(stdout.join('\n').trim(), '(terminal stdout completed with no output)'),
      stderr: cleanTerminalStream(stderr.join('\n').trim(), '(terminal stderr completed with no output)'),
      exitCode: asNumber(headers.get('exitcode')),
      isRunning: headers.get('status') === 'running',
      terminalId: headers.get('terminalid'),
      processId: headers.get('processid'),
      outputSessionId: headers.get('outputsessionid'),
      outputFilePath: headers.get('outputfilepath'),
      cwd: headers.get('cwd'),
      status: headers.get('status'),
      bytesTotal: asNumber(headers.get('bytestotal')),
      lastOutputAt: headers.get('lastoutputat'),
    };
  }
}

function isTerminalPayloadRecord(value) {
  if (!readRecord(value)) {
    return false;
  }
  const hasCommand = hasOwn(value, 'command') && asString(value.command) !== undefined;
  const hasTerminalIdentity = hasOwn(value, 'terminalId')
    || hasOwn(value, 'processId')
    || hasOwn(value, 'outputSessionId')
    || hasOwn(value, 'outputFilePath');
  const hasTerminalStream = hasOwn(value, 'stdout') || hasOwn(value, 'stderr');
  const hasTerminalOutputMetadata = hasOwn(value, 'bytesTotal') || hasOwn(value, 'lastOutputAt');

  return hasCommand
    || hasTerminalIdentity
    || hasTerminalStream
    || (hasTerminalOutputMetadata && (hasCommand || hasTerminalIdentity || hasTerminalStream));
}

function hasOwn(record, field) {
  return Object.prototype.hasOwnProperty.call(record, field);
}

function extractTerminalPartFromToolEnd(event) {
  const text = extractRawToolResultPayloadText(event.result);
  const parsed = parseTerminalPayload(text);
  if (!parsed) {
    return null;
  }
  return parsed;
}

function appendNoticePart(parts, event, type, message) {
  const normalizedMessage = typeof message === 'string' ? message : '';
  if (!normalizedMessage) {
    return parts;
  }
  return [
    ...parts,
    {
      type,
      partId: `host-${type}:${normalizeTimestamp(event.timestamp)}:${parts.length}`,
      message: normalizedMessage,
      metadata: buildPartMetadata(event, {
        code: event.code,
        details: clonePayload(event.details),
      }),
    },
  ];
}

function upsertStatePart(parts, event, options) {
  const stateId = normalizeOptionalString(options && options.stateId);
  if (!stateId) {
    return parts;
  }
  const nextParts = [...parts];
  const index = nextParts.findIndex(part => part && part.type === 'state' && part.stateId === stateId);
  const state = ['doing', 'done', 'warn', 'error', 'info'].includes(options.state)
    ? options.state
    : 'info';
  const nextPart = {
    ...(index >= 0 ? nextParts[index] : {}),
    type: 'state',
    stateId,
    text: typeof options.text === 'string' ? options.text : '',
    state,
    kind: options.kind,
    progress: Number.isFinite(options.progress) ? options.progress : undefined,
    ...buildPartScopeFields(event),
    metadata: buildPartMetadata(event, options.metadata),
  };
  if (index >= 0) {
    nextParts[index] = nextPart;
  } else {
    nextParts.push(nextPart);
  }
  return nextParts;
}

function upsertQuestionPart(parts, event) {
  const requestId = normalizeOptionalString(event.requestId);
  if (!requestId) {
    return parts;
  }
  const partId = `question:${requestId}`;
  const nextParts = [...parts];
  const index = nextParts.findIndex(part => part && part.type === 'question' && part.partId === partId);
  const questions = Array.isArray(event.questions)
    ? event.questions.map(question => ({
      question: typeof question.question === 'string' ? question.question : '',
      options: Array.isArray(question.options)
        ? question.options.map(option => ({
          label: typeof option.label === 'string' ? option.label : '',
          ...(typeof option.description === 'string' ? { description: option.description } : {}),
          ...(typeof option.recommended === 'boolean' ? { recommended: option.recommended } : {}),
        }))
        : undefined,
      allowFreeform: question.allowFreeform,
      multiSelect: question.multiSelect,
    }))
    : [];
  const nextPart = {
    ...(index >= 0 ? nextParts[index] : {}),
    type: 'question',
    partId,
    questions,
    ...buildPartScopeFields(event),
    metadata: buildPartMetadata(event, {
      requestId,
      requestedAt: event.timestamp,
    }),
  };
  if (index >= 0) {
    nextParts[index] = nextPart;
  } else {
    nextParts.push(nextPart);
  }
  return nextParts;
}

function upsertApprovalRequestPart(parts, event) {
  const askId = normalizeOptionalString(event.requestId) || normalizeOptionalString(event.toolCallId);
  if (!askId) {
    return parts;
  }
  const partId = `confirmation:${askId}`;
  const nextParts = [...parts];
  const index = nextParts.findIndex(part => part && part.type === 'confirmation' && part.partId === partId);
  const actions = Array.isArray(event.actions)
    ? event.actions.map(action => ({
      scope: action.scope,
      label: action.label,
      ...(typeof action.description === 'string' ? { description: action.description } : {}),
      ...(typeof action.tooltip === 'string' ? { tooltip: action.tooltip } : {}),
      ...(typeof action.disabled === 'boolean' ? { disabled: action.disabled } : {}),
      ...(typeof action.isSecondary === 'boolean' ? { isSecondary: action.isSecondary } : {}),
      ...(typeof action.resolves === 'boolean' ? { resolves: action.resolves } : {}),
    }))
    : [];
  const primaryScope = event.primaryScope || actions.find(action => !action.isSecondary)?.scope || 'once';
  const toolName = normalizeOptionalString(event.toolName);
  const title = normalizeOptionalString(event.title) || (toolName ? `Approve ${toolName}` : 'Confirm action');
  const nextPart = {
    ...(index >= 0 ? nextParts[index] : {}),
    type: 'confirmation',
    partId,
    askId,
    toolName: toolName || undefined,
    title,
    subtitle: normalizeOptionalString(event.subtitle) || normalizeOptionalString(event.toolCallId) || undefined,
    message: typeof event.message === 'string' ? event.message : title,
    description: typeof event.description === 'string' ? event.description : undefined,
    args: event.input && typeof event.input === 'object' ? clonePayload(event.input) : undefined,
    source: event.source,
    actions,
    primaryScope,
    resolved: false,
    ...buildPartScopeFields(event),
    metadata: buildPartMetadata(event, {
      requestId: event.requestId,
      toolCallId: event.toolCallId,
      allowAutoConfirm: event.allowAutoConfirm,
      approveCombination: clonePayload(event.approveCombination),
      requestedAt: event.timestamp,
    }),
  };
  if (index >= 0) {
    nextParts[index] = nextPart;
  } else {
    nextParts.push(nextPart);
  }
  return nextParts;
}

function patchApprovalResolvePart(parts, event) {
  const askId = normalizeOptionalString(event.requestId) || normalizeOptionalString(event.toolCallId);
  if (!askId) {
    return parts;
  }
  const partId = `confirmation:${askId}`;
  const index = parts.findIndex(part =>
    part && part.type === 'confirmation' && (part.partId === partId || part.askId === askId));
  if (index < 0) {
    return parts;
  }
  const nextParts = [...parts];
  const current = nextParts[index];
  nextParts[index] = {
    ...current,
    resolved: true,
    result: event.result,
    scope: event.scope || current.scope,
    metadata: {
      ...(current.metadata && typeof current.metadata === 'object' ? current.metadata : {}),
      resolvedAt: event.timestamp,
    },
  };
  return nextParts;
}

function readSubagentStateEventPayload(event) {
  const metadata = event && event.metadata && typeof event.metadata === 'object' && !Array.isArray(event.metadata)
    ? event.metadata
    : {};
  const stateId = normalizeOptionalString(event && event.stateId);
  const stateToolCallId = stateId && stateId.startsWith('subagent:')
    ? stateId.slice('subagent:'.length)
    : '';
  const toolCallId = normalizeOptionalString(event && event.toolCallId)
    || normalizeOptionalString(metadata.toolCallId)
    || stateToolCallId;
  const invocationId = normalizeOptionalString(event && event.subAgentInvocationId)
    || normalizeOptionalString(metadata.subAgentInvocationId)
    || toolCallId;
  if (!toolCallId || !invocationId) {
    return null;
  }

  const resultText = normalizeOptionalString(event && event.resultText)
    || normalizeOptionalString(metadata.resultText)
    || (event && event.state === 'done' ? normalizeOptionalString(event.text) : '');
  const description = normalizeOptionalString(event && event.description)
    || normalizeOptionalString(metadata.description)
    || (event && event.state !== 'done' ? normalizeOptionalString(event.text) : '');
  return {
    toolCallId,
    invocationId,
    agentName: normalizeOptionalString(event && event.agentName)
      || normalizeOptionalString(metadata.agentName)
      || 'Agent',
    description: description || 'Subagent',
    resultText: resultText || '',
    durationMs: Number.isFinite(event && event.durationMs)
      ? event.durationMs
      : Number.isFinite(metadata.durationMs) ? metadata.durationMs : undefined,
  };
}

function subagentEventPayload(event) {
  if (event && event.type === 'state_update') {
    return readSubagentStateEventPayload(event);
  }

  const toolCallId = normalizeOptionalString(event && event.toolCallId);
  const invocationId = normalizeOptionalString(event && event.subAgentInvocationId) || toolCallId;
  if (!toolCallId || !invocationId) {
    return null;
  }
  return {
    toolCallId,
    invocationId,
    agentName: normalizeOptionalString(event && event.agentName) || 'Agent',
    description: normalizeOptionalString(event && event.description) || 'Subagent',
    resultText: normalizeOptionalString(event && event.resultText) || '',
    durationMs: Number.isFinite(event && event.durationMs) ? event.durationMs : undefined,
  };
}

function subagentStateForEvent(event, stateOverride) {
  if (stateOverride) {
    return stateOverride;
  }
  if (event && event.state === 'error') {
    return 'error';
  }
  if (event && event.type === 'subagent_end') {
    return 'done';
  }
  if (event && event.type === 'state_update' && (event.state === 'done' || event.state === 'error')) {
    return event.state;
  }
  return 'doing';
}

function isLegacySubagentStatePart(part, toolCallId, invocationId) {
  const legacyStateIds = new Set([
    `subagent:${toolCallId}`,
    `subagent:${invocationId}`,
  ]);
  return !!part
    && part.type === 'state'
    && legacyStateIds.has(part.stateId);
}

function removeLegacySubagentStateParts(parts, toolCallId, invocationId, exceptIndex) {
  return parts.filter((part, index) => {
    if (index === exceptIndex) {
      return true;
    }
    return !isLegacySubagentStatePart(part, toolCallId, invocationId);
  });
}

function buildSubagentToolMetadata(event, payload, state, existingMetadata) {
  const existing = existingMetadata && typeof existingMetadata === 'object' ? existingMetadata : {};
  const existingToolSpecificData = existing.toolSpecificData && typeof existing.toolSpecificData === 'object' && !Array.isArray(existing.toolSpecificData)
    ? existing.toolSpecificData
    : {};
  const existingTimeline = Array.isArray(existing.timeline) ? existing.timeline : [];
  const timestamp = normalizeTimestamp(event && event.timestamp);
  const phase = state === 'error' ? 'failed' : state === 'done' ? 'completed' : 'started';
  const summary = state === 'done' || state === 'error'
    ? payload.resultText || `${payload.agentName} completed`
    : payload.description || payload.agentName;
  const timelineEntryId = `${payload.toolCallId}:${phase}`;
  const timeline = existingTimeline.some(entry => entry && entry.recordId === timelineEntryId)
    ? existingTimeline
    : [
        ...existingTimeline,
        {
          recordId: timelineEntryId,
          phase,
          summary,
          timestamp,
        },
      ];
  const existingResult = normalizeOptionalString(existingToolSpecificData.result);
  return {
    ...existing,
    toolName: 'agent',
    phase,
    argsSummary: payload.description,
    recordId: payload.toolCallId,
    invocationMessage: payload.description || payload.agentName,
    pastTenseMessage: payload.description ? `Completed Task: "${payload.description}"` : payload.agentName,
    timeline,
    ...(Number.isFinite(payload.durationMs) ? { durationMs: payload.durationMs } : {}),
    toolSpecificData: {
      ...existingToolSpecificData,
      kind: 'subagent',
      agentName: payload.agentName,
      description: payload.description,
      result: payload.resultText || existingResult || '',
    },
  };
}

function upsertSubagentToolCallPart(parts, event, stateOverride) {
  const payload = subagentEventPayload(event);
  if (!payload) {
    return parts;
  }
  const state = subagentStateForEvent(event, stateOverride);
  const partId = `tool:${payload.toolCallId}`;
  const existingIndex = parts.findIndex(part =>
    part && part.type === 'tool_call' && part.toolCallId === payload.toolCallId);
  const legacyIndex = existingIndex < 0
    ? parts.findIndex(part => isLegacySubagentStatePart(part, payload.toolCallId, payload.invocationId))
    : -1;
  const existing = existingIndex >= 0 ? parts[existingIndex] : {};
  const text = state === 'done' || state === 'error'
    ? payload.resultText || `${payload.agentName} completed`
    : payload.description || `${payload.agentName} started`;
  const nextPart = {
    ...existing,
    type: 'tool_call',
    partId,
    toolCallId: payload.toolCallId,
    toolName: 'agent',
    text,
    state,
    args: {
      agentName: payload.agentName,
      description: payload.description,
    },
    metadata: buildSubagentToolMetadata(event, payload, state, existing.metadata),
  };
  let nextParts = [...parts];
  if (existingIndex >= 0) {
    nextParts[existingIndex] = nextPart;
    nextParts = removeLegacySubagentStateParts(nextParts, payload.toolCallId, payload.invocationId, existingIndex);
  } else if (legacyIndex >= 0) {
    nextParts[legacyIndex] = nextPart;
    nextParts = removeLegacySubagentStateParts(nextParts, payload.toolCallId, payload.invocationId, legacyIndex);
  } else {
    nextParts.push(nextPart);
  }
  return nextParts;
}

function subagentActivityScope(event) {
  const parentToolCallId = normalizeOptionalString(event.parentToolCallId) || normalizeOptionalString(event.toolCallId);
  if (!parentToolCallId) {
    return {};
  }
  return {
    sourceAgentRole: 'subagent',
    subAgentInvocationId: parentToolCallId,
    parentToolCallId,
  };
}

function withSubagentActivityScope(event) {
  return {
    ...event,
    ...subagentActivityScope(event),
  };
}

function isSubagentStateUpdate(event) {
  return !!event
    && event.type === 'state_update'
    && (
      (typeof event.stateId === 'string' && event.stateId.startsWith('subagent:'))
      || event.kind === 'agent_team'
    );
}

function upsertSubagentActivityPart(parts, state, turnId, event) {
  parts = upsertSubagentToolCallPart(parts, event, 'doing');
  const scopedActivityEvent = withSubagentActivityScope(event);
  if (event.activityKind === 'thinking') {
    return appendTextPart(parts, state, turnId, scopedActivityEvent, 'thinking', event.content);
  }
  if (event.activityKind === 'text') {
    return appendTextPart(parts, state, turnId, scopedActivityEvent, 'markdown', event.content);
  }

  const childToolCallId = normalizeOptionalString(event.childToolCallId) || normalizeOptionalString(event.toolCallId);
  if (!childToolCallId) {
    return parts;
  }
  const scopedEvent = {
    ...scopedActivityEvent,
    toolCallId: childToolCallId,
    toolName: normalizeOptionalString(event.toolName) || 'tool',
    input: event.argsSummary ? { summary: event.argsSummary } : {},
    resultText: event.content || event.argsSummary || '',
    result: event.content ? { content: [{ type: 'text', text: event.content }] } : undefined,
    durationMs: event.durationMs,
    state: event.activityKind === 'tool_failed' ? 'error' : event.state || 'done',
    isError: event.activityKind === 'tool_failed' || event.state === 'error',
  };
  if (event.activityKind === 'tool_started') {
    return upsertToolBegin(parts, state, scopedEvent);
  }
  if (event.activityKind === 'tool_progress') {
    return patchToolProgress(parts, { ...scopedEvent, data: { content: event.content, argsSummary: event.argsSummary } });
  }
  if (event.activityKind === 'tool_completed' || event.activityKind === 'tool_failed') {
    return patchToolEnd(parts, scopedEvent);
  }
  return parts;
}

function isSubagentStateUpdateEvent(event) {
  return !!event
    && event.type === 'state_update'
    && (
      event.kind === 'agent_team'
      || (typeof event.stateId === 'string' && event.stateId.startsWith('subagent:'))
    );
}

function readSubagentScopeFromEvent(event) {
  const metadata = event && event.metadata && typeof event.metadata === 'object' && !Array.isArray(event.metadata)
    ? event.metadata
    : {};
  const stateId = normalizeOptionalString(event && event.stateId);
  const stateToolCallId = stateId && stateId.startsWith('subagent:')
    ? stateId.slice('subagent:'.length)
    : '';
  const toolCallId = normalizeOptionalString(event && event.toolCallId)
    || normalizeOptionalString(metadata.toolCallId)
    || stateToolCallId;
  const subAgentInvocationId = normalizeOptionalString(event && event.subAgentInvocationId)
    || normalizeOptionalString(metadata.subAgentInvocationId)
    || toolCallId;
  if (!toolCallId || !subAgentInvocationId) {
    return null;
  }
  return {
    toolCallId,
    subAgentInvocationId,
    agentName: normalizeOptionalString(event && event.agentName)
      || normalizeOptionalString(metadata.agentName),
  };
}

function isSubagentScopeTerminalEvent(event) {
  return !!event && (event.state === 'done' || event.state === 'error' || event.type === 'subagent_end');
}

function isEventScopedToSubagent(event, scope) {
  return !!event && !!scope && (
    event.sourceAgentRole === 'subagent'
    || event.subAgentInvocationId === scope.subAgentInvocationId
    || event.parentToolCallId === scope.toolCallId
  );
}

function withSubagentScope(event, scope) {
  return {
    ...event,
    sourceAgentRole: 'subagent',
    subAgentInvocationId: event.subAgentInvocationId || scope.subAgentInvocationId,
    parentToolCallId: event.parentToolCallId || scope.toolCallId,
  };
}

function shouldScopeEventToActiveSubagent(event, scope) {
  if (!event || !scope || isEventScopedToSubagent(event, scope)) {
    return false;
  }
  switch (event.type) {
    case 'markdown_delta':
    case 'thinking_delta':
    case 'thinking_complete':
    case 'tool_call_begin':
    case 'tool_call_progress':
    case 'tool_call_end':
    case 'question_request':
    case 'approval_request':
    case 'approval_resolve':
    case 'warning_notice':
    case 'info_notice':
    case 'error_notice':
      return event.toolCallId !== scope.toolCallId;
    default:
      return false;
  }
}

function routeRenderEventForSubagentScope(state, event) {
  if (!state) {
    return event;
  }
  if (!Array.isArray(state.activeSubagentScopes)) {
    state.activeSubagentScopes = [];
  }

  if (event && event.type === 'subagent_begin') {
    const scope = readSubagentScopeFromEvent(event);
    if (scope && !state.activeSubagentScopes.some(item => item.toolCallId === scope.toolCallId || item.subAgentInvocationId === scope.subAgentInvocationId)) {
      state.activeSubagentScopes.push(scope);
    }
    return event;
  }

  if (isSubagentStateUpdateEvent(event)) {
    const scope = readSubagentScopeFromEvent(event);
    if (!scope) {
      return event;
    }
    const existingIndex = state.activeSubagentScopes.findIndex(item =>
      item.toolCallId === scope.toolCallId || item.subAgentInvocationId === scope.subAgentInvocationId);
    if (isSubagentScopeTerminalEvent(event)) {
      if (existingIndex >= 0) {
        state.activeSubagentScopes.splice(existingIndex, 1);
      }
    } else if (existingIndex < 0) {
      state.activeSubagentScopes.push(scope);
    }
    return event;
  }

  const activeScope = state.activeSubagentScopes[state.activeSubagentScopes.length - 1];
  if (!activeScope) {
    return event;
  }

  if (event && event.type === 'subagent_end') {
    const scope = readSubagentScopeFromEvent(event);
    const index = state.activeSubagentScopes.findIndex(item =>
      scope && (item.toolCallId === scope.toolCallId || item.subAgentInvocationId === scope.subAgentInvocationId));
    if (index >= 0) {
      state.activeSubagentScopes.splice(index, 1);
    }
    return event;
  }

  return shouldScopeEventToActiveSubagent(event, activeScope)
    ? withSubagentScope(event, activeScope)
    : event;
}

function clearToPreviousToolInvocation(parts) {
  let index = -1;
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    if (parts[i] && parts[i].type === 'tool_call') {
      index = i;
      break;
    }
  }
  return index >= 0 ? parts.slice(0, index + 1) : [];
}

function withResponsePatch(turn, timestamp, patch) {
  const existingResponse = turn && turn.response && typeof turn.response === 'object'
    ? turn.response
    : {};
  const status = patch.status || existingResponse.status || 'streaming';
  const parts = normalizeResponsePartsForStatus(
    Array.isArray(patch.parts) ? patch.parts : cloneParts(turn),
    status,
  );
  const resultText = patch.resultText !== undefined
    ? patch.resultText
    : status === 'completed'
      ? collectMarkdownResultText(parts)
      : typeof existingResponse.resultText === 'string'
        ? existingResponse.resultText
        : '';
  return {
    ...turn,
    response: {
      ...existingResponse,
      id: existingResponse.id || turn.turnId,
      participant: existingResponse.participant || 'main',
      usedContext: patch.usedContext !== undefined ? patch.usedContext : existingResponse.usedContext,
      contentReferences: patch.contentReferences !== undefined
        ? patch.contentReferences
        : Array.isArray(existingResponse.contentReferences) ? existingResponse.contentReferences : [],
      codeCitations: patch.codeCitations !== undefined
        ? patch.codeCitations
        : Array.isArray(existingResponse.codeCitations) ? existingResponse.codeCitations : [],
      progressMessages: patch.progressMessages !== undefined
        ? patch.progressMessages
        : Array.isArray(existingResponse.progressMessages) ? existingResponse.progressMessages : [],
      continuation: patch.continuation !== undefined ? patch.continuation : existingResponse.continuation,
      status,
      terminationReason: patch.terminationReason !== undefined ? patch.terminationReason : existingResponse.terminationReason,
      parts,
      resultText,
      createdAt: existingResponse.createdAt || turn.createdAt || timestamp,
      updatedAt: timestamp,
    },
    usage: patch.usage !== undefined ? patch.usage : turn.usage,
    responseModel: patch.responseModel !== undefined ? patch.responseModel : turn.responseModel,
    updatedAt: timestamp,
  };
}

function normalizeResponsePartsForStatus(parts, status) {
  if (status !== 'completed' || !Array.isArray(parts) || parts.length === 0) {
    return parts;
  }

  return parts.filter(part => !isEmptyTextResponsePart(part));
}

function isEmptyTextResponsePart(part) {
  if (!part || typeof part !== 'object') {
    return false;
  }

  if (part.type !== 'markdown' && part.type !== 'thinking') {
    return false;
  }

  const content = typeof part.content === 'string' ? part.content : '';
  return content.trim().length === 0;
}

function materializeRenderEventTurn(turn, state, event) {
  if (!turn || typeof turn !== 'object') {
    return null;
  }
  const timestamp = normalizeTimestamp(event.timestamp);
  let parts = cloneParts(turn);
  let responsePatch = {};
  switch (event.type) {
    case 'turn_begin':
      return withResponsePatch(turn, timestamp, { parts, status: 'streaming' });
    case 'markdown_delta':
      parts = appendTextPart(parts, state, turn.turnId, event, 'markdown', event.text);
      return withResponsePatch(turn, timestamp, { parts, status: 'streaming' });
    case 'thinking_delta':
      parts = appendTextPart(parts, state, turn.turnId, event, 'thinking', event.text);
      return withResponsePatch(turn, timestamp, { parts, status: 'streaming' });
    case 'thinking_complete':
      parts = completeThinkingPart(parts, event);
      return withResponsePatch(turn, timestamp, { parts, status: 'streaming' });
    case 'tool_call_begin':
      parts = upsertToolBegin(parts, state, event);
      return withResponsePatch(turn, timestamp, { parts, status: 'streaming' });
    case 'tool_call_progress':
      parts = patchToolProgress(parts, event);
      parts = upsertTerminalPart(parts, event, normalizeCommandOutputProgress(event.data), true, 'delta');
      parts = upsertTerminalPart(parts, event, normalizeCommandSessionUpdate(event.data), false, 'snapshot');
      return withResponsePatch(turn, timestamp, { parts, status: 'streaming' });
    case 'tool_call_end':
      parts = patchToolEnd(parts, event);
      parts = upsertTerminalPart(parts, event, extractTerminalPartFromToolEnd(event), false, 'snapshot');
      return withResponsePatch(turn, timestamp, { parts, status: 'streaming' });
    case 'state_update':
      if (isSubagentStateUpdate(event)) {
        parts = upsertSubagentToolCallPart(parts, event);
        return withResponsePatch(turn, timestamp, { parts, status: 'streaming' });
      }
      parts = upsertStatePart(parts, event, {
        stateId: event.stateId,
        kind: event.kind,
        text: event.text,
        state: event.state,
        progress: event.progress,
        metadata: clonePayload(event.metadata),
      });
      return withResponsePatch(turn, timestamp, { parts, status: 'streaming' });
    case 'background_task_update':
      parts = upsertStatePart(parts, event, {
        stateId: event.stateId,
        kind: 'background_task',
        text: event.summary || event.error || event.output || event.description,
        state: event.state,
        progress: event.progress,
        metadata: {
          taskId: event.taskId,
          agentName: event.agentName,
          description: event.description,
          summary: event.summary,
          output: event.output,
          error: event.error,
          activity: clonePayload(event.activity),
        },
      });
      return withResponsePatch(turn, timestamp, { parts, status: 'streaming' });
    case 'todo_update': {
      const items = Array.isArray(event.items) ? event.items : [];
      const completed = items.filter(item => item && item.status === 'completed').length;
      const progress = items.length > 0 ? completed / items.length : undefined;
      const hasError = items.some(item => item && item.status === 'error');
      parts = upsertStatePart(parts, event, {
        stateId: `todo:${event.sessionId || turn.turnId}`,
        kind: 'todo',
        text: event.summary,
        state: hasError ? 'error' : items.length > 0 && completed === items.length ? 'done' : 'doing',
        progress,
        metadata: {
          sessionId: event.sessionId,
          items: clonePayload(items),
          completed,
          total: items.length,
        },
      });
      return withResponsePatch(turn, timestamp, { parts, status: 'streaming' });
    }
    case 'question_request':
      parts = upsertQuestionPart(parts, event);
      return withResponsePatch(turn, timestamp, { parts, status: 'streaming' });
    case 'approval_request':
      parts = upsertApprovalRequestPart(parts, event);
      return withResponsePatch(turn, timestamp, { parts, status: 'streaming' });
    case 'approval_resolve':
      parts = patchApprovalResolvePart(parts, event);
      return withResponsePatch(turn, timestamp, { parts, status: 'streaming' });
    case 'warning_notice':
      parts = appendNoticePart(parts, event, 'warning', event.message);
      return withResponsePatch(turn, timestamp, { parts, status: 'streaming' });
    case 'info_notice':
      parts = appendNoticePart(parts, event, 'info', event.message);
      return withResponsePatch(turn, timestamp, { parts, status: 'streaming' });
    case 'error_notice':
      parts = appendNoticePart(parts, event, 'error', event.message);
      return withResponsePatch(turn, timestamp, { parts, status: 'error', terminationReason: 'error' });
    case 'response_command':
      return withResponsePatch(turn, timestamp, {
        parts,
        status: 'streaming',
        responseModel: {
          ...(turn.responseModel && typeof turn.responseModel === 'object' ? turn.responseModel : {}),
          slashCommand: event.value,
        },
      });
    case 'response_reference': {
      const value = event.value && typeof event.value === 'object' ? clonePayload(event.value) : event.value;
      if (value && value.kind === 'usedContext') {
        return withResponsePatch(turn, timestamp, { parts, status: 'streaming', usedContext: value });
      }
      const existingReferences = Array.isArray(turn.response && turn.response.contentReferences)
        ? turn.response.contentReferences
        : [];
      return withResponsePatch(turn, timestamp, {
        parts,
        status: 'streaming',
        contentReferences: [...existingReferences, value],
      });
    }
    case 'response_code_citation': {
      const existingCitations = Array.isArray(turn.response && turn.response.codeCitations)
        ? turn.response.codeCitations
        : [];
      return withResponsePatch(turn, timestamp, {
        parts,
        status: 'streaming',
        codeCitations: [...existingCitations, clonePayload(event.value)],
      });
    }
    case 'response_progress_message': {
      const existingMessages = Array.isArray(turn.response && turn.response.progressMessages)
        ? turn.response.progressMessages
        : [];
      return withResponsePatch(turn, timestamp, {
        parts,
        status: 'streaming',
        progressMessages: [...existingMessages, clonePayload(event.value)],
      });
    }
    case 'response_followups':
      return withResponsePatch(turn, timestamp, {
        parts,
        status: 'streaming',
        responseModel: {
          ...(turn.responseModel && typeof turn.responseModel === 'object' ? turn.responseModel : {}),
          followups: event.value ? clonePayload(event.value) : undefined,
        },
      });
    case 'usage':
      if (event.scope === 'request') {
        return withResponsePatch(turn, timestamp, {
          parts,
          status: 'streaming',
          responseModel: {
            ...(turn.responseModel && typeof turn.responseModel === 'object' ? turn.responseModel : {}),
            requestUsage: {
              promptTokens: event.usage && event.usage.inputTokens,
              completionTokens: event.usage && event.usage.outputTokens,
              ...(event.usage && typeof event.usage.outputBuffer === 'number' ? { outputBuffer: event.usage.outputBuffer } : {}),
              ...(event.usage && Array.isArray(event.usage.promptTokenDetails) ? { promptTokenDetails: clonePayload(event.usage.promptTokenDetails) } : {}),
            },
          },
        });
      }
      return null;
    case 'clear_to_previous_tool_invocation':
      parts = clearToPreviousToolInvocation(parts);
      return withResponsePatch(turn, timestamp, { parts, status: 'streaming' });
    case 'subagent_begin':
      parts = upsertSubagentToolCallPart(parts, event, 'doing');
      return withResponsePatch(turn, timestamp, { parts, status: 'streaming' });
    case 'subagent_activity':
      parts = upsertSubagentActivityPart(parts, state, turn.turnId, event);
      return withResponsePatch(turn, timestamp, { parts, status: 'streaming' });
    case 'subagent_end':
      parts = upsertSubagentToolCallPart(parts, event);
      return withResponsePatch(turn, timestamp, { parts, status: 'streaming' });
    case 'turn_end':
      parts = completeThinkingPart(parts, event);
      {
        const planResult = materializePlanTurnParts(parts, turn);
        parts = planResult.parts;
        responsePatch = {
          parts,
          status: 'completed',
          ...(planResult.resultText !== undefined ? { resultText: planResult.resultText } : {}),
          usage: event.usage,
          continuation: event.continuation,
          terminationReason: event.terminationReason,
          responseModel: {
            ...(turn.responseModel && typeof turn.responseModel === 'object' ? turn.responseModel : {}),
            ...(event.modelName ? { modelName: event.modelName } : {}),
            ...(event.modelBillingLabel ? { modelBillingLabel: event.modelBillingLabel } : {}),
            ...(event.modelRouting ? { modelRouting: clonePayload(event.modelRouting) } : {}),
            ...(event.quotaSnapshot ? { quotaSnapshot: clonePayload(event.quotaSnapshot) } : {}),
          },
        };
        return withResponsePatch(turn, timestamp, responsePatch);
      }
    default:
      return null;
  }
}

function isSubagentParentToolPart(part) {
  const toolSpecificData = part && part.metadata && typeof part.metadata === 'object'
    && part.metadata.toolSpecificData && typeof part.metadata.toolSpecificData === 'object'
    ? part.metadata.toolSpecificData
    : null;
  return !!part
    && part.type === 'tool_call'
    && toolSpecificData
    && toolSpecificData.kind === 'subagent';
}

function isScopedSubagentChildPart(part) {
  if (!part || typeof part !== 'object' || isSubagentParentToolPart(part)) {
    return false;
  }
  const scope = readPartScope(part);
  return scope.sourceAgentRole === 'subagent'
    || typeof scope.parentToolCallId === 'string';
}

function recordSubagentModelInvariant(sessionId, turnId, turn) {
  const parts = Array.isArray(turn && turn.response && turn.response.parts)
    ? turn.response.parts
    : [];
  if (parts.length === 0) {
    return;
  }
  const parentIds = new Set(parts
    .filter(isSubagentParentToolPart)
    .map(part => normalizeOptionalString(part.toolCallId))
    .filter(Boolean));
  const orphanChildren = parts
    .map((part, index) => ({ part, index, scope: readPartScope(part) }))
    .filter(({ part, scope }) => {
      if (!isScopedSubagentChildPart(part)) {
        return false;
      }
      const parentId = normalizeOptionalString(scope.subAgentInvocationId)
        || normalizeOptionalString(scope.parentToolCallId);
      return !parentId || !parentIds.has(parentId);
    });
  if (orphanChildren.length === 0) {
    return;
  }
  console.warn('[AilyChat][SubagentModelInvariant]', JSON.stringify({
    sessionId,
    turnId,
    parentIds: [...parentIds],
    orphanChildren: orphanChildren.map(({ part, index, scope }) => ({
      index,
      type: part.type,
      partId: part.partId,
      toolCallId: part.toolCallId,
      toolName: part.toolName,
      scope,
    })),
  }));
}

function shouldRecordSubagentModelInvariant(event) {
  if (!event || typeof event !== 'object') {
    return false;
  }
  if (event.sourceAgentRole === 'subagent' || event.parentToolCallId || event.subAgentInvocationId) {
    return event.type !== 'markdown_delta'
      && event.type !== 'thinking_delta'
      && event.type !== 'thinking_complete';
  }
  switch (event.type) {
    case 'subagent_begin':
    case 'subagent_activity':
    case 'subagent_end':
    case 'tool_call_begin':
    case 'tool_call_end':
    case 'question_request':
    case 'approval_request':
    case 'approval_resolve':
      return true;
    case 'state_update':
      return isSubagentStateUpdate(event);
    default:
      return false;
  }
}

class ChatRuntimeHostTranscriptBuilder {
  constructor() {
    this.transcripts = new Map();
    this.renderEventStates = new Map();
  }

  clearSession(sessionId) {
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!normalizedSessionId) {
      return;
    }
    this.transcripts.delete(normalizedSessionId);
    for (const key of [...this.renderEventStates.keys()]) {
      if (key.startsWith(`${normalizedSessionId}\u0000`)) {
        this.renderEventStates.delete(key);
      }
    }
  }

  hasTranscript(sessionId) {
    const normalizedSessionId = normalizeSessionId(sessionId);
    return !!normalizedSessionId && this.transcripts.has(normalizedSessionId);
  }

  readSessionIds() {
    return [...this.transcripts.keys()];
  }

  readTranscriptRevision(sessionId) {
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!normalizedSessionId) {
      return 0;
    }
    return normalizeRevision(this.transcripts.get(normalizedSessionId)?.revision);
  }

  buildTranscriptSnapshot(sessionId) {
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!normalizedSessionId) {
      return null;
    }
    if (this.transcripts.has(normalizedSessionId)) {
      return clonePayload(this.transcripts.get(normalizedSessionId));
    }
    return {
      sessionId: normalizedSessionId,
      turnResponses: [],
      revision: 0,
    };
  }

  acceptTranscriptSnapshot(transcript) {
    const sessionId = normalizeSessionId(transcript && transcript.sessionId);
    if (!sessionId) {
      return null;
    }
    const revision = normalizeRevision(transcript.revision);
    const currentRevision = this.readTranscriptRevision(sessionId);
    if (revision < currentRevision) {
      return null;
    }
    const turnResponses = Array.isArray(transcript.turnResponses)
      ? transcript.turnResponses
      : [];
    const nextTranscript = {
      ...clonePayload(transcript),
      sessionId,
      revision,
      turnResponses: clonePayload(turnResponses),
    };
    this.transcripts.set(sessionId, clonePayload(nextTranscript));
    return clonePayload(nextTranscript);
  }

  acceptTurnSnapshot({ sessionId, turnId, revision, turn }) {
    const normalizedSessionId = normalizeSessionId(sessionId);
    const normalizedTurnId = normalizeTurnId(turnId);
    if (!normalizedSessionId || !normalizedTurnId || !turn || typeof turn !== 'object') {
      return null;
    }
    const turnSnapshot = clonePayload(turn);
    const snapshotTurnId = normalizeTurnId(turnSnapshot.turnId);
    if (snapshotTurnId && snapshotTurnId !== normalizedTurnId) {
      return null;
    }
    turnSnapshot.turnId = normalizedTurnId;

    const currentTranscript = this.buildTranscriptSnapshot(normalizedSessionId);
    const currentRevision = normalizeRevision(currentTranscript && currentTranscript.revision);
    const incomingRevision = normalizeRevision(revision);
    if (incomingRevision > 0 && incomingRevision < currentRevision) {
      return null;
    }

    const turnResponses = Array.isArray(currentTranscript && currentTranscript.turnResponses)
      ? clonePayload(currentTranscript.turnResponses)
      : [];
    const existingIndex = turnResponses.findIndex(existingTurn =>
      normalizeTurnId(existingTurn && existingTurn.turnId) === normalizedTurnId);
    if (existingIndex >= 0) {
      turnResponses[existingIndex] = turnSnapshot;
    } else {
      turnResponses.push(turnSnapshot);
    }

    const nextRevision = Math.max(currentRevision + 1, incomingRevision);
    const nextTranscript = {
      sessionId: normalizedSessionId,
      turnResponses,
      revision: nextRevision,
    };
    this.transcripts.set(normalizedSessionId, clonePayload(nextTranscript));
    return clonePayload(nextTranscript);
  }

  acceptRenderEvent({ sessionId, turnId, revision, request, event }) {
    const normalizedSessionId = normalizeSessionId(sessionId);
    const normalizedTurnId = normalizeTurnId(turnId);
    if (!normalizedSessionId || !normalizedTurnId || !isRenderEventLike(event)) {
      return null;
    }

    const currentTranscript = this.buildTranscriptSnapshot(normalizedSessionId);
    const currentRevision = normalizeRevision(currentTranscript && currentTranscript.revision);
    const incomingRevision = normalizeRevision(revision);

    const turnResponses = Array.isArray(currentTranscript && currentTranscript.turnResponses)
      ? clonePayload(currentTranscript.turnResponses)
      : [];
    let turnIndex = turnResponses.findIndex(existingTurn =>
      normalizeTurnId(existingTurn && existingTurn.turnId) === normalizedTurnId);
    if (turnIndex < 0) {
      const seeded = buildSubmittedTurnSeed({
        turnId: normalizedTurnId,
        request,
        timestamp: normalizeTimestamp(event.timestamp),
      });
      turnResponses.push(seeded);
      turnIndex = turnResponses.length - 1;
    }

    const state = this.readRenderEventState(normalizedSessionId, normalizedTurnId, turnResponses[turnIndex]);
    const routedEvent = routeRenderEventForSubagentScope(state, event);
    const nextTurn = materializeRenderEventTurn(turnResponses[turnIndex], state, routedEvent);
    if (!nextTurn) {
      return null;
    }
    if (shouldRecordSubagentModelInvariant(routedEvent)) {
      recordSubagentModelInvariant(normalizedSessionId, normalizedTurnId, nextTurn);
    }

    turnResponses[turnIndex] = nextTurn;
    const nextRevision = Math.max(currentRevision + 1, incomingRevision);
    const nextTranscript = {
      sessionId: normalizedSessionId,
      turnResponses,
      revision: nextRevision,
    };
    this.transcripts.set(normalizedSessionId, clonePayload(nextTranscript));
    this.renderEventStates.set(renderEventStateKey(normalizedSessionId, normalizedTurnId), state);
    return clonePayload(nextTranscript);
  }

  readRenderEventState(sessionId, turnId, turn) {
    const key = renderEventStateKey(sessionId, turnId);
    const existing = this.renderEventStates.get(key);
    if (existing) {
      return existing;
    }
    const state = {
      activeTextKind: null,
      toolPartIds: new Map(),
      activeSubagentScopes: [],
    };
    const parts = Array.isArray(turn && turn.response && turn.response.parts)
      ? turn.response.parts
      : [];
    for (const part of parts) {
      if (part && part.type === 'tool_call' && part.toolCallId) {
        state.toolPartIds.set(part.toolCallId, part.partId || `tool:${part.toolCallId}`);
      }
    }
    this.renderEventStates.set(key, state);
    return state;
  }

  replaceTurnId({ sessionId, fromTurnId, toTurnId, revision }) {
    const normalizedSessionId = normalizeSessionId(sessionId);
    const normalizedFromTurnId = normalizeTurnId(fromTurnId);
    const normalizedToTurnId = normalizeTurnId(toTurnId);
    if (!normalizedSessionId || !normalizedFromTurnId || !normalizedToTurnId) {
      return null;
    }
    if (normalizedFromTurnId === normalizedToTurnId) {
      return this.buildTranscriptSnapshot(normalizedSessionId);
    }

    const currentTranscript = this.buildTranscriptSnapshot(normalizedSessionId);
    const turnResponses = Array.isArray(currentTranscript && currentTranscript.turnResponses)
      ? clonePayload(currentTranscript.turnResponses)
      : [];
    const fromIndex = turnResponses.findIndex(existingTurn =>
      normalizeTurnId(existingTurn && existingTurn.turnId) === normalizedFromTurnId);
    if (fromIndex < 0) {
      return null;
    }

    const toIndex = turnResponses.findIndex(existingTurn =>
      normalizeTurnId(existingTurn && existingTurn.turnId) === normalizedToTurnId);
    if (toIndex >= 0) {
      turnResponses.splice(fromIndex, 1);
    } else {
      const existingTurn = turnResponses[fromIndex];
      const existingResponse = existingTurn && existingTurn.response && typeof existingTurn.response === 'object'
        ? existingTurn.response
        : {};
      turnResponses[fromIndex] = {
        ...existingTurn,
        turnId: normalizedToTurnId,
        response: {
          ...existingResponse,
          id: normalizedToTurnId,
        },
      };
    }

    const currentRevision = normalizeRevision(currentTranscript && currentTranscript.revision);
    const incomingRevision = normalizeRevision(revision);
    const nextTranscript = {
      sessionId: normalizedSessionId,
      turnResponses,
      revision: Math.max(currentRevision + 1, incomingRevision),
    };
    this.transcripts.set(normalizedSessionId, clonePayload(nextTranscript));
    return clonePayload(nextTranscript);
  }

  seedSubmittedTurn({ sessionId, turnId, request, revision, timestamp, protocolTruncation }) {
    const normalizedSessionId = normalizeSessionId(sessionId);
    const normalizedTurnId = normalizeTurnId(turnId);
    if (!normalizedSessionId || !normalizedTurnId) {
      return null;
    }
    const currentTranscript = this.buildTranscriptSnapshot(normalizedSessionId);
    const turnResponses = Array.isArray(currentTranscript && currentTranscript.turnResponses)
      ? clonePayload(currentTranscript.turnResponses)
      : [];
    const normalizedTruncation = normalizeProtocolTruncation(protocolTruncation);
    if (normalizedTruncation) {
      const removeFromIndex = turnResponses.findIndex(existingTurn =>
        normalizeTurnId(existingTurn && existingTurn.turnId) === normalizedTruncation.turnId);
      if (removeFromIndex >= 0) {
        const removedTurns = turnResponses.splice(removeFromIndex);
        for (const removedTurn of removedTurns) {
          const removedTurnId = normalizeTurnId(removedTurn && removedTurn.turnId);
          if (removedTurnId) {
            this.renderEventStates.delete(renderEventStateKey(normalizedSessionId, removedTurnId));
          }
        }
      }
    }
    const turn = buildSubmittedTurnSeed({
      turnId: normalizedTurnId,
      request,
      timestamp: typeof timestamp === 'number' && Number.isFinite(timestamp) ? timestamp : Date.now(),
    });

    const existingIndex = turnResponses.findIndex(existingTurn =>
      normalizeTurnId(existingTurn && existingTurn.turnId) === normalizedTurnId);
    if (existingIndex >= 0) {
      turnResponses[existingIndex] = turn;
    } else {
      turnResponses.push(turn);
    }

    const currentRevision = normalizeRevision(currentTranscript && currentTranscript.revision);
    const incomingRevision = normalizeRevision(revision);
    const nextTranscript = {
      sessionId: normalizedSessionId,
      turnResponses,
      revision: Math.max(currentRevision + 1, incomingRevision),
    };
    this.transcripts.set(normalizedSessionId, clonePayload(nextTranscript));
    return clonePayload(nextTranscript);
  }

  markTurnFailed({ sessionId, turnId, revision, error }) {
    const normalizedSessionId = normalizeSessionId(sessionId);
    const normalizedTurnId = normalizeTurnId(turnId);
    if (!normalizedSessionId || !normalizedTurnId) {
      return null;
    }
    const currentTranscript = this.buildTranscriptSnapshot(normalizedSessionId);
    const turnResponses = Array.isArray(currentTranscript && currentTranscript.turnResponses)
      ? clonePayload(currentTranscript.turnResponses)
      : [];
    const existingIndex = turnResponses.findIndex(existingTurn =>
      normalizeTurnId(existingTurn && existingTurn.turnId) === normalizedTurnId);
    if (existingIndex < 0) {
      return null;
    }
    const timestamp = Date.now();
    const existingTurn = turnResponses[existingIndex];
    const existingResponse = existingTurn.response && typeof existingTurn.response === 'object'
      ? existingTurn.response
      : {};
    const existingParts = Array.isArray(existingResponse.parts)
      ? existingResponse.parts.filter(part => part && part.partId !== 'runtime-host-error')
      : [];
    const errorPart = buildErrorPart(error);
    const nextTurn = {
      ...existingTurn,
      response: {
        ...existingResponse,
        status: 'error',
        terminationReason: 'error',
        parts: [...existingParts, errorPart],
        resultText: errorPart.message,
        updatedAt: timestamp,
      },
      updatedAt: timestamp,
    };
    turnResponses[existingIndex] = nextTurn;

    const currentRevision = normalizeRevision(currentTranscript && currentTranscript.revision);
    const incomingRevision = normalizeRevision(revision);
    const nextRevision = Math.max(currentRevision + 1, incomingRevision);
    const nextTranscript = {
      sessionId: normalizedSessionId,
      turnResponses,
      revision: nextRevision,
    };
    this.transcripts.set(normalizedSessionId, clonePayload(nextTranscript));
    return clonePayload(nextTranscript);
  }

  cancelTurn({ sessionId, turnId, revision, timestamp }) {
    const normalizedSessionId = normalizeSessionId(sessionId);
    const normalizedTurnId = normalizeTurnId(turnId);
    if (!normalizedSessionId || !normalizedTurnId) {
      return null;
    }
    const currentTranscript = this.buildTranscriptSnapshot(normalizedSessionId);
    const turnResponses = Array.isArray(currentTranscript && currentTranscript.turnResponses)
      ? clonePayload(currentTranscript.turnResponses)
      : [];
    const existingIndex = turnResponses.findIndex(existingTurn =>
      normalizeTurnId(existingTurn && existingTurn.turnId) === normalizedTurnId);
    if (existingIndex < 0) {
      return null;
    }
    const nextTimestamp = normalizeTimestamp(timestamp);
    const existingTurn = turnResponses[existingIndex];
    const existingResponse = existingTurn.response && typeof existingTurn.response === 'object'
      ? existingTurn.response
      : {};
    const existingParts = Array.isArray(existingResponse.parts)
      ? existingResponse.parts
      : [];
    const nextParts = existingParts.map(part => cancelOpenResponsePart(part, nextTimestamp));
    const nextTurn = {
      ...existingTurn,
      response: {
        ...existingResponse,
        status: 'cancelled',
        terminationReason: 'cancelled',
        parts: nextParts,
        updatedAt: nextTimestamp,
      },
      updatedAt: nextTimestamp,
    };
    turnResponses[existingIndex] = nextTurn;

    const currentRevision = normalizeRevision(currentTranscript && currentTranscript.revision);
    const incomingRevision = normalizeRevision(revision);
    const nextRevision = Math.max(currentRevision + 1, incomingRevision);
    const nextTranscript = {
      sessionId: normalizedSessionId,
      turnResponses,
      revision: nextRevision,
    };
    this.transcripts.set(normalizedSessionId, clonePayload(nextTranscript));
    return clonePayload(nextTranscript);
  }
}

module.exports = {
  ChatRuntimeHostTranscriptBuilder,
};
