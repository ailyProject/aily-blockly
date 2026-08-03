'use strict';

const DEFAULT_MAX_MESSAGE_BYTES = 1024 * 1024;
const MIN_MAX_MESSAGE_BYTES = 1024;
const MAX_MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
const MAX_MESSAGE_DEPTH = 64;

function normalizeProcessMessagePortConfig(value) {
  if (value === undefined || value === null || value === false) {
    return null;
  }
  if (!isPlainRecord(value)) {
    throw new Error('Process message port config must be an object.');
  }
  if (value.transport !== 'node-ipc-v1') {
    throw new Error('Process message port transport must be node-ipc-v1.');
  }
  const maxMessageBytes = value.maxMessageBytes === undefined
    ? DEFAULT_MAX_MESSAGE_BYTES
    : Number(value.maxMessageBytes);
  if (
    !Number.isInteger(maxMessageBytes)
    || maxMessageBytes < MIN_MAX_MESSAGE_BYTES
    || maxMessageBytes > MAX_MAX_MESSAGE_BYTES
  ) {
    throw new Error(
      `Process message port maxMessageBytes must be an integer between ${MIN_MAX_MESSAGE_BYTES} and ${MAX_MAX_MESSAGE_BYTES}.`,
    );
  }
  return Object.freeze({
    transport: 'node-ipc-v1',
    maxMessageBytes,
  });
}

function normalizeProcessMessage(message, maxMessageBytes = DEFAULT_MAX_MESSAGE_BYTES) {
  if (!isPlainRecord(message)) {
    throw new Error('Process message must be a plain object.');
  }
  validateJsonValue(message, new Set(), 0);
  const serialized = JSON.stringify(message);
  const sizeBytes = Buffer.byteLength(serialized, 'utf8');
  if (sizeBytes > maxMessageBytes) {
    throw new Error(`Process message exceeds the ${maxMessageBytes} byte limit.`);
  }
  return {
    message: JSON.parse(serialized),
    sizeBytes,
  };
}

function validateJsonValue(value, ancestors, depth) {
  if (depth > MAX_MESSAGE_DEPTH) {
    throw new Error(`Process message exceeds the ${MAX_MESSAGE_DEPTH} level depth limit.`);
  }
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
  ) {
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('Process message numbers must be finite.');
    }
    return;
  }
  if (Array.isArray(value)) {
    enterContainer(value, ancestors);
    for (const item of value) {
      validateJsonValue(item, ancestors, depth + 1);
    }
    ancestors.delete(value);
    return;
  }
  if (!isPlainRecord(value)) {
    throw new Error('Process message contains a non-JSON value.');
  }
  enterContainer(value, ancestors);
  for (const item of Object.values(value)) {
    validateJsonValue(item, ancestors, depth + 1);
  }
  ancestors.delete(value);
}

function enterContainer(value, ancestors) {
  if (ancestors.has(value)) {
    throw new Error('Process message must not contain a cycle.');
  }
  ancestors.add(value);
}

function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

module.exports = {
  DEFAULT_MAX_MESSAGE_BYTES,
  MAX_MAX_MESSAGE_BYTES,
  MIN_MAX_MESSAGE_BYTES,
  normalizeProcessMessage,
  normalizeProcessMessagePortConfig,
};
