import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  prepareInstalledChatProfile,
  createIsolatedChatToken,
} from "./installed-chat-ui.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function fixture(t) {
  const suite = await fs.mkdtemp(
    path.join(os.tmpdir(), "r2-installed-profile-"),
  );
  t.after(async () => {
    assert.equal(path.dirname(suite), path.resolve(os.tmpdir()));
    assert.ok(path.basename(suite).startsWith("r2-installed-profile-"));
    await fs.rm(suite, { recursive: true, force: true });
  });
  const resourceAppData = path.join(suite, "resources"),
    installedRoot = path.join(suite, "artifact-one"),
    other = path.join(suite, "artifact-other");
  const appData = path.join(suite, "aily-project/dev-tests/owned/appdata"),
    home = path.join(suite, "home");
  for (const relative of [
    "sdk",
    "tools",
    "npm-global/node_modules",
    "compiler",
    "node_modules",
  ])
    await fs.mkdir(path.join(resourceAppData, relative), { recursive: true });
  for (const root of [installedRoot, other]) {
    await fs.mkdir(root);
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({
        name: "@aily-project/subapp-aily-chat",
        version: "test",
        ailyPortable: { format: "js" },
        ailySubapp: { app: {} },
      }),
    );
  }
  const baseConfigPath = path.join(resourceAppData, "config.json");
  await fs.writeFile(
    baseConfigPath,
    JSON.stringify({ regions: { cn: { name: "cn" } }, recentlyProjects: [] }),
  );
  const options = {
    appData,
    installedRoot,
    baseConfigPath,
    resourceAppData,
    apiBase: "http://127.0.0.1:28001",
  };
  const fresh = await prepareInstalledChatProfile(options);
  const configPath = path.join(appData, "config.json"),
    authPath = path.join(appData, ".aily");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  config.recentlyProjects = [
    { path: path.join(suite, "owned-project"), nickname: "existing" },
  ];
  config.lastSession = {
    id: "original-session",
    cwd: config.recentlyProjects[0].path,
  };
  config.unrelated = { custom: "preserve" };
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));
  const preference = path.join(
    home,
    ".aily-chat/ui-preferences/sessions/original.json",
  );
  await fs.mkdir(path.dirname(preference), { recursive: true });
  await fs.writeFile(preference, '{"selected":"original-session"}');
  const bytes = async () => ({
    config: hash(await fs.readFile(configPath)),
    auth: hash(await fs.readFile(authPath)),
    preference: hash(await fs.readFile(preference)),
  });
  return {
    suite,
    options,
    fresh,
    config,
    configPath,
    authPath,
    preference,
    bytes,
    other,
  };
}
test("actual fresh then explicit same-profile helper reuse preserves original preferences/resources and only rebases local API/mock auth", async (t) => {
  const f = await fixture(t),
    before = await f.bytes(),
    catalog = await fs.readFile(
      path.join(f.fresh.installRoot, "subapp-index.json"),
    ),
    manifest = await fs.readFile(
      path.join(f.fresh.installRoot, "package.json"),
    );
  const token = createIsolatedChatToken(),
    reused = await prepareInstalledChatProfile({
      ...f.options,
      apiBase: "http://127.0.0.1:28002",
      token,
      reuseExisting: true,
    });
  assert.equal(reused.preparation.reusedExisting, true);
  assert.equal(
    await fs.realpath(reused.link),
    await fs.realpath(f.options.installedRoot),
  );
  assert.deepEqual(reused.config.recentlyProjects, f.config.recentlyProjects);
  assert.deepEqual(reused.config.lastSession, f.config.lastSession);
  assert.deepEqual(reused.config.unrelated, f.config.unrelated);
  assert.equal(reused.config.region, f.config.region);
  assert.equal(reused.config.resource_source, f.config.resource_source);
  assert.equal(
    reused.config.regions["isolated-acceptance"].api_server,
    "http://127.0.0.1:28002",
  );
  assert.equal(reused.config.resource_sources[0].url, "http://127.0.0.1:28002");
  assert.equal(
    JSON.parse(await fs.readFile(f.authPath, "utf8")).access_token,
    token,
  );
  assert.equal((await f.bytes()).preference, before.preference);
  assert.ok(
    (
      await fs.readFile(path.join(f.fresh.installRoot, "subapp-index.json"))
    ).equals(catalog),
  );
  assert.ok(
    (await fs.readFile(path.join(f.fresh.installRoot, "package.json"))).equals(
      manifest,
    ),
  );
  for (const relative of [
    "sdk",
    "tools",
    "npm-global/node_modules",
    "compiler",
    "node_modules",
  ])
    assert.equal(
      await fs.realpath(path.join(f.options.appData, relative)),
      await fs.realpath(path.join(f.options.resourceAppData, relative)),
    );
});
test("default fresh creator remains strict and EEXIST does not clear the existing profile config/session", async (t) => {
  const f = await fixture(t),
    before = await f.bytes();
  await assert.rejects(
    prepareInstalledChatProfile({
      ...f.options,
      apiBase: "http://127.0.0.1:28002",
    }),
    { code: "EEXIST" },
  );
  assert.deepEqual(await f.bytes(), before);
});
test("explicit reuse refuses a different artifact before writing config or authentication", async (t) => {
  const f = await fixture(t),
    before = await f.bytes();
  await assert.rejects(
    prepareInstalledChatProfile({
      ...f.options,
      installedRoot: f.other,
      reuseExisting: true,
    }),
  );
  assert.deepEqual(await f.bytes(), before);
});
test("explicit reuse refuses a replaced physical installation directory", async (t) => {
  const f = await fixture(t),
    before = await f.bytes();
  await fs.unlink(f.fresh.link);
  await fs.mkdir(f.fresh.link);
  await assert.rejects(
    prepareInstalledChatProfile({ ...f.options, reuseExisting: true }),
  );
  assert.deepEqual(await f.bytes(), before);
});
