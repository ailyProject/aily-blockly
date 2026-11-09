import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { loadEnvironmentSaveResume } from "./r2-environment-resume.mjs";

const directory = process.env.AILY_R2_ENVIRONMENT_ABC_RESULT;
if (!directory)
  test("actual committed ABC result required", { skip: true }, () => {});
else {
  const resultFile = path.join(directory, "result.json"),
    previous = JSON.parse(await fs.readFile(resultFile, "utf8"));
  const options = {
    resultFile,
    testRoot: path.dirname(previous.suite),
    artifact: previous.artifact,
    hostHash: previous.hostHash,
  };
  test("save-only preflight reads exact 17+02 provenance, actual flattened call/native commit and current full ABC without tools", async () => {
    const value = await loadEnvironmentSaveResume(options);
    assert.equal(value.provenance.previousABCCommitted, true);
    assert.equal(value.provenance.toolsReplayed, false);
    assert.equal(value.provenance.standalonePass, false);
    assert.equal(value.sessionId, previous.resumedProvenance.originalSessionId);
  });
  for (const [name, change] of [
    ["successful previous raw", (raw) => (raw.ok = true)],
    ["different artifact", (raw) => (raw.artifact.outputHash = "0".repeat(64))],
    ["different ASAR", (raw) => (raw.hostHash = "0".repeat(64))],
    ["already saved GUI tail", (raw) => (raw.uiSave = [])],
    [
      "different original17 hash",
      (raw) =>
        (raw.resumedProvenance.originalResultHash = "sha256:" + "0".repeat(64)),
    ],
    [
      "uncommitted source",
      (raw) =>
        (raw.tools.find(
          (tool) => tool.id === "env-resume-apply-ABC",
        ).result.ok = false),
    ],
    [
      "replaced original generation",
      (raw) =>
        (raw.tools.find(
          (tool) => tool.id === "env-resume-apply-ABC",
        ).result.receipt.intentGeneration = "foreign-generation"),
    ],
  ])
    test("save-only preflight rejects " + name, async (t) => {
      const temporary = await fs.mkdtemp(
          path.join(os.tmpdir(), "r2-save-tail-negative-"),
        ),
        file = path.join(temporary, "result.json");
      t.after(async () => {
        assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()));
        assert.ok(
          path.basename(temporary).startsWith("r2-save-tail-negative-"),
        );
        await fs.rm(temporary, { recursive: true, force: true });
      });
      const raw = structuredClone(previous);
      change(raw);
      await fs.writeFile(file, JSON.stringify(raw));
      await fs.copyFile(
        path.join(directory, "session-ABC.json"),
        path.join(temporary, "session-ABC.json"),
      );
      await assert.rejects(
        loadEnvironmentSaveResume({ ...options, resultFile: file }),
      );
    });
}
