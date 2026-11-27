"""Stream the prepared Coder release to the pinned SSH origin and run its publisher."""
import json
import os
import shlex
import sys
import tarfile
from pathlib import Path, PurePosixPath

import paramiko


SUDO_PROMPT = b"[coder-feed-auth]"
READY = b"CODER_FEED_READY"
CURRENT = b"CODER_FEED_CURRENT"


def directory(variable):
    path = PurePosixPath(os.environ[variable])
    if not path.is_absolute() or path == PurePosixPath("/") or ".." in path.parts:
        raise ValueError(f"{variable} must name an absolute directory")
    return path


def receiver_command(version, staging, public, inventory):
    source = Path(__file__).with_name("publish-coder-feed.py").read_text(encoding="utf-8")
    command = shlex.join(["python3", "-u", "-c", source, "receive", version, str(staging), str(public),
                          json.dumps(inventory)])
    staging_arg, public_arg = shlex.quote(str(staging)), shlex.quote(str(public))
    # A maintenance login may only be allowed to write as the owner of the site's home.
    # Reuse that existing delegation without changing any filesystem permissions.
    return f"""set -eu
set -- {command}
if test -w {staging_arg} && test -x {staging_arg} && test -w {public_arg} && test -x {public_arg}; then
    exec "$@"
fi
owner=$(stat -c %u -- {shlex.quote(str(staging.parent))})
test "$owner" -gt 0
exec sudo -S -p '[coder-feed-auth]' -u "#$owner" -- "$@"
"""


def wait_for_receiver(channel, password):
    # sudo writes the prompt without a newline. Passwordless sudo goes directly to READY.
    output = b""
    authenticated = False
    while True:
        chunk = channel.recv(4096)
        if not chunk:
            raise RuntimeError("Origin could not open its receiving directory; check paths and SSH account permissions")
        output += chunk
        while b"\n" in output:
            line, _, output = output.partition(b"\n")
            if line in (READY, CURRENT):
                return line
        if output == SUDO_PROMPT:
            if authenticated:
                raise RuntimeError("Origin rejected authentication as the feed owner")
            channel.sendall(password.encode() + b"\n")
            authenticated = True
            output = b""


def upload(version, bundle):
    staging, public = directory("STAGING_ROOT"), directory("PUBLIC_DIR")
    inventory = json.loads((bundle / "inventory.json").read_text(encoding="utf-8"))
    if inventory["version"] != version:
        raise ValueError("Bundle version differs from requested release")
    host, port = os.environ["FEED_HOST"], int(os.environ.get("FEED_PORT", "22"))
    password = os.environ["SSHPASS"]
    with paramiko.SSHClient() as client:
        key_host = host if port == 22 else f"[{host}]:{port}"
        for line in os.environ["FEED_KNOWN_HOSTS"].splitlines():
            entry = paramiko.hostkeys.HostKeyEntry.from_line(line.strip())
            if entry and entry.key and "domestic-feed" in entry.hostnames:
                client.get_host_keys().add(key_host, entry.key.get_name(), entry.key)
        if not client.get_host_keys().lookup(key_host):
            raise ValueError("No pinned SSH host key for domestic-feed")
        client.connect(host, port=port, username=os.environ["FEED_USER"], password=password,
                       allow_agent=False, look_for_keys=False, timeout=20, auth_timeout=30, banner_timeout=30)
        transport = client.get_transport()
        transport.set_keepalive(30)
        with transport.open_session(timeout=30) as channel:
            channel.settimeout(180)
            channel.set_combine_stderr(True)
            channel.exec_command(receiver_command(version, staging, public, inventory))
            status = wait_for_receiver(channel, password)
            if status == READY:
                with channel.makefile("wb") as stream, tarfile.open(fileobj=stream, mode="w|", dereference=True) as archive:
                    for name in [*inventory["files"], "inventory.json"]:
                        path = bundle / name
                        if Path(name).name != name or path.is_symlink() or not path.is_file():
                            raise ValueError("Invalid bundle file")
                        archive.add(path, arcname=name, recursive=False)
                        print(f"Sent {name}", flush=True)
            channel.shutdown_write()
            output = channel.makefile("rb").read().decode(errors="replace")
            if channel.recv_exit_status():
                raise RuntimeError(f"Origin publication failed: {output.strip()}")
            print(f"Verified existing Coder {version} on the origin" if status == CURRENT else output.strip())


if __name__ == "__main__":
    upload(sys.argv[1], Path(sys.argv[2]))
