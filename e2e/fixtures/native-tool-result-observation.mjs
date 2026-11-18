import assert from 'node:assert/strict';
import { resolve } from 'node:path';

// Inspect actual Chat SDK messages. This does not synthesize a tool result,
// authorize commands, write a candidate, or infer success from assistant prose.
export function nativeToolResults(snapshot, initialUsers = 0) {
  let users = 0;
  const start = snapshot.messages.findIndex(
    (message) => message.role === 'user' && ++users === initialUsers + 1,
  );
  assert.ok(start >= 0, 'The actual submitted user turn must exist');
  const messages = snapshot.messages.slice(start);
  const replies = new Map(
    messages
      .filter((message) => message.role === 'toolResult')
      .map((message) => [message.toolCallId, message]),
  );
  return messages
    .filter((message) => message.role === 'assistant')
    .flatMap((message) => message.content ?? [])
    .filter((part) => part.type === 'toolCall')
    .map((call) => {
      const message = replies.get(call.id);
      let result = message?.details?.result;
      if (!result) {
        try {
          result = JSON.parse(
            (message?.content ?? [])
              .filter((part) => part.type === 'text')
              .map((part) => part.text)
              .join('\n'),
          );
        } catch {
          // Native stdout is not necessarily JSON.
        }
      }
      return {
        call,
        message,
        result,
        name: call.name === 'tool_invoke' ? call.arguments?.name : call.name,
      };
    });
}

export function assertNativeInputEffect(tool, project, expected, readEffects) {
  assert.ok(tool?.message, 'The actual tool result must be present');
  const key = (value) => {
    if (typeof value !== 'string') return undefined;
    const canonical = resolve(value);
    return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
  };
  // The shared verifier also accepts its complete typed error envelope when
  // the SDK carries a thrown tool result in content instead of details.
  // Accept a protocol reader; do not parse arbitrary process stdout as facts.
  const effects = readEffects
    ? readEffects(tool.message)
    : (tool.message.details?.projectInputEffects ?? []);
  assert.ok(
    effects.some(
      (effect) => key(effect.project) === key(project) && effect.status === expected,
    ),
    `${tool.name} must report the actual ${expected} project input effect`,
  );
  return effects;
}

export function assertNativeCommandsOnce(tools, planned) {
  const native = tools.filter((tool) => ['bash', 'powershell'].includes(tool.name));
  for (const { name, command } of planned) {
    assert.equal(
      native.filter(
        (tool) => tool.name === name && tool.call.arguments?.command === command,
      ).length,
      1,
      'Each exact planned command must occur once in the actual SDK messages',
    );
  }
  return native;
}

export function nativeHistoryCheckpoint(snapshot) {
  const checkpoint = snapshot.entries.findLast(
    (entry) => entry.type === 'custom' && entry.customType === 'aily.workspace-history',
  )?.data;
  assert.ok(checkpoint?.checkpointId && Array.isArray(checkpoint.changedPaths));
  return checkpoint;
}

// Read the two real settlement projections without treating canvas persistence
// as proof that an unapplied candidate was committed.
export function nativeSaveProjections(snapshot, initialUsers = 0) {
  let users = 0;
  const start = snapshot.entries.findIndex(
    (entry) =>
      entry.type === 'message' &&
      entry.message.role === 'user' &&
      ++users === initialUsers + 1,
  );
  assert.ok(start >= 0, 'The actual submitted user turn must exist');
  const cards = snapshot.entries
    .slice(start + 1)
    .filter((entry) => entry.type === 'custom_message')
    .map((entry) => entry.details);
  return {
    canvas: cards.findLast((details) => details?.operation === 'project_persistence'),
    candidate: cards.findLast((details) => details?.operation === 'project_verification'),
  };
}

export function assertNativeSaveProjections(projections, expected) {
  const projectKey = (value) => {
    const canonical = resolve(value);
    return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
  };
  assert.equal(projectKey(projections.canvas?.project), projectKey(expected.project));
  assert.equal(projections.canvas?.verification?.scope, 'current-canvas-save');
  assert.equal(projections.canvas.verification.status, expected.canvas);
  assert.equal(projections.canvas.verification.ok, expected.canvas === 'saved');
  if (expected.candidate !== undefined) {
    assert.ok(projections.candidate, 'The actual candidate verification card must exist');
    assert.equal(projectKey(projections.candidate.project), projectKey(expected.project));
    assert.equal(projections.candidate.turnId, projections.canvas.turnId);
    assert.equal(projections.candidate.save, expected.candidate);
  }
  return projections;
}
