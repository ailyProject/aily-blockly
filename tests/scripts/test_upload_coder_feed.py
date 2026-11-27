import base64
from concurrent.futures import ThreadPoolExecutor
import hashlib
import io
import json
import logging
import os
from pathlib import Path
import secrets
import shlex
import socket
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import unittest

import paramiko


SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "upload-coder-feed.py"


class LocalOrigin(paramiko.ServerInterface):
    def __init__(self, password):
        self.password = password
        self.auth_attempts = 0
        self.command = None
        self.exec_requested = threading.Event()

    def check_auth_password(self, username, password):
        self.auth_attempts += 1
        if username == "fixture" and password == self.password:
            return paramiko.AUTH_SUCCESSFUL
        return paramiko.AUTH_FAILED

    def check_channel_request(self, kind, chanid):
        return (paramiko.OPEN_SUCCEEDED if kind == "session"
                else paramiko.OPEN_FAILED_ADMINISTRATIVELY_PROHIBITED)

    def check_channel_exec_request(self, channel, command):
        self.command = command
        self.exec_requested.set()
        return True


class CoderUploadTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.host_key = paramiko.RSAKey.generate(2048)
        # A client rejecting its peer deliberately resets this connection.
        cls.server_log = logging.getLogger("coder-upload-test.origin")
        cls.server_log.addHandler(logging.NullHandler())
        cls.server_log.propagate = False

    def exercise(self, mode, reply=b"CODER_FEED_READY\n", exit_status=0, expect_success=True):
        password = secrets.token_hex(16)
        origin = LocalOrigin(password)
        with tempfile.TemporaryDirectory() as directory, socket.socket() as listener:
            bundle = Path(directory)
            files = {"CHANGELOG_CODER.md": b"release notes\n"}
            inventory = json.dumps({"version": "1.2.3", "files": {
                name: [len(content), base64.b64encode(hashlib.sha512(content).digest()).decode()]
                for name, content in files.items()
            }}).encode()
            files["inventory.json"] = inventory
            for name, content in files.items():
                (bundle / name).write_bytes(content)
            listener.bind(("127.0.0.1", 0))
            listener.listen(1)
            listener.settimeout(10)

            def receive():
                connection, _ = listener.accept()
                with connection, paramiko.Transport(connection) as transport:
                    transport.set_log_channel(self.server_log.name)
                    transport.add_server_key(self.host_key)
                    transport.start_server(server=origin)
                    channel = transport.accept(10)
                    if mode == "wrong-key":
                        self.assertIsNone(channel)
                        return
                    self.assertTrue(origin.exec_requested.wait(5))
                    self.assertTrue(password.encode() not in origin.command, "Credential in receiver command")
                    args = shlex.split(origin.command.decode())
                    self.assertEqual(json.loads(args[args.index("receive") + 4]), json.loads(inventory))
                    channel.settimeout(5)
                    with channel.makefile("rb") as incoming:
                        if mode == "sudo":
                            # sudo prompts on stderr without a trailing newline.
                            channel.sendall_stderr(b"[coder-")
                            time.sleep(0.05)
                            channel.sendall_stderr(b"feed-auth]")
                            self.assertTrue(incoming.readline() == password.encode() + b"\n")
                        channel.sendall(reply)
                        if reply == b"CODER_FEED_READY\n":
                            with tarfile.open(fileobj=io.BytesIO(incoming.read())) as archive:
                                self.assertEqual({m.name: archive.extractfile(m).read() for m in archive}, files)
                        channel.send_exit_status(exit_status)
                        channel.shutdown_write()
                        if reply != b"CODER_FEED_READY\n":
                            self.assertEqual(incoming.read(), b"", "Unexpected upload after receiver reply")
                    transport.join(5)

            pin = paramiko.RSAKey.generate(2048) if mode == "wrong-key" else self.host_key
            env = {**os.environ, "FEED_HOST": "127.0.0.1", "FEED_PORT": str(listener.getsockname()[1]),
                   "FEED_USER": "fixture", "SSHPASS": password,
                   "FEED_KNOWN_HOSTS": f"domestic-feed {pin.get_name()} {pin.get_base64()}",
                   "STAGING_ROOT": "/fixture/staging", "PUBLIC_DIR": "/fixture/public"}
            with ThreadPoolExecutor(max_workers=1) as pool:
                server = pool.submit(receive)
                result = subprocess.run([sys.executable, SCRIPT, "1.2.3", bundle], env=env,
                                        capture_output=True, text=True, timeout=20)
                server.result(timeout=15)
            self.assertTrue(password not in result.stdout + result.stderr)
            if mode == "wrong-key":
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("BadHostKeyException", result.stderr)
                self.assertEqual(origin.auth_attempts, 0)
            else:
                if expect_success:
                    self.assertEqual(result.returncode, 0, result.stderr)
                else:
                    self.assertNotEqual(result.returncode, 0)
                self.assertEqual(origin.auth_attempts, 1)

    def test_direct_receiver(self):
        self.exercise("direct")

    def test_sudo_password_precedes_archive(self):
        self.exercise("sudo")

    def test_current_receiver_skips_archive(self):
        for mode in ("direct", "sudo"):
            with self.subTest(mode=mode):
                self.exercise(mode, reply=b"CODER_FEED_CURRENT\n")

    def test_current_reply_requires_successful_exit(self):
        self.exercise("direct", reply=b"CODER_FEED_CURRENT\n", exit_status=1, expect_success=False)

    def test_current_marker_inside_error_line_is_not_a_reply(self):
        self.exercise("direct", reply=b"receiver expected CODER_FEED_CURRENT\n", expect_success=False)

    def test_wrong_host_key_rejected_before_authentication(self):
        self.exercise("wrong-key")


if __name__ == "__main__":
    unittest.main()
