#!/usr/bin/env python3
"""Collect real mainnet blocks that contain transactions (raw hex) as wallet test fixtures.

The wallet's serializer must reproduce every transaction byte for byte and get the same
transaction hash as the node. Blocks come from the public node's read-only API.
  python3 scripts/fetch-tx-fixtures.py https://zen.sealinkgps.com/node wallet/test/fixtures/blocks.json
"""
import json, sys, urllib.request

base, out = sys.argv[1], sys.argv[2]

def get(path):
    with urllib.request.urlopen(base + path, timeout=120) as r:
        return json.loads(r.read().decode())

tip = get("/blockchain/info")["blocks"]
# CGP voting/nomination windows (votes, nominations) and payout blocks of recent intervals,
# plus spread samples over the whole chain (ordinary transfers, contracts)
ranges = []
for k in range(1, 9):
    end = (tip // 10000 - k + 1) * 10000
    ranges.append((end, 1000))                       # blocks end-999 .. end: nomination + voting
    ranges.append((end - 10000 + 200, 200))          # start of the interval: payouts
for h in range(100000, tip, 100000):
    ranges.append((h, 300))

found, seen = [], set()
for top, take in ranges:
    for start in range(top, top - take, -100):
        try:
            blocks = get(f"/blockchain/blocks?blockNumber={start}&take=100")
        except Exception as e:
            print("skip", start, e)
            continue
        for b in blocks:
            n, raw = b["blockNumber"], b["rawBlock"]
            if n in seen or len(raw) < 1200:                 # coinbase-only blocks are small
                continue
            seen.add(n)
            found.append({"blockNumber": n, "rawBlock": raw})
    print(f"range {top}-{take}: {len(found)} blocks with transactions so far")
    if len(found) >= 120:
        break

found.sort(key=lambda b: -len(b["rawBlock"]))
keep = found[:60] + sorted(found[60:], key=lambda b: b["blockNumber"])[::max(1, len(found[60:]) // 40)]
with open(out, "w") as f:
    json.dump({"source": base, "tip": tip, "blocks": keep}, f)
print(f"wrote {len(keep)} blocks to {out}")
