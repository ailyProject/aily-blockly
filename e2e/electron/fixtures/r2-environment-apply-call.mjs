import assert from "node:assert/strict";

export function assertEnvironmentApplyCall(call, project, absPath) {
  assert.equal(call?.type, "toolCall");
  assert.equal(call.name, "abs_apply");
  assert.deepEqual(call.arguments, { project, absPath });
}
