import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { upgradeInstalledChatProfileTarget } from "./r2-installed-profile-upgrade.mjs";

const { hashFiles, digest, verifyPortableBuild } = await import(
  pathToFileURL(
    path.resolve(
      "../aily-lex-pro/packages/aily-chat/server/portable-integrity.ts",
    ),
  )
);
async function fixture(t) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "r2-profile-upgrade-"),
  );
  t.after(async () => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.match(path.basename(directory), /^r2-profile-upgrade-/);
    await fs.rm(directory, { recursive: true, force: true });
  });
  const ownedTestRoot = path.join(directory, "aily-project/dev-tests/cohort"),
    suite = path.join(ownedTestRoot, "r2-board-cold-original"),
    appData = path.join(suite, "appdata");
  const link = path.join(
    appData,
    "npm-global/app/node_modules/@aily-project/subapp-aily-chat",
  );
  await fs.mkdir(path.dirname(link), { recursive: true });
  const artifact = async (name) => {
    const root = path.join(directory, name);
    for (const part of ["server", "runtime", "ui", "i18n", "vendor"]) {
      await fs.mkdir(path.join(root, part), { recursive: true });
      await fs.writeFile(
        path.join(root, part, "actual.js"),
        `// ${name}/${part}\n`,
      );
    }
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({
        name: "@aily-project/subapp-aily-chat",
        ailyPortable: { format: "js" },
        version: name,
      }),
    );
    const inputs = { "original-source.ts": digest(name) },
      outputs = await hashFiles(root, [
        "package.json",
        "server",
        "runtime",
        "ui",
        "i18n",
        "vendor",
      ]);
    const inputHash = digest(JSON.stringify(inputs)),
      outputHash = digest(JSON.stringify(outputs));
    await fs.writeFile(
      path.join(root, "runtime/build-evidence.json"),
      JSON.stringify({
        version: 1,
        inputHash,
        outputHash,
        buildTime: "2026-11-08T00:00:00Z",
        inputs,
        outputs,
      }),
    );
    await verifyPortableBuild(root);
    return { root, inputHash, outputHash };
  };
  const from = await artifact("chat-11"),
    to = await artifact("chat-12");
  await fs.symlink(
    from.root,
    link,
    process.platform === "win32" ? "junction" : "dir",
  );
  const sentinels = new Map([
    [
      path.join(appData, "config.json"),
      '{"recentlyProjects":["original-root"],"selectedSession":"same-branch-user2"}',
    ],
    [path.join(appData, ".aily"), '{"token":"original-synthetic-identity"}'],
    [
      path.join(suite, "home/.aily-chat/sessions/original.jsonl"),
      '{"id":"original-user1"}\n{"id":"original-failed-user2"}\n',
    ],
    [
      path.join(suite, "home/.aily-chat/ui-preferences/selected.json"),
      '{"session":"original"}',
    ],
  ]);
  for (const [file, body] of sentinels) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, body);
  }
  const preserved = async () => {
    for (const [file, body] of sentinels)
      assert.equal(await fs.readFile(file, "utf8"), body);
    await verifyPortableBuild(from.root);
    await verifyPortableBuild(to.root);
  };
  return {
    options: { appData, suite, ownedTestRoot, from, to, verifyPortableBuild },
    directory,
    link,
    preserved,
  };
}

test("real Windows junction upgrade validates both sealed inventories and preserves exact config/recent/session/home/source bytes", async (t) => {
  const f = await fixture(t),
    result = await upgradeInstalledChatProfileTarget(f.options);
  assert.equal(result.onlyArtifactJunctionChanged, true);
  assert.equal(result.sessionRewritten, false);
  assert.equal((await fs.lstat(f.link)).isSymbolicLink(), true);
  assert.equal(
    (await fs.realpath(f.link)).toLowerCase(),
    (await fs.realpath(f.options.to.root)).toLowerCase(),
  );
  await f.preserved();
});
test("wrong original sealed source and wrong target seal reject without replacing the old junction", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    upgradeInstalledChatProfileTarget({
      ...f.options,
      from: f.options.to,
      to: f.options.from,
    }),
  );
  await assert.rejects(
    upgradeInstalledChatProfileTarget({
      ...f.options,
      to: { ...f.options.to, outputHash: "f".repeat(64) },
    }),
  );
  assert.equal(
    (await fs.realpath(f.link)).toLowerCase(),
    f.options.from.root.toLowerCase(),
  );
  await f.preserved();
});
test("foreign profile under the same cohort and a non-junction leaf cannot be upgraded", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    upgradeInstalledChatProfileTarget({
      ...f.options,
      appData: path.join(
        f.options.ownedTestRoot,
        "r2-board-cold-foreign/appdata",
      ),
    }),
  );
  await fs.unlink(f.link);
  await fs.mkdir(f.link);
  await fs.writeFile(path.join(f.link, "not-owned.txt"), "preserve");
  await assert.rejects(upgradeInstalledChatProfileTarget(f.options));
  assert.equal(
    await fs.readFile(path.join(f.link, "not-owned.txt"), "utf8"),
    "preserve",
  );
  await f.preserved();
});
test("mid-path junction alias is refused before touching its leaf or external profile target", async (t) => {
  const f = await fixture(t),
    parent = path.dirname(f.link),
    detached = path.join(f.directory, "external-scope");
  await fs.rename(parent, detached);
  await fs.symlink(
    detached,
    parent,
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(
    upgradeInstalledChatProfileTarget(f.options),
    /physical/,
  );
  assert.equal(
    (
      await fs.realpath(path.join(detached, path.basename(f.link)))
    ).toLowerCase(),
    f.options.from.root.toLowerCase(),
  );
  await f.preserved();
});
test("junction replacement during actual portable verification fails the final CAS and never overwrites the raced target", async (t) => {
  const f = await fixture(t);
  let reads = 0;
  await assert.rejects(
    upgradeInstalledChatProfileTarget({
      ...f.options,
      verifyPortableBuild: async (root) => {
        const result = await verifyPortableBuild(root);
        if (++reads === 2) {
          await fs.unlink(f.link);
          await fs.symlink(
            f.options.to.root,
            f.link,
            process.platform === "win32" ? "junction" : "dir",
          );
        }
        return result;
      },
    }),
  );
  assert.equal(
    (await fs.realpath(f.link)).toLowerCase(),
    f.options.to.root.toLowerCase(),
  );
  await f.preserved();
});
