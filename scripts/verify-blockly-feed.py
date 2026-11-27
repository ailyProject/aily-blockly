"""Verify the files served by the domestic CDN without downloading whole packages."""
import base64
import hashlib
from http.client import HTTPException
import json
from pathlib import Path
import sys
import time
from urllib.parse import quote
from urllib.request import Request, urlopen


def check_file(base_url, name, size, sha512):
    url = f"{base_url.rstrip('/')}/{quote(name, safe='')}"
    metadata = name.endswith((".md", ".yml"))
    headers = {"Accept-Encoding": "identity"}
    if not metadata:
        headers["Range"] = "bytes=0-0"
    with urlopen(Request(url, headers=headers), timeout=15) as response:
        if metadata:
            if response.status != 200:
                raise ValueError(f"{name}: expected HTTP 200, received {response.status}")
            body = response.read(size + 1)
            digest = base64.b64encode(hashlib.sha512(body).digest()).decode("ascii")
            if len(body) != size or digest != sha512:
                raise ValueError(f"{name}: public bytes differ from the published bundle")
        elif (response.status != 206 or response.headers.get("Content-Range") != f"bytes 0-0/{size}"
              or len(response.read(2)) != 1):
            raise ValueError(f"{name}: public URL did not serve the expected one-byte range and package size")


def verify(version, bundle, base_url):
    inventory = json.loads((bundle / "inventory.json").read_text(encoding="utf-8"))
    if inventory["version"] != version:
        raise ValueError("Wrong release inventory for public verification")
    # Recheck the complete feed on every pass so success describes one observation.
    for attempt in range(3):
        try:
            for name, (size, sha512) in inventory["files"].items():
                check_file(base_url, name, size, sha512)
            return
        except (OSError, HTTPException, ValueError) as error:
            print(f"Public verification attempt {attempt + 1}: {error}", file=sys.stderr)
            if attempt == 2:
                raise
            time.sleep(10)


if __name__ == "__main__":
    version, bundle, base_url = sys.argv[1:]
    verify(version, Path(bundle), base_url)
    print(f"Verified public Blockly feed {version}")
