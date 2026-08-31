'use strict';

const CONNECTOR_OPERATIONS = new Set([
  'project.sync',
  'run.file',
  'run.stop',
]);

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function normalizeConnectParams(value) {
  const params = requireRecord(value, 'Connector options');
  const transport = params.transport;
  if (transport !== 'ssh' && transport !== 'serial') {
    throw invalid('Connector transport must be ssh or serial');
  }
  const endpoint = requireRecord(params.endpoint, 'Connector endpoint');
  const credentials = params.credentials === undefined
    ? undefined
    : requireRecord(params.credentials, 'Connector credentials');

  if (transport === 'ssh') {
    requireText(endpoint.host, 'SSH host', 255);
    requireText(endpoint.username, 'SSH username', 255);
    const port = endpoint.port ?? 22;
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw invalid('SSH port is invalid');
    }
    if (endpoint.hostKeyPolicy !== 'strict') {
      throw invalid('SSH host-key verification must use strict mode');
    }
  } else {
    requireText(endpoint.port, 'Serial port', 1024);
    const baudRate = endpoint.baudRate ?? 115200;
    if (!Number.isInteger(baudRate) || baudRate < 300 || baudRate > 4_000_000) {
      throw invalid('Serial baud rate is invalid');
    }
  }

  return { transport, endpoint, ...(credentials ? { credentials } : {}) };
}

function normalizeSessionRequest(value) {
  const params = requireRecord(value, 'Connector request');
  const sessionId = normalizeSessionId(params.sessionId);
  const operation = String(params.operation || '');
  if (!CONNECTOR_OPERATIONS.has(operation)) {
    throw invalid(`Connector operation is not allowed: ${operation || '(empty)'}`);
  }
  const payload = params.payload === undefined
    ? {}
    : requireRecord(params.payload, 'Connector request payload');
  const timeoutMs = params.timeoutMs;
  if (
    timeoutMs !== undefined
    && (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 4 * 60 * 60 * 1_000)
  ) {
    throw invalid('Connector request timeout is invalid');
  }
  return { sessionId, operation, payload, ...(timeoutMs === undefined ? {} : { timeoutMs }) };
}

function normalizeDisconnectParams(value) {
  const params = requireRecord(value, 'Connector disconnect request');
  return { sessionId: normalizeSessionId(params.sessionId) };
}

function assertSessionResult(value, expectedTransport) {
  const session = requireRecord(value, 'Connector session result');
  const sessionId = normalizeSessionId(session.sessionId);
  if (session.transport !== expectedTransport) {
    throw invalid('Connector returned an unexpected transport');
  }
  if (session.status !== undefined) requireRecord(session.status, 'Connector session status');
  if (session.capabilities !== undefined && session.capabilities !== null) {
    requireRecord(session.capabilities, 'Connector session capabilities');
  }
  return { ...session, sessionId };
}

function normalizeSessionId(value) {
  const sessionId = String(value || '');
  if (!SESSION_ID.test(sessionId)) throw invalid('Connector session id is invalid');
  return sessionId;
}

function requireRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid(`${label} must be an object`);
  }
  return value;
}

function requireText(value, label, maxLength) {
  if (
    typeof value !== 'string'
    || !value.trim()
    || value.length > maxLength
    || value.includes('\0')
  ) {
    throw invalid(`${label} is invalid`);
  }
}

function invalid(message) {
  const error = new TypeError(message);
  error.code = 'INVALID_REQUEST';
  return error;
}

module.exports = {
  assertSessionResult,
  normalizeConnectParams,
  normalizeDisconnectParams,
  normalizeSessionRequest,
};
