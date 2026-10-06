#!/usr/bin/env python3
"""Build /var/www/zen/stats.json from the local node API for the public stats page.

Runs every 5 minutes (systemd timer installed by site/setup-site.sh). Only this script talks
to the node API; visitors read a static JSON file, so the page adds no load to the node and
exposes no new endpoint.

  python3 site/update-stats.py [--api http://127.0.0.1:11567] [--out /var/www/zen/stats.json]
"""
import argparse, json, os, time, urllib.request

TARGET_BLOCK_S = 236.682          # Chain.fs blockInterval (ms) / 1000
INTERVAL, SNAPSHOT, NOMINATION = 10000, 9000, 500
HEADERS_TAKE = 2600               # ~7 days of headers
BUCKET_S = 4 * 3600               # ~60 blocks per point; hourly is too noisy

ap = argparse.ArgumentParser()
ap.add_argument("--api", default="http://127.0.0.1:11567")
ap.add_argument("--out", default="/var/www/zen/stats.json")
ap.add_argument("--cache", default="/var/lib/zen-stats/miners.json")
a = ap.parse_args()


def get(path, timeout=60):
    with urllib.request.urlopen(a.api + path, timeout=timeout) as r:
        return json.loads(r.read().decode())


def safe(path):
    try:
        return get(path)
    except Exception:
        return None


def hashes_per_block(target_hex):
    return 2 ** 256 // (int(target_hex, 16) + 1)


info = get("/blockchain/info")
tip = info["blocks"]
now_ms = int(time.time() * 1000)

# --- headers: block times, hashrate --------------------------------------------------------
headers = get(f"/blockchain/headers?blockNumber={tip}&take={HEADERS_TAKE}", timeout=180)
headers.sort(key=lambda h: h["blockNumber"])
hs = [(h["blockNumber"], h["timestamp"], hashes_per_block(h["target"])) for h in headers]

def window_stats(rows):
    if len(rows) < 2:
        return None, None
    span_s = (rows[-1][1] - rows[0][1]) / 1000
    n = len(rows) - 1
    if span_s <= 0:
        return None, None
    work = sum(r[2] for r in rows[1:])
    return span_s / n, work / span_s

day = [r for r in hs if r[1] >= now_ms - 24 * 3600 * 1000]
avg_bt_24h, hashrate_24h = window_stats(day)

series = []
if hs:
    hour = BUCKET_S * 1000
    start = (hs[0][1] // hour + 1) * hour
    buckets = {}
    for i in range(1, len(hs)):
        _, t, w = hs[i]
        if t < start:
            continue
        b = buckets.setdefault(t // hour * hour, [0, 0])
        b[0] += 1
        b[1] += w
    for t in sorted(buckets):
        n, w = buckets[t]
        series.append({"t": t, "blocks": n,
                       "blockTime": round(BUCKET_S / n, 1),
                       "hashrate": round(w / BUCKET_S)})
    if series and now_ms - series[-1]["t"] < BUCKET_S * 1000:
        series.pop()                     # current bucket is still incomplete

# --- miners of the last 24h (block bodies, cached by height) -------------------------------
cache = {}
try:
    with open(a.cache) as f:
        cache = {int(k): v for k, v in json.load(f).items()}
except Exception:
    pass

recent = []
day_heights = [r[0] for r in day] or [tip]
for h in range(tip, min(day_heights) - 1, -1):
    if h not in cache:
        blk = safe(f"/blockchain/block?blockNumber={h}")
        if not blk:
            continue
        miner, reward, txs = None, 0, len(blk.get("transactions", {}))
        for tx in blk.get("transactions", {}).values():
            for o in tx.get("outputs", []):
                lock = o.get("lock")
                if isinstance(lock, dict) and "Coinbase" in lock:
                    miner = miner or lock["Coinbase"]["address"]
                    if o["spend"]["asset"] == "00":
                        reward += int(o["spend"]["amount"])
        cache[h] = {"m": miner, "r": reward, "n": txs,
                    "t": blk["header"]["timestamp"], "hash": blk["hash"]}
cache = {h: v for h, v in cache.items() if h >= tip - 2000}
os.makedirs(os.path.dirname(a.cache), exist_ok=True)
with open(a.cache, "w") as f:
    json.dump(cache, f)

counts = {}
for h in day_heights:
    m = cache.get(h, {}).get("m")
    if m:
        counts[m] = counts.get(m, 0) + 1
miners = sorted(({"address": k, "blocks": v} for k, v in counts.items()),
                key=lambda x: -x["blocks"])
for h in range(tip, tip - 12, -1):
    c = cache.get(h)
    if c:
        recent.append({"height": h, "time": c["t"], "miner": c["m"], "reward": c["r"],
                       "txs": c["n"], "hash": c["hash"]})

# --- CGP voting cycle ----------------------------------------------------------------------
interval = (tip - 1) // INTERVAL + 1
snap = (interval - 1) * INTERVAL + SNAPSHOT
nom_end = snap + NOMINATION
end = interval * INTERVAL
if tip < snap:
    phase, nxt, nxt_name = "Before snapshot", snap, "Balance snapshot"
elif tip < nom_end:
    phase, nxt, nxt_name = "Nomination", nom_end, "Voting opens"
else:
    phase, nxt, nxt_name = "Voting", end, "Voting closes, payout"
bt = avg_bt_24h or TARGET_BLOCK_S
cgp = {"interval": interval, "phase": phase, "snapshotBlock": snap, "nominationEnd": nom_end,
       "intervalEnd": end, "next": {"name": nxt_name, "block": nxt,
       "eta": now_ms + int((nxt - tip) * bt * 1000)},
       "state": safe("/blockchain/cgp"), "lastWinner": safe("/blockchain/winner")}

peers = None
try:
    with urllib.request.urlopen(a.api + "/network/connections/count", timeout=10) as r:
        peers = int(r.read().decode().strip())
except Exception:
    pass

total = safe("/blockchain/totalzp")
out = {
    "updated": now_ms,
    "height": tip,
    "tipTime": hs[-1][1] if hs else None,
    "synced": not info["initialBlockDownload"],
    "difficulty": info["difficulty"],
    "peers": peers,
    "totalZP": total / 1e8 if total is not None else None,
    "targetBlockTime": TARGET_BLOCK_S,
    "avgBlockTime24h": round(avg_bt_24h, 1) if avg_bt_24h else None,
    "blocks24h": len(day),
    "hashrate24h": round(hashrate_24h) if hashrate_24h else None,
    "series": series,
    "miners24h": miners,
    "recent": recent,
    "cgp": cgp,
}
tmp = a.out + ".tmp"
with open(tmp, "w") as f:
    json.dump(out, f, separators=(",", ":"))
os.replace(tmp, a.out)
print(f"stats: block {tip}, {len(series)} points, {len(miners)} miners")
