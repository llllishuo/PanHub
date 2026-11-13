import re, urllib.request, time

def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 panhub-check"})
    with urllib.request.urlopen(req, timeout=40) as r:
        return r.read().decode("utf-8", "replace")

# badge 不受 API 速率限制
for attempt in range(30):
    try:
        svg = fetch("https://github.com/llllishuo/PanHub/actions/workflows/build.yml/badge.svg")
        texts = re.findall(r">([^<>]{1,40})<", svg)
        status = [t for t in texts if t.strip() and t.strip().lower() not in ("build",) and "px" not in t]
        print(f"[{attempt+1}] badge 文本: {status}")
        joined = " ".join(status).lower()
        if any(k in joined for k in ("passing", "failing", "success", "failed", "queued", "in progress")):
            print("\n=> 整体状态:", [t for t in status if t.lower() in ("passing","failing","success","failed","queued","in progress","cancelled")])
            if "passing" in joined or "success" in joined:
                break
            if "failing" in joined or "failed" in joined:
                print("（仍为失败，等待下一轮）")
    except Exception as e:
        print(f"[{attempt+1}] 取 badge 失败: {e}")
    time.sleep(60)
