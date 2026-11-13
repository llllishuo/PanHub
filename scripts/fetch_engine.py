# -*- coding: utf-8 -*-
"""下载并解压 OpenList 引擎二进制到 <仓库根>/resources/sidecar/<platform>-<arch>/

两个踩过的坑，都写在这里免得再犯：

1) 输出目录必须是仓库根，不能是 scripts/。
   测试与主进程都按 `resources/sidecar/<platform>-<arch>/openlist[.exe]` 查找；
   早期版本把 HERE 当输出根，引擎被放进 scripts/resources/，
   表现为「依赖引擎的用例全部 skipped」—— 测试看着通过，关键部分根本没跑。

2) 下载优先用 curl，而不是 python urllib。
   GitHub Actions 的 Windows runner 上 urllib 下载这个 37 MB 的 release 资产
   会稳定失败（macOS/Linux runner 正常），而 Windows 自带 curl.exe。
   curl 是各级 runner 上最一致的一条下载路径，urllib 仅作兜底。
"""
import io
import os
import platform
import shutil
import subprocess
import sys
import tempfile
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
CURL = shutil.which("curl") or shutil.which("curl.exe")


def _download_with_curl(url: str) -> bytes:
    """用 curl 下载（优先路径）。"""
    fd, tmp = tempfile.mkstemp(suffix=".part")
    os.close(fd)
    try:
        for attempt in range(1, RETRIES + 1):
            proc = subprocess.run(
                [
                    CURL, "-fL",
                    "--retry", "3",
                    "--retry-delay", "2",
                    "--connect-timeout", "20",
                    "--max-time", str(TIMEOUT),
                    "-o", tmp,
                    url,
                ],
                capture_output=True,
                text=True,
            )
            if proc.returncode == 0:
                with open(tmp, "rb") as f:
                    return f.read()
            print(f"\n[警告] curl 第 {attempt}/{RETRIES} 次失败 (rc={proc.returncode})")
            err = (proc.stderr or "").strip()
            if err:
                print(f"        {err.splitlines()[-1][:200]}")
            if attempt < RETRIES:
                time.sleep(3 * attempt)
        raise RuntimeError("curl 连续失败")
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass


def _download_with_urllib(url: str) -> bytes:
    """urllib 兜底（带重试与长度校验）。"""
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
        except Exception as e:  # noqa: BLE001 - 任何网络异常都值得重试
            last_err = e
            print(f"\n[警告] urllib 第 {attempt}/{RETRIES} 次失败：{type(e).__name__}: {e}")
            if attempt < RETRIES:
                time.sleep(3 * attempt)
    raise RuntimeError(f"urllib 连续失败：{last_err}")


def download(url: str) -> bytes:
    """先 curl，失败再退回 urllib —— 两条路都走不通才算失败。"""
    errors = []
    if CURL:
        print(f"[下载] curl: {CURL}")
        try:
            data = _download_with_curl(url)
            print(f"[完成] {len(data)/1048576:.1f} MB")
            return data
        except Exception as e:  # noqa: BLE001
            errors.append(f"curl: {e}")
            print("[回退] 改用 urllib 再试")
    else:
        print("[提示] 未找到 curl，直接使用 urllib")

    print("[下载] urllib")
    try:
        data = _download_with_urllib(url)
        print(f"[完成] {len(data)/1048576:.1f} MB")
        return data
    except Exception as e:  # noqa: BLE001
        errors.append(f"urllib: {e}")

    raise SystemExit("[失败] 两种下载方式都失败：" + "；".join(errors))


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
