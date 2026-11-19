import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { assertEnvironmentApplyCall } from "./r2-environment-apply-call.mjs";

const directory = process.env.AILY_R2_ENVIRONMENT_ABC_RESULT;
if (!directory)
  test(
    "actual preserved apply call fixture required",
    { skip: true },
    () => {},
  );
else {
  const session = JSON.parse(
    await fs.readFile(path.join(directory, "session-ABC.json"), "utf8"),
  );
  const call = session.messages
    .filter((message) => message.role === "assistant")
    .flatMap((message) => message.content ?? [])
    .find(
      (part) => part.type === "toolCall" && part.id === "env-resume-apply-ABC",
    );
  const project = session.cwd,
    absPath = path.join(project, "project.abs");
  test("actual persisted flattened abs_apply call has exactly the intended project/path and no generation", () =>
    assertEnvironmentApplyCall(call, project, absPath));
  for (const [name, changed] of [
    ["explicit generation", { ...call.arguments, generation: "foreign" }],
    [
      "foreign project",
      { ...call.arguments, project: path.join(project, "foreign") },
    ],
    ["missing path", { project }],
  ])
    test("apply call assertion rejects " + name, () =>
      assert.throws(() =>
        assertEnvironmentApplyCall(
          { ...call, arguments: changed },
          project,
          absPath,
        ),
      ),
    );
}
