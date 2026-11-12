import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { loadEnvironmentResume } from "./r2-environment-resume.mjs";

// File-only qualification against the exact preserved failed suite. No HOST,
// runtime worker, project mutation, restoration or replacement receipt occurs.
const resultFile = process.env.AILY_R2_ENVIRONMENT_RESUME_FIXTURE;
if (!resultFile)
  test(
    "exact preserved Env suite required for file-only resume qualification",
    { skip: true },
    () => {},
  );
else {
  const previous = JSON.parse(await fs.readFile(resultFile, "utf8"));
  const lexRoot =
    process.env.AILY_R2_ENVIRONMENT_RESUME_LEX_ROOT ?? "D:/codes/aily-lex-pro";
  const { capturePublicationAttachment, samePublicationAttachment } =
    await import(
      pathToFileURL(
        path.join(
          lexRoot,
          "packages/aily-agent/dist/blockly/services/project/publication-observation.js",
        ),
      )
    );
  const { captureDependencyEnvironmentTree, dependencyEnvironmentFiles } =
    await import(
      pathToFileURL(
        path.join(
          lexRoot,
          "packages/aily-agent/dist/extensions/pi-workspace-history/dependency-environment.js",
        ),
      )
    );
  const options = {
    resultFile,
    testRoot: path.dirname(previous.suite),
    artifact: previous.artifact,
    hostHash: previous.hostHash,
    capturePublicationAttachment,
    samePublicationAttachment,
    captureDependencyEnvironmentTree,
    dependencyEnvironmentFiles,
  };
  test("exact failed raw result, Pi branch, complete Store/native facts and physical C/environment preconditions are readonly-verifiable", async () => {
    const result = await loadEnvironmentResume(options);
    assert.equal(result.provenance.originalResultModified, false);
    assert.equal(result.provenance.priorLibraryAndBoardReplayed, false);
    assert.equal(result.provenance.standalonePass, false);
    assert.equal(result.sessionId, previous.startup.ready.sessionId);
    assert.equal(result.record.saveRequest.state, "completed");
    assert.equal(result.originalToolCallIds.includes("env-select-board"), true);
  });
  for (const [name, change] of [
    ["already successful original", (raw) => (raw.ok = true)],
    [
      "different portable artifact",
      (raw) => (raw.artifact.inputHash = "0".repeat(64)),
    ],
    ["different HOST ASAR", (raw) => (raw.hostHash = "0".repeat(64))],
    [
      "foreign suite",
      (raw) =>
        (raw.suite = path.join(
          path.dirname(raw.suite),
          "r2-environment-foreign",
        )),
    ],
    [
      "foreign session branch",
      (raw) => (raw.startup.ready.sessionId = "foreign-session"),
    ],
    [
      "altered original A archive identity",
      (raw) => (raw.privateA.hash = "sha256:" + "0".repeat(64)),
    ],
    [
      "replaced original intent generation",
      (raw) => (raw.s0.generation = "foreign-generation"),
    ],
  ])
    test("resume rejects " + name, async (t) => {
      const directory = await fs.mkdtemp(
          path.join(os.tmpdir(), "r2-env-resume-negative-"),
        ),
        copy = path.join(directory, "result.json");
      t.after(async () => {
        assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
        assert.ok(
          path.basename(directory).startsWith("r2-env-resume-negative-"),
        );
        await fs.rm(directory, { recursive: true, force: true });
      });
      const raw = structuredClone(previous);
      change(raw);
      await fs.writeFile(copy, JSON.stringify(raw));
      await fs.copyFile(
        path.join(path.dirname(resultFile), "failure-session.json"),
        path.join(directory, "failure-session.json"),
      );
      await assert.rejects(
        loadEnvironmentResume({ ...options, resultFile: copy }),
      );
    });
}
