# -*- coding: utf-8 -*-
"""下载并解压 OpenList 引擎二进制到 <仓库根>/resources/sidecar/<platform>-<arch>/

为什么必须落在仓库根而不是 scripts/ 下：
测试与主进程都按 `resources/sidecar/<platform>-<arch>/openlist[.exe]` 查找。
早期版本把 HERE 当成输出根，结果引擎被放进 scripts/resources/，
表现为「CI 上依赖引擎的 12 个用例全部 skipped」——测试看着是通过的，
实际上最关键的那部分根本没跑。
"""
import io
import os
import platform
import sys
import time
import urllib.request
import zipfile

VERSION = "v4.2.9"
BASE = f"https://github.com/OpenListTeam/OpenList/releases/download/{VERSION}"

MACHINE = platform.machine().lower()
ARCH = {"amd64": "amd64", "x86_64": "amd64", "arm64": "arm64", "aarch64": "arm64"}.get(MACHINE, "amd64")
SYS = platform.system().lower()

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)          # 仓库根：scripts/ 的上一级
OUT = os.path.join(ROOT, "resources", "sidecar", f"{SYS}-{ARCH}")
BIN_NAME = "openlist.exe" if SYS == "windows" else "openlist"

RETRIES = 3
TIMEOUT = 300


def download(url: str) -> bytes:
    """带重试地下载。CI 上偶发 ECONNRESET / 超时不该直接判构建失败。"""
    last_err = None
    for attempt in range(1, RETRIES + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "panhub-setup/1.0"})
            with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
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
            if total and len(data) != total:
                raise IOError(f"长度不符：收到 {len(data)}，期望 {total}")
            return data
        except Exception as e:  # noqa: BLE001 - 任何一种网络异常都值得重试
            last_err = e
            print(f"\n[警告] 第 {attempt}/{RETRIES} 次下载失败：{type(e).__name__}: {e}")
            if attempt < RETRIES:
                wait = 3 * attempt
                print(f"[重试] {wait} 秒后再试…")
                time.sleep(wait)
    raise SystemExit(f"[失败] 下载 {url} 连续 {RETRIES} 次失败：{last_err}")


def main() -> int:
    if SYS == "windows":
        asset = f"openlist-windows-{ARCH}-lite.zip"
    elif SYS == "darwin":
        asset = f"openlist-darwin-{ARCH}-lite.tar.gz"
    else:
        asset = f"openlist-linux-{ARCH}-lite.tar.gz"

    url = f"{BASE}/{asset}"
    print(f"[目标] {SYS}-{ARCH}")
    print(f"[URL ] {url}")
    print(f"[输出] {OUT}")

    os.makedirs(OUT, exist_ok=True)
    data = download(url)
    print(f"[完成] {len(data)/1048576:.1f} MB")

    if asset.endswith(".zip"):
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            print(f"[压缩包] {z.namelist()}")
            z.extractall(OUT)
    else:
        import tarfile
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as t:
            print(f"[压缩包] {t.getnames()}")
            t.extractall(OUT)

    binary = os.path.join(OUT, BIN_NAME)
    if not os.path.isfile(binary):
        # 明确失败，而不是留下一个「看起来成功了」的空目录
        print(f"[失败] 解压后找不到可执行文件：{binary}", file=sys.stderr)
        for root, _dirs, files in os.walk(OUT):
            for f in files:
                print(f"  实际存在: {os.path.relpath(os.path.join(root, f), OUT)}")
        return 1

    if SYS != "windows":
        os.chmod(binary, 0o755)

    for root, _dirs, files in os.walk(OUT):
        for f in files:
            p = os.path.join(root, f)
            print(f"  {os.path.relpath(p, OUT):40s} {os.path.getsize(p)/1048576:8.1f} MB")
    print(f"\n[就绪] {binary}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
