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
MAX_FETCH = 800                   # block bodies fetched per run (first run fills the cache gradually)
GENESIS_ZP = 20_000_000
INITIAL_REWARD = 50 * 10**8       # kalapas, halves every PERIOD blocks
PERIOD = 800_000
BUCKET_S = 4 * 3600               # ~60 blocks per point; hourly is too noisy
CGP_CONTRACT = "00000000cdaa2a511cd2e1d07555b00314d1be40a649d3b6f419eb1e4e7a8e63240a36d1"   # Chain.fs cgpContractId
COMMUNITY_INTERVAL_OFFSET = 24    # wallets and the explorer count intervals from the CGP launch: 106 -> 82

ap = argparse.ArgumentParser()
ap.add_argument("--api", default="http://127.0.0.1:11567")
ap.add_argument("--out", default="/var/www/zen/stats.json")
ap.add_argument("--cache", default="/var/lib/zen-stats/miners.json")
a = ap.parse_args()


def get(path, timeout=60):
    with urllib.request.urlopen(a.api + path, timeout=timeout) as r:
        return json.loads(r.read().decode())


def get_post(path, body, timeout=60):
    req = urllib.request.Request(a.api + path, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def safe(path):
    try:
        return get(path)
    except Exception:
        return None


_B32 = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"


def _polymod(values):
    g, chk = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3], 1
    for v in values:
        b = chk >> 25
        chk = (chk & 0x1ffffff) << 5 ^ v
        for i in range(5):
            chk ^= g[i] if (b >> i) & 1 else 0
    return chk


def contract_address(contract_id_hex, hrp="czen"):
    """Bech32 address of a contract (Wallet/Address.fs: version byte 0 + 5-bit words of the 36-byte id)."""
    acc, bits, words = 0, 0, []
    for b in bytes.fromhex(contract_id_hex):
        acc, bits = (acc << 8) | b, bits + 8
        while bits >= 5:
            bits -= 5
            words.append((acc >> bits) & 31)
    if bits:
        words.append((acc << (5 - bits)) & 31)
    data = [0] + words
    hv = [ord(c) >> 5 for c in hrp] + [0] + [ord(c) & 31 for c in hrp]
    pm = _polymod(hv + data + [0] * 6) ^ 1
    return hrp + "1" + "".join(_B32[d] for d in data + [(pm >> 5 * (5 - i)) & 31 for i in range(6)])


def hashes_per_block(target_hex):
    return 2 ** 256 // (int(target_hex, 16) + 1)


def difficulty(compact_hex):
    """Same formula as the node's /blockchain/info (Bitcoin-style difficulty)."""
    c = int(compact_hex, 16)
    shift, diff = (c >> 24) & 0xff, 0xffff / max(1, c & 0xffffff)
    return diff * 256.0 ** (29 - shift)


info = get("/blockchain/info")
tip = info["blocks"]
now_ms = int(time.time() * 1000)

