"""Prepare a Blockly CN bundle on the runner and publish it on the Linux origin."""
import base64
import hashlib
import json
import os
import re
import shutil
import sys
import tempfile
from pathlib import Path


MANIFESTS = ("latest.yml", "latest-mac.yml")
CHANGELOGS = ("CHANGELOG.md", "CHANGELOG_ZH.md")


def require(condition, message):
    if not condition:
        raise ValueError(message)


def version_key(value):
    # The release workflows use canonical SemVer. Prerelease identifiers compare
    # numerically or lexically and a final release sorts after its prereleases.
    number = r"(0|[1-9][0-9]*)"
    match = re.fullmatch(rf"{number}\.{number}\.{number}(?:-([0-9A-Za-z.-]+))?", value)
    require(match, f"Invalid release version: {value}")
    pre = match[4]
    identifiers = pre.split(".") if pre else []
    require(all(s and not (s.isdigit() and s != str(int(s))) for s in identifiers),
            f"Invalid prerelease version: {value}")
    return (*map(int, match.groups()[:3]), pre is None,
            tuple((0, int(s)) if s.isdigit() else (1, s) for s in identifiers))


def digest(path):
    require(path.is_file() and not path.is_symlink(), f"Missing regular file: {path.name}")
    checksum = hashlib.sha512()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            checksum.update(chunk)
    return base64.b64encode(checksum.digest()).decode("ascii")


def package_platform(name, version):
    prefix = "aily-blockly-CN"
    if name == f"{prefix}-Setup-{version}.exe":
        return "windows"
    if re.fullmatch(rf"{prefix}-macos-{re.escape(version)}-(arm64|x64|universal)\.(dmg|zip)", name):
        return "macos"
    raise ValueError(f"Unexpected Blockly package: {name}")


def prepare(version, source, bundle):
    import yaml  # Only the trusted runner needs PyYAML.
    inventory = {}
    sources = {}
    for platform, alias in zip(("windows", "macos"), MANIFESTS):
        manifest = source / alias.replace(".yml", "-cn.yml")
        meta = yaml.safe_load(manifest.read_bytes())
        require(meta["version"] == version, "Manifest version mismatch")
        files = meta["files"]
        require(isinstance(files, list) and files, "Missing manifest packages")
        require(any(f["url"] == meta["path"] and f["sha512"] == meta["sha512"] for f in files),
                "Invalid legacy update path or digest")
        types = set()
        for item in files:
            name = item["url"]
            require(package_platform(name, version) == platform and name not in inventory,
                    f"Invalid package in {alias}: {name}")
            src = source / name
            require(src.stat().st_size == item["size"] > 0 and digest(src) == item["sha512"],
                    f"Package integrity check failed: {name}")
            inventory[name] = [item["size"], item["sha512"]]
            sources[name] = src
            types.add(src.suffix)
        require(types == ({".exe"} if platform == "windows" else {".zip", ".dmg"}),
                f"Incomplete package set in {alias}")
        sources[alias] = manifest
    for log in CHANGELOGS:
        sources[log] = source / log
    bundle.mkdir(exist_ok=False)
    for name, src in sources.items():
        if name not in inventory:
            require(src.stat().st_size > 0, f"Empty metadata: {name}")
            inventory[name] = [src.stat().st_size, digest(src)]
        # Both directories normally live under RUNNER_TEMP.
        try:
            os.link(src, bundle / name)
        except OSError:
            shutil.copyfile(src, bundle / name)
    (bundle / "inventory.json").write_text(json.dumps({
        "version": version, "files": inventory
    }), encoding="utf-8")


def current_version(manifest):
    # Both electron-builder and the release scripts emit a top-level scalar.
    match = re.search(r"^version: ['\"]?([0-9A-Za-z.\-]+)['\"]?[ \t]*$",
                      manifest.read_text(encoding="utf-8-sig"), re.MULTILINE)
    require(match, f"Cannot read published version in {manifest.name}")
    return version_key(match[1])


def publish(version, stage, public):
    import fcntl  # The origin is Linux.
    stage, public = stage.resolve(strict=True), public.resolve(strict=True)
    require(public not in (stage, *stage.parents) and stage not in public.parents,
            "Staging must be outside the public directory")
    require(stage.stat().st_dev == public.stat().st_dev, "Staging must share the origin filesystem")
    inventory = json.loads((stage / "inventory.json").read_text(encoding="utf-8"))
    require(inventory["version"] == version, "Wrong release batch")
    files = inventory["files"]
    metadata = CHANGELOGS + MANIFESTS
    require(all(name in files for name in metadata), "Incomplete feed metadata")
    packages = [name for name in files if name not in metadata]
    for name in packages:
        package_platform(name, version)
    require({Path(name).suffix for name in packages} == {".exe", ".zip", ".dmg"}, "Incomplete release")
    for name, (size, checksum) in files.items():
        path = stage / name
        require(path.stat().st_size == size > 0 and digest(path) == checksum,
                f"Origin integrity check failed: {name}")
        path.chmod(0o644)  # Published files inherit the inode's mode.

    with (public / ".blockly-publish.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        target_version = version_key(version)
        for name in metadata:
            active = public / name
            require(not active.is_symlink() and (not active.exists() or active.is_file()),
                    f"Unexpected public path: {name}")
            if name in MANIFESTS and active.exists():
                previous = current_version(active)
                require(previous <= target_version, f"Refusing to downgrade {name}")
                if previous == target_version:
                    require(digest(active) == files[name][1], f"Conflicting same-version manifest: {name}")
        for name in packages:
            active = public / name
            if active.exists() or active.is_symlink():
                require(digest(active) == files[name][1], f"Existing package differs, publish a new version: {name}")
        # Package URLs are immutable. A retry can reuse any files placed before interruption.
        for name in packages:
            if not (public / name).exists():
                os.link(stage / name, public / name)

        # Prepare all links before changing either public manifest. Revert metadata
        # already replaced on a filesystem error. Old versioned packages remain reachable.
        with tempfile.TemporaryDirectory(dir=stage) as temp:
            work = Path(temp)
            switched = []
            for name in metadata:
                os.link(stage / name, work / name)
                if (public / name).exists():
                    os.link(public / name, work / ("previous-" + name))
            try:
                for name in metadata:
                    os.replace(work / name, public / name)
                    switched.append(name)
            except OSError:
                for name in reversed(switched):
                    backup = work / ("previous-" + name)
                    if backup.exists():
                        os.replace(backup, public / name)
                    else:
                        (public / name).unlink()
                raise
    print(f"Published Blockly {version} with {len(packages)} verified packages")


if __name__ == "__main__":
    command, version, source, target = sys.argv[1:]
    version_key(version)
    {"prepare": prepare, "publish": publish}[command](version, Path(source), Path(target))
