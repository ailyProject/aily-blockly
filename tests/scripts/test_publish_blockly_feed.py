import base64
import hashlib
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import yaml


SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "publish-blockly-feed.py"


class PublishBlocklyFeedTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.public = self.root / "public"
        self.public.mkdir()

    def release(self, version):
        source = Path(tempfile.mkdtemp(dir=self.root))
        for manifest, names in (
            ("latest-cn.yml", [f"aily-blockly-CN-Setup-{version}.exe"]),
            ("latest-mac-cn.yml", [f"aily-blockly-CN-macos-{version}-arm64.{ext}" for ext in ("zip", "dmg")]),
        ):
            files = []
            for name in names:
                data = name.encode()
                (source / name).write_bytes(data)
                files.append({"url": name, "size": len(data),
                              "sha512": base64.b64encode(hashlib.sha512(data).digest()).decode()})
            meta = {"version": version, "files": files, "path": files[0]["url"], "sha512": files[0]["sha512"]}
            (source / manifest).write_text(yaml.safe_dump(meta), encoding="utf-8")
        for name in ("CHANGELOG.md", "CHANGELOG_ZH.md"):
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

    @unittest.skipUnless(sys.platform.startswith("linux"), "The origin publishes on Linux")
    def test_invalid_batches_leave_the_published_feed_intact(self):
        source, bundle = self.release("1.10.0")
        self.command("prepare", "1.10.0", source, bundle)
        self.command("publish", "1.10.0", bundle, self.public)
        active = {p.name: p.read_bytes() for p in self.public.iterdir()}

        for version, error in (("1.11.0", "integrity"), ("1.9.0", "downgrade"), ("1.10.0", "Conflicting")):
            with self.subTest(version=version):
                source, bundle = self.release(version)
                if version == "1.10.0":
                    with (source / "latest-mac-cn.yml").open("a", encoding="utf-8") as manifest:
                        manifest.write("releaseDate: '2026-01-01'\n")
                self.command("prepare", version, source, bundle)
                if version == "1.11.0":
                    package = next(bundle.glob("*.zip"))
                    package.write_bytes(b"?" * package.stat().st_size)
                self.command("publish", version, bundle, self.public, error=error)
                self.assertEqual({p.name: p.read_bytes() for p in self.public.iterdir()}, active)


if __name__ == "__main__":
    unittest.main()
