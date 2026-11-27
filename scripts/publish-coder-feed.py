"""Prepare a Coder CN bundle on the runner and publish it on the Linux origin."""
import base64
import hashlib
import json
import os
import re
import shutil
import sys
import tarfile
import tempfile
from pathlib import Path


MANIFESTS = ("latest-coder.yml", "latest-coder-mac.yml")
CHANGELOGS = ("CHANGELOG_CODER.md", "CHANGELOG_CODER_ZH.md")
R2_URL = "https://dl.aily.pro/blockly/"


def require(condition, message):
    if not condition:
        raise ValueError(message)


def version_key(value):
    number = r"(0|[1-9][0-9]*)"
    match = re.fullmatch(rf"{number}\.{number}\.{number}", value)
    require(match, f"Invalid stable Coder version: {value}")
    return tuple(map(int, match.groups()))


def digest(path):
    require(path.is_file() and not path.is_symlink(), f"Missing regular file: {path.name}")
    checksum = hashlib.sha512()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            checksum.update(chunk)
    return base64.b64encode(checksum.digest()).decode("ascii")


def package_names(version):
    prefix = f"aily-coder-CN-macos-{version}-arm64"
    return ((f"aily-coder-CN-Setup-{version}.exe",), (prefix + ".zip", prefix + ".dmg"))


def prepare(version, source, bundle):
    import yaml  # Only the trusted runner needs PyYAML.
    inventory = {}
    sources = {}
    for names, alias in zip(package_names(version), MANIFESTS):
        manifest = source / alias.replace(".yml", "-cn.yml")
        meta = yaml.safe_load(manifest.read_bytes())
        require(meta["version"] == version, "Manifest version mismatch")
        files = meta["files"]
        require(tuple(item["url"] for item in files) == names, f"Unexpected package list in {alias}")
        require(meta["path"] == names[0] and meta["sha512"] == files[0]["sha512"],
                f"Invalid legacy update path or digest in {alias}")
        for item in files:
            name = item["url"]
            src = source / name
            require(src.stat().st_size == item["size"] > 0 and digest(src) == item["sha512"],
                    f"Package integrity check failed: {name}")
            inventory[name] = [item["size"], item["sha512"]]
            sources[name] = src
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


def fetch_r2(version, source, bundle):
    """Recover the requested stable version while its complete feed is still on R2."""
    from urllib.request import Request, urlopen
    import yaml

    def fetch(name):
        return urlopen(Request(R2_URL + name, headers={"Cache-Control": "no-cache"}), timeout=60)

    source.mkdir()
    manifests = tuple(alias.replace(".yml", "-cn.yml") for alias in MANIFESTS)
    for name in manifests + CHANGELOGS:
        with fetch(name) as response:
            data = response.read()
        if name in manifests:
            require(yaml.safe_load(data)["version"] == version, f"R2 no longer serves {version} in {name}")
        (source / name).write_bytes(data)
    for platform in package_names(version):
        for name in platform:
            with fetch(name) as response, (source / name).open("xb") as output:
                shutil.copyfileobj(response, output)
    for name in manifests + CHANGELOGS:
        with fetch(name) as response:
            require(response.read() == (source / name).read_bytes(), f"R2 metadata changed: {name}")
    prepare(version, source, bundle)


def current_version(manifest):
    # Both electron-builder and the release scripts emit a top-level scalar.
    match = re.search(r"^version: ['\"]?([0-9A-Za-z.\-]+)['\"]?[ \t]*$",
                      manifest.read_text(encoding="utf-8-sig"), re.MULTILINE)
    require(match, f"Cannot read published version in {manifest.name}")
    return version_key(match[1])


def release_directories(stage, public):
    stage, public = stage.resolve(strict=True), public.resolve(strict=True)
    require(stage.is_dir() and public.is_dir() and public not in (stage, *stage.parents)
            and stage not in public.parents, "Need separate staging and public directories")
    require(stage.stat().st_dev == public.stat().st_dev, "Staging must share the origin filesystem")
    return stage, public


def receive(version, staging_root, public):
    staging_root, public = release_directories(staging_root, public)
    windows, macos = package_names(version)
    expected = set(windows + macos + CHANGELOGS + MANIFESTS + ("inventory.json",))
    with tempfile.TemporaryDirectory(prefix="coder-", dir=staging_root) as directory:
        stage = Path(directory)
        # The uploader waits for sudo to finish consuming its password before sending binary data.
        print("CODER_FEED_READY", flush=True)
        with tarfile.open(fileobj=sys.stdin.buffer, mode="r|") as archive:
            for member in archive:
                require(member.name in expected and member.type in (tarfile.REGTYPE, tarfile.AREGTYPE)
                        and member.sparse is None, "Unexpected or duplicate Coder archive entry")
                expected.remove(member.name)
                with archive.extractfile(member) as source, (stage / member.name).open("xb") as output:
                    shutil.copyfileobj(source, output)
                if not expected:
                    # The next header must be the end marker. tarfile normally accepts a missing trailer.
                    archive.fileobj.read(-member.size % tarfile.BLOCKSIZE)
                    marker = bytes(2 * tarfile.BLOCKSIZE)
                    require(archive.fileobj.read(len(marker)) == marker, "Invalid or incomplete Coder archive")
                    for padding in iter(lambda: archive.fileobj.read(65536), b""):
                        require(not padding.strip(b"\0"), "Unexpected data after Coder archive")
                    break
            require(not expected, "Incomplete Coder archive")
        publish(version, stage, public)


def publish(version, stage, public):
    import fcntl  # The origin is Linux.
    stage, public = release_directories(stage, public)
    inventory = json.loads((stage / "inventory.json").read_text(encoding="utf-8"))
    require(inventory["version"] == version, "Wrong release batch")
    files = inventory["files"]
    metadata = CHANGELOGS + MANIFESTS
    windows, macos = package_names(version)
    packages = windows + macos
    require(set(files) == set(metadata + packages), "Unexpected Coder bundle inventory")
    for name, (size, checksum) in files.items():
        path = stage / name
        require(path.stat().st_size == size > 0 and digest(path) == checksum,
                f"Origin integrity check failed: {name}")
        path.chmod(0o644)  # Published files inherit the inode's mode.

    with (public / ".coder-publish.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        target_version = version_key(version)
        for name in metadata:
            active = public / name
            require(not active.is_symlink() and (not active.exists() or active.is_file()),
                    f"Unexpected public path: {name}")
            if name in MANIFESTS and active.exists():
                previous = current_version(active)
                require(previous <= target_version, f"Refusing to downgrade {name}")
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
    print(f"Published Coder {version} with {len(packages)} verified packages")


if __name__ == "__main__":
    command, version, source, target = sys.argv[1:]
    version_key(version)
    {"prepare": prepare, "publish": publish, "receive": receive, "fetch-r2": fetch_r2}[command](
        version, Path(source), Path(target))
