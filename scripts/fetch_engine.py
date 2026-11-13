# -*- coding: utf-8 -*-
"""下载并解压 OpenList 引擎二进制到 resources/sidecar/<platform>-<arch>/"""
import io
import os
import platform
import sys
import urllib.request
import zipfile

VERSION = "v4.2.9"
BASE = f"https://github.com/OpenListTeam/OpenList/releases/download/{VERSION}"

MACHINE = platform.machine().lower()
ARCH = {"amd64": "amd64", "x86_64": "amd64", "arm64": "arm64", "aarch64": "arm64"}.get(MACHINE, "amd64")
SYS = platform.system().lower()

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "resources", "sidecar", f"{SYS}-{ARCH}")


def main():
    if SYS == "windows":
        asset = f"openlist-windows-{ARCH}-lite.zip"
    elif SYS == "darwin":
        asset = f"openlist-darwin-{ARCH}-lite.tar.gz"
    else:
        asset = f"openlist-linux-{ARCH}-lite.tar.gz"

    url = f"{BASE}/{asset}"
    print(f"[目标] {SYS}-{ARCH}")
    print(f"[URL ] {url}")

    os.makedirs(OUT, exist_ok=True)
    req = urllib.request.Request(url, headers={"User-Agent": "panhub-setup/1.0"})
    with urllib.request.urlopen(req, timeout=300) as r:
        total = int(r.headers.get("Content-Length") or 0)
        buf = io.BytesIO()
        got = 0
        while True:
            chunk = r.read(1024 * 256)
            if not chunk:
                break
            buf.write(chunk)
            got += len(chunk)
            if total:
                pct = got * 100 // total
                print(f"\r  下载 {got/1048576:6.1f}/{total/1048576:.1f} MB  {pct:3d}%", end="", flush=True)
        print()
    data = buf.getvalue()
    print(f"[完成] {len(data)/1048576:.1f} MB")

    if asset.endswith(".zip"):
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            names = z.namelist()
            print(f"[压缩包] {names}")
            z.extractall(OUT)
    else:
        import tarfile
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as t:
            print(f"[压缩包] {t.getnames()}")
            t.extractall(OUT)

    for root, _dirs, files in os.walk(OUT):
        for f in files:
            p = os.path.join(root, f)
            print(f"  {os.path.relpath(p, OUT):40s} {os.path.getsize(p)/1048576:8.1f} MB")
    print(f"\n[输出目录] {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