# --- headers: block times, hashrate --------------------------------------------------------
headers = get(f"/blockchain/headers?blockNumber={tip}&take={HEADERS_TAKE}", timeout=180)
headers.sort(key=lambda h: h["blockNumber"])
hs = [(h["blockNumber"], h["timestamp"], hashes_per_block(h["target"]), difficulty(h["difficulty"]))
      for h in headers]

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
        _, t, w, d = hs[i]
        if t < start:
            continue
        b = buckets.setdefault(t // hour * hour, [0, 0, 0.0])
        b[0] += 1
        b[1] += w
        b[2] += d
    for t in sorted(buckets):
        n, w, d = buckets[t]
        series.append({"t": t, "blocks": n,
                       "blockTime": round(BUCKET_S / n, 1),
                       "hashrate": round(w / BUCKET_S),
                       "difficulty": round(d / n, 2)})
    if series and now_ms - series[-1]["t"] < BUCKET_S * 1000:
        series.pop()                     # current bucket is still incomplete

# --- block bodies (cached by height): miners of the last 24h, transactions per day ---------
cache = {}
try:
    with open(a.cache) as f:
        cache = {int(k): v for k, v in json.load(f).items()}
except Exception:
    pass

recent = []
day_heights = [r[0] for r in day] or [tip]
oldest = hs[0][0] if hs else tip
fetched = 0
for h in range(tip, oldest - 1, -1):
    if h not in cache and fetched < MAX_FETCH:
        fetched += 1
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
cache = {h: v for h, v in cache.items() if h >= oldest}
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
# transactions per UTC day (coinbase excluded); only days fully covered by cached blocks
DAY = 86400 * 1000
covered_from = min((h for h in cache), default=tip)
days = {}
for h, c in cache.items():
    d = days.setdefault(c["t"] // DAY * DAY, [0, 0])
    d[0] += 1
    d[1] += max(0, c["n"] - 1)
first_full = (cache[covered_from]["t"] // DAY + 1) * DAY if cache else now_ms
daily = [{"t": t, "blocks": v[0], "txs": v[1], "partial": t + DAY > now_ms}
         for t, v in sorted(days.items()) if t >= first_full]
txs24h = sum(max(0, cache[h]["n"] - 1) for h in day_heights if h in cache)
txs24h_complete = all(h in cache for h in day_heights)

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
cgp = {"interval": interval, "communityInterval": interval - COMMUNITY_INTERVAL_OFFSET, "phase": phase, "snapshotBlock": snap, "nominationEnd": nom_end,
       "intervalEnd": end, "next": {"name": nxt_name, "block": nxt,
       "eta": now_ms + int((nxt - tip) * bt * 1000)},
       "state": safe("/blockchain/cgp"), "lastWinner": safe("/blockchain/winner")}

# CGP fund balance: outputs locked to the CGP contract (address index). Can be slow: long timeout,
# and the last good value is kept when a run fails.
cgp_addr = contract_address(CGP_CONTRACT)
prev = {}
try:
    with open(a.out) as f:
        prev = json.load(f).get("cgp", {})
except Exception:
    pass
cgp["contractAddress"] = cgp_addr
try:
    bal = get_post("/addressdb/balance", {"addresses": [cgp_addr]}, timeout=240)
    zp = sum(int(x["balance"]) for x in bal if x["asset"] == "00")
    cgp["balance"] = {"zp": zp / 1e8, "block": tip}
except Exception:
    cgp["balance"] = prev.get("balance")

# active contracts (names: site/contract-names.json)
names = {}
try:
    with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "contract-names.json")) as f:
        names = {k: v for k, v in json.load(f).items() if not k.startswith("_")}
except Exception:
    pass
contracts = []
for c in safe("/contract/active") or []:
    addr = c.get("address", "")
    name = names.get(addr) or names.get(c.get("contractId"))
    contracts.append({"id": c.get("contractId"), "address": addr, "name": name, "expire": c.get("expire"),
                      "blocksLeft": (c.get("expire") or tip) - tip})
contracts.sort(key=lambda c: c["expire"] or 0)

peers = None
try:
    with urllib.request.urlopen(a.api + "/network/connections/count", timeout=10) as r:
        peers = int(r.read().decode().strip())
except Exception:
    pass

total = safe("/blockchain/totalzp")
max_kalapas = GENESIS_ZP * 10**8 + PERIOD * sum(INITIAL_REWARD >> k for k in range(64))
period = (tip - 2) // PERIOD if tip >= 2 else 0
next_halving = (period + 1) * PERIOD + 2
alloc = (cgp["state"] or {}).get("allocation")
block_reward = (INITIAL_REWARD >> period) / 1e8
supply = {
    "max": max_kalapas / 1e8,
    "genesis": GENESIS_ZP,
    "blockReward": block_reward,
    "minerShare": None if alloc is None else 100 - alloc,
    "nextHalving": {"block": next_halving, "eta": now_ms + int((next_halving - tip) * bt * 1000),
                    "reward": block_reward / 2},
}
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
    "txs24h": txs24h if txs24h_complete else None,
    "daily": daily,
    "supply": supply,
    "series": series,
    "miners24h": miners,
    "recent": recent,
    "cgp": cgp,
    "contracts": contracts,
}
tmp = a.out + ".tmp"
with open(tmp, "w") as f:
    json.dump(out, f, separators=(",", ":"))
os.replace(tmp, a.out)
print(f"stats: block {tip}, {len(series)} points, {len(miners)} miners")
