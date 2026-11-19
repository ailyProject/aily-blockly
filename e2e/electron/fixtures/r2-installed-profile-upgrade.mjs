import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const packageName = "@aily-project/subapp-aily-chat";
const key = (value) => path.resolve(value).toLowerCase();
const identity = (stat) => `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
const descriptor = (value) => {
  assert.ok(value && path.isAbsolute(value.root));
  assert.match(value.inputHash, /^[a-f0-9]{64}$/);
  assert.match(value.outputHash, /^[a-f0-9]{64}$/);
  return { ...value, root: path.resolve(value.root) };
};
function physicalChain(directory) {
  const absolute = path.resolve(directory),
    root = path.parse(absolute).root;
  const paths = [root];
  for (const part of absolute
    .slice(root.length)
    .split(path.sep)
    .filter(Boolean))
    paths.push(path.join(paths.at(-1), part));
  return paths.map((file) => {
    const stat = fs.lstatSync(file, { bigint: true });
    assert.ok(
      stat.isDirectory() && !stat.isSymbolicLink(),
      "Profile/artifact parents must remain physical directories",
    );
    assert.equal(key(fs.realpathSync.native(file)), key(file));
    return { path: file, identity: identity(stat) };
  });
}
function assertChain(chain) {
  for (const value of chain) {
    const stat = fs.lstatSync(value.path, { bigint: true });
    assert.ok(
      stat.isDirectory() && !stat.isSymbolicLink(),
      "A physical parent changed",
    );
    assert.equal(
      identity(stat),
      value.identity,
      "A physical parent was replaced",
    );
    assert.equal(key(fs.realpathSync.native(value.path)), key(value.path));
  }
}
function originalLink(link, target) {
  const stat = fs.lstatSync(link, { bigint: true });
  assert.equal(
    stat.isSymbolicLink(),
    true,
    "Upgrade only the original artifact junction",
  );
  assert.equal(
    key(fs.realpathSync.native(link)),
    key(target),
    "The existing profile is not bound to the original sealed artifact",
  );
  return { identity: identity(stat), target: fs.readlinkSync(link) };
}

/** Test-only explicit artifact upgrade. The exact stopped session and project
 * are verified by the caller; no preferences, session records or source bytes
 * are rewritten here. Both artifacts must pass the real portable verifier. */
export async function upgradeInstalledChatProfileTarget({
  appData,
  suite,
  ownedTestRoot,
  from,
  to,
  verifyPortableBuild,
}) {
  assert.equal(typeof verifyPortableBuild, "function");
  assert.ok(
    [appData, suite, ownedTestRoot].every(
      (value) => typeof value === "string" && path.isAbsolute(value),
    ),
  );
  appData = path.resolve(appData);
  suite = path.resolve(suite);
  ownedTestRoot = path.resolve(ownedTestRoot);
  assert.equal(
    key(path.dirname(suite)),
    key(ownedTestRoot),
    "Profile must belong to the explicitly owned suite",
  );
  assert.match(path.basename(suite), /^r2-board-cold-[A-Za-z0-9_-]+$/);
  assert.equal(
    key(appData),
    key(path.join(suite, "appdata")),
    "A foreign profile cannot be upgraded",
  );
  assert.match(
    ownedTestRoot.replaceAll("\\", "/"),
    /\/aily-project\/dev-tests\/[^/]+$/i,
  );
  from = descriptor(from);
  to = descriptor(to);
  assert.notEqual(key(from.root), key(to.root));
  assert.notEqual(
    from.inputHash,
    to.inputHash,
    "Upgrade must name two different sealed builds",
  );
  const link = path.join(
    appData,
    "npm-global/app/node_modules",
    ...packageName.split("/"),
  );
  const chains = [
    physicalChain(path.dirname(link)),
    physicalChain(from.root),
    physicalChain(to.root),
  ];
  const before = originalLink(link, from.root);
  const artifacts = [];
  for (const expected of [from, to]) {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(expected.root, "package.json"), "utf8"),
    );
    assert.equal(manifest.name, packageName);
    assert.equal(manifest.ailyPortable?.format, "js");
    const actual = await verifyPortableBuild(expected.root);
    assert.equal(actual.version, 1);
    assert.equal(actual.inputHash, expected.inputHash);
    assert.equal(actual.outputHash, expected.outputHash);
    artifacts.push(actual);
  }
  // All asynchronous work finishes before the final physical CAS. The only
  // mutation is to the reparse-point leaf, never recursively to either tree.
  for (const chain of chains) assertChain(chain);
  const current = originalLink(link, from.root);
  assert.deepEqual(
    current,
    before,
    "The original junction changed while verifying sealed artifacts",
  );
  fs.unlinkSync(link);
  try {
    fs.symlinkSync(
      to.root,
      link,
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch (error) {
    // A failed creation may restore only the just-removed original link. Never
    // overwrite a concurrent replacement or change any parent/source tree.
    for (const chain of chains) assertChain(chain);
    if (!fs.lstatSync(link, { throwIfNoEntry: false }))
      fs.symlinkSync(
        from.root,
        link,
        process.platform === "win32" ? "junction" : "dir",
      );
    throw error;
  }
  for (const chain of chains) assertChain(chain);
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  assert.equal(key(fs.realpathSync.native(link)), key(to.root));
  return {
    version: 1,
    link,
    from: { ...from, artifact: artifacts[0] },
    to: { ...to, artifact: artifacts[1] },
    onlyArtifactJunctionChanged: true,
    preferencesRewritten: false,
    sessionRewritten: false,
    sourceRewritten: false,
  };
}
