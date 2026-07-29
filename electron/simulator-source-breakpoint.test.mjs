import assert from 'node:assert/strict';
import test from 'node:test';

import {
  hasDebugStoppedContextChanged,
  prepareArtifactSourceBreakpointForGateway,
} from '../src/app/tools/simulator/simulator-editor/simulator-source-breakpoint.ts';

const revision = 'a'.repeat(64);
const artifact = {
  file: 'sketch.ino',
  revision,
  sizeBytes: 230,
  content: Array.from(
    { length: 30 },
    (_, index) => `line ${index + 1}`,
  ).join('\n'),
};

test('accepts a visible current-Artifact line and strips the iframe revision', () => {
  assert.deepEqual(
    prepareArtifactSourceBreakpointForGateway(
      {
        kind: 'source',
        file: 'sketch.ino',
        line: 17,
        sourceRevision: revision,
      },
      'stopped',
      { file: 'sketch.ino', line: 15 },
      artifact,
    ),
    {
      kind: 'source',
      file: 'sketch.ino',
      line: 17,
    },
  );
});

test('rejects stale, external and off-context iframe gutter requests', () => {
  const request = {
    kind: 'source',
    file: 'sketch.ino',
    line: 17,
    sourceRevision: revision,
  };
  assert.throws(
    () => prepareArtifactSourceBreakpointForGateway(
      { ...request, sourceRevision: 'b'.repeat(64) },
      'stopped',
      { file: 'sketch.ino', line: 15 },
      artifact,
    ),
    /上下文已失效/,
  );
  assert.throws(
    () => prepareArtifactSourceBreakpointForGateway(
      request,
      'stopped',
      { file: 'esp32-hal-misc.c', line: 213 },
      artifact,
    ),
    /上下文已失效/,
  );
  assert.throws(
    () => prepareArtifactSourceBreakpointForGateway(
      { ...request, line: 27 },
      'stopped',
      { file: 'sketch.ino', line: 15 },
      artifact,
    ),
    /上下文已失效/,
  );
});

test('keeps the existing manual source-breakpoint form compatible', () => {
  assert.deepEqual(
    prepareArtifactSourceBreakpointForGateway(
      { kind: 'source', file: 'src/sketch.ino', line: 4 },
      'running',
      null,
      null,
    ),
    {
      kind: 'source',
      file: 'src/sketch.ino',
      line: 4,
    },
  );
});

test('does not rebuild variable handles for a breakpoint-only stopped update', () => {
  const stopped = {
    state: 'stopped',
    frame: {
      level: 0,
      address: '0x42000010',
      functionName: 'loop',
      location: { file: 'sketch.ino', line: 15 },
      blockId: 'debug-loop-break',
    },
  };
  assert.equal(
    hasDebugStoppedContextChanged(
      stopped,
      {
        ...stopped,
        breakpoints: [{ id: 2 }],
      },
    ),
    false,
  );
  assert.equal(
    hasDebugStoppedContextChanged(
      stopped,
      {
        ...stopped,
        frame: {
          ...stopped.frame,
          address: '0x42000014',
          location: { file: 'sketch.ino', line: 17 },
          blockId: 'debug-delay-block',
        },
      },
    ),
    true,
  );
});
