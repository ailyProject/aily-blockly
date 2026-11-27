import base64
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

import yaml


SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "publish-coder-feed.py"


class PublishCoderFeedTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.public = self.root / "public"
        self.public.mkdir()

    def release(self, version, package_suffix=b""):
        source = Path(tempfile.mkdtemp(dir=self.root))
        for manifest, names in (
            ("latest-coder-cn.yml", [f"aily-coder-CN-Setup-{version}.exe"]),
            ("latest-coder-mac-cn.yml", [f"aily-coder-CN-macos-{version}-arm64.{ext}" for ext in ("zip", "dmg")]),
        ):
            files = []
            for name in names:
                data = name.encode() + package_suffix
                (source / name).write_bytes(data)
                files.append({"url": name, "size": len(data),
                              "sha512": base64.b64encode(hashlib.sha512(data).digest()).decode()})
            meta = {"version": version, "files": files, "path": files[0]["url"], "sha512": files[0]["sha512"]}
            (source / manifest).write_text(yaml.safe_dump(meta), encoding="utf-8")
        for name in ("CHANGELOG_CODER.md", "CHANGELOG_CODER_ZH.md"):
            (source / name).write_text(f"{name} {version}", encoding="utf-8")
        return source, source.with_name(source.name + "-bundle")

    def command(self, operation, version, source, target, error=None):
        result = subprocess.run([sys.executable, SCRIPT, operation, version, source, target],
                                capture_output=True, text=True)
        if error is None:
            self.assertEqual(result.returncode, 0, result.stderr)
        else:
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(error, result.stderr)

    def test_prepare_rejects_package_that_disagrees_with_manifest(self):
        source, bundle = self.release("1.2.3")
        package = next(source.glob("*.exe"))
        package.write_bytes(b"?" * package.stat().st_size)
        self.command("prepare", "1.2.3", source, bundle, error="integrity")

    @unittest.skipUnless(sys.platform.startswith("linux"), "The origin publishes on Linux")
    def test_publish_and_retry_preserve_all_public_files(self):
        source, bundle = self.release("1.2.3")
        self.command("prepare", "1.2.3", source, bundle)
        for _ in range(2):
            self.command("publish", "1.2.3", bundle, self.public)
            expected = {p.name.replace("-cn.yml", ".yml"): p.read_bytes() for p in source.iterdir()}
            actual = {p.name: p.read_bytes() for p in self.public.iterdir() if not p.name.startswith(".")}
            self.assertEqual(actual, expected)

        inventory = (bundle / "inventory.json").read_text(encoding="utf-8")
        staging = self.root / "staging"
        staging.mkdir()

        def handshake(request):
            return subprocess.run([sys.executable, SCRIPT, "receive", "1.2.3", staging, self.public, request],
                                  input=b"", capture_output=True)

        retry = handshake(inventory)
        self.assertEqual(retry.returncode, 0, retry.stderr)
        self.assertEqual(retry.stdout, b"CODER_FEED_CURRENT\n")

        incomplete = json.loads(inventory)
        del incomplete["files"]["latest-coder.yml"]
        self.assertEqual(handshake(json.dumps(incomplete)).stdout, b"CODER_FEED_READY\n")
        package = next(self.public.glob("*.zip"))
        package.write_bytes(b"?" * package.stat().st_size)
        self.assertEqual(handshake(inventory).stdout, b"CODER_FEED_READY\n")

    @unittest.skipUnless(sys.platform.startswith("linux"), "The origin publishes on Linux")
    def test_same_version_allows_metadata_refresh_and_rejects_changed_packages(self):
        source, bundle = self.release("1.10.0")
        self.command("prepare", "1.10.0", source, bundle)
        self.command("publish", "1.10.0", bundle, self.public)
        source, bundle = self.release("1.10.0")
        with (source / "latest-coder-mac-cn.yml").open("a", encoding="utf-8") as manifest:
            manifest.write("releaseDate: '2026-01-01'\n")
        self.command("prepare", "1.10.0", source, bundle)
        self.command("publish", "1.10.0", bundle, self.public)
        self.assertEqual((source / "latest-coder-mac-cn.yml").read_bytes(),
                         (self.public / "latest-coder-mac.yml").read_bytes())

        active = {p.name: p.read_bytes() for p in self.public.iterdir()}
        for version, error in (("1.11.0", "integrity"), ("1.9.0", "downgrade"), ("1.10.0", "Existing package differs")):
            with self.subTest(version=version):
                source, bundle = self.release(version, package_suffix=b"changed")
                self.command("prepare", version, source, bundle)
                if version == "1.11.0":
                    package = next(bundle.glob("*.zip"))
                    package.write_bytes(b"?" * package.stat().st_size)
                self.command("publish", version, bundle, self.public, error=error)
                self.assertEqual({p.name: p.read_bytes() for p in self.public.iterdir()}, active)

    def test_r2_recovery_requires_stable_metadata(self):
        spec = importlib.util.spec_from_file_location("coder_publisher", SCRIPT)
        publisher = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(publisher)
        source, _ = self.release("1.2.3")
        for changed in (False, True):
            directory = Path(tempfile.mkdtemp(dir=self.root))
            bundle = directory / "bundle"
            requests = []

            def fetch(request, timeout):
                name = request.full_url.rsplit("/", 1)[1]
                data = (source / name).read_bytes()
                if changed and name == "latest-coder-cn.yml" and name in requests:
                    data += b"# newer snapshot\n"
                requests.append(name)
                return io.BytesIO(data)

            with patch("urllib.request.urlopen", side_effect=fetch):
                if changed:
                    with self.assertRaisesRegex(ValueError, "R2 metadata changed"):
                        publisher.fetch_r2("1.2.3", directory / "input", bundle)
                    self.assertFalse(bundle.exists())
                else:
                    publisher.fetch_r2("1.2.3", directory / "input", bundle)
                    self.assertEqual((bundle / "latest-coder.yml").read_bytes(),
                                     (source / "latest-coder-cn.yml").read_bytes())

    @unittest.skipUnless(sys.platform.startswith("linux"), "The origin publishes on Linux")
    def test_receive_validates_the_complete_stream_before_publishing(self):
        staging = self.root / "staging"
        staging.mkdir()
        for condition in ("valid", "unsafe name", "link", "duplicate", "truncated"):
            with self.subTest(condition=condition):
                version = "1.2.3" if condition == "valid" else "1.2.4"
                source, bundle = self.release(version)
                self.command("prepare", version, source, bundle)
                stream = io.BytesIO()
                with tarfile.open(fileobj=stream, mode="w") as archive:
                    if condition == "link":
                        link = tarfile.TarInfo("inventory.json")
                        link.type, link.linkname = tarfile.SYMTYPE, "../outside"
                        archive.addfile(link)
                    if condition in ("duplicate", "unsafe name"):
                        arcname = "inventory.json" if condition == "duplicate" else "../outside"
                        archive.add(bundle / "inventory.json", arcname=arcname)
                    for path in bundle.iterdir():
                        archive.add(path, arcname=path.name)
                    end = archive.offset
                data = stream.getvalue()
                if condition == "truncated":
                    data = data[:end + tarfile.BLOCKSIZE]
                before = {p.name: p.read_bytes() for p in self.public.iterdir()}
                inventory = (bundle / "inventory.json").read_text(encoding="utf-8")
                with subprocess.Popen([sys.executable, SCRIPT, "receive", version, staging, self.public, inventory],
                                      stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE) as receiver:
                    self.assertEqual(receiver.stdout.readline(), b"CODER_FEED_READY\n")
                    _, error = receiver.communicate(data)
                after = {p.name: p.read_bytes() for p in self.public.iterdir()}
                if condition == "valid":
                    self.assertEqual(receiver.returncode, 0, error)
                    self.assertEqual(after["latest-coder.yml"], (bundle / "latest-coder.yml").read_bytes())
                else:
                    self.assertNotEqual(receiver.returncode, 0)
                    self.assertEqual(after, before)
                self.assertEqual(list(staging.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
