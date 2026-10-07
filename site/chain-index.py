#!/usr/bin/env python3
"""Index the ZP chain for the community site: assets (tokens) and the CGP voting history.

Reads blocks from the local node API (GET /blockchain/block) into a small SQLite database and
writes two static files for the site:

  assets.json       every asset: tokens outstanding, holders, transactions, issuing contract
  cgp-history.json  every CGP interval: allocation in force and decided, ballots with voters and
                    vote weight, payouts executed

The first run indexes from genesis (about an hour, in steps of --budget seconds); later runs only
add new blocks. Blocks closer than CONFIRM to the tip are not indexed, so a reorg cannot leave
stale rows behind. Runs every 5 minutes (systemd timer installed by site/setup-site.sh).

  python3 site/chain-index.py [--api http://127.0.0.1:11567] [--web /var/www/zen] [--budget 270]
"""
import argparse, hashlib, json, os, sqlite3, time, urllib.request

CGP_CONTRACT = "00000000cdaa2a511cd2e1d07555b00314d1be40a649d3b6f419eb1e4e7a8e63240a36d1"     # Chain.fs cgpContractId
VOTING_CONTRACT = "000000006ea5457ed23e3e13f31fe4cfd46c200587f2e4cc22df30ac77790f6d2c15cc12"  # Chain.fs votingContractId
INTERVAL, SNAPSHOT, NOMINATION = 10000, 9000, 500
COMMUNITY_INTERVAL_OFFSET = 24     # wallets and the explorer count intervals from the CGP launch
CONFIRM = 10

ap = argparse.ArgumentParser()
ap.add_argument("--api", default="http://127.0.0.1:11567")
ap.add_argument("--web", default="/var/www/zen")
ap.add_argument("--db", default="/var/lib/zen-stats/chain-index.sqlite")
ap.add_argument("--budget", type=float, default=270, help="seconds of indexing per run")
a = ap.parse_args()
here = os.path.dirname(os.path.abspath(__file__))


def get(path, timeout=60):
    with urllib.request.urlopen(a.api + path, timeout=timeout) as r:
        return json.loads(r.read().decode())


def post(path, body, timeout=120):
    req = urllib.request.Request(a.api + path, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


# ---- bech32 addresses (Wallet/Address.fs) ---------------------------------------------------
_B32 = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"


def _polymod(values):
    g, chk = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3], 1
    for v in values:
        b = chk >> 25
        chk = (chk & 0x1ffffff) << 5 ^ v
        for i in range(5):
            chk ^= g[i] if (b >> i) & 1 else 0
    return chk


def bech32(hrp, data_bytes):
    acc, bits, words = 0, 0, []
    for b in data_bytes:
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


def pk_address(pk_hex):
    return bech32("zen", hashlib.sha3_256(bytes.fromhex(pk_hex)).digest())


def contract_address(cid_hex):
    return bech32("czen", bytes.fromhex(cid_hex))


# ---- ballot decoding (Consensus/Serialization.fs: Ballot, Payout, Spend, Asset, Amount) ------
class R:
    def __init__(self, b): self.b, self.p = b, 0
    def u8(self): v = self.b[self.p]; self.p += 1; return v
    def take(self, n): v = self.b[self.p:self.p + n]; self.p += n; return v
    def uint(self, n): return int.from_bytes(self.take(n), "big")


def varint(r):
    n = 0
    while True:
        d = r.u8()
        n = n * 128 + (d & 0x7f)
        if d & 0x80: n += 1
        else: return n


def asset(r):
    first = r.u8()
    if first == 0:
        return "00"
    version = first & 0x1f
    vb = bytes([first])
    if first & 0x20:
        v = version * 128
        while True:
            b = r.u8(); vb += bytes([b]); nxt = v + (b & 0x7f)
            if not b & 0x80: version = nxt; break
            v = nxt * 128
    tag = first & 0xc0
    h = r.take(32).hex() if tag else "00" * 32
    sub = ""
    if tag == 0xc0: sub = r.take(32).hex()
    elif tag == 0x40: sub = r.take(r.u8()).hex()
    return "%08x%s" % (version, h) + (sub.ljust(64, "0") if sub.strip("0") else "")


def amount(r):
    first = r.u8()
    if (first & 0x7e) == 0x7e:
        if first >= 0x80: return r.uint(8)
        second, third, fourth = r.u8(), r.uint(2), r.uint(4)
        return fourth + (third << 32) + (second << 48)
    if first < 0x80:
        second = r.u8()
        if (first & 0x60) == 0x60: return (second + 0x400) * 10 ** (first & 0x1f)
        return (second + ((first & 0x03) << 8)) * 10 ** ((first & 0x7c) >> 2)
    second, lower = r.u8(), r.uint(2)
    if (first & 0x40) == 0:
        return (lower + (second << 16) + ((first & 0x03) << 24)) * 10 ** ((first & 0x3c) >> 2)
    return (lower + (second << 16) + ((first & 0x01) << 24) + 0x4000000) * 10 ** ((first & 0x1e) >> 1)


def ballot(hex_str):
    """{'allocation': pct} or {'recipient': address, 'spends': [[asset, amount]]}"""
    r = R(bytes.fromhex(hex_str))
    kind = r.u8()
    if kind == 1:
        return {"allocation": r.u8()}
    if kind == 2:
        rk = r.u8()
        if rk == 1: rec = bech32("zen", r.take(32))
        elif rk == 2:
            ver = varint(r); rec = contract_address("%08x" % ver + r.take(32).hex())
        else: raise ValueError("recipient")
        return {"recipient": rec, "spends": [[asset(r), str(amount(r))] for _ in range(varint(r))]}
    raise ValueError("ballot")


def body_entries(mb):
    """messageBody JSON {"dict": [[key, {type: value}], ...]} -> {key: (type, value)}"""
    out = {}
    for k, v in (mb or {}).get("dict", []) or []:
        (t, val), = v.items()
        out[k] = (t, val)
    return out


# ---- database ---------------------------------------------------------------------------------
os.makedirs(os.path.dirname(a.db), exist_ok=True)
# one run at a time (timer, manual runs): a second run exits quietly
import fcntl, sys
_lock = open(a.db + ".lock", "w")
try:
    fcntl.flock(_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    print("chain-index: another run is in progress"); sys.exit(0)
db = sqlite3.connect(a.db, timeout=60)
db.executescript("""
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS utxo (outpoint TEXT PRIMARY KEY, asset TEXT, address TEXT, amount TEXT);
CREATE INDEX IF NOT EXISTS utxo_asset ON utxo(asset);
CREATE TABLE IF NOT EXISTS assets (asset TEXT PRIMARY KEY, contract TEXT, minted TEXT DEFAULT '0', destroyed TEXT DEFAULT '0',
                                   txs INTEGER DEFAULT 0, first_block INTEGER);
CREATE TABLE IF NOT EXISTS votes (tx TEXT, block INTEGER, time INTEGER, command TEXT, pk TEXT, ballot TEXT, PRIMARY KEY (tx, pk, command));
CREATE TABLE IF NOT EXISTS payouts (tx TEXT, block INTEGER, time INTEGER, recipient TEXT, asset TEXT, amount TEXT);
CREATE TABLE IF NOT EXISTS allocation (interval INTEGER PRIMARY KEY, pct INTEGER, block INTEGER);
CREATE TABLE IF NOT EXISTS weights (interval INTEGER, pk TEXT, zp TEXT, PRIMARY KEY (interval, pk));
""")


def meta(k, default=None):
    row = db.execute("SELECT v FROM meta WHERE k=?", (k,)).fetchone()
    return row[0] if row else default


def lock_info(lock):
    """(kind, address, contract) of an output lock JSON"""
    if isinstance(lock, str):
        return lock, None, None            # Fee, ActivationSacrifice, Destroy, ...
    (kind, v), = lock.items()
    if kind in ("PK", "Coinbase"): return kind, v.get("address"), None
    if kind == "Contract": return kind, v.get("address"), v.get("id")
    return kind, v.get("address") if isinstance(v, dict) else None, None


def index_block(n):
    blk = get(f"/blockchain/block?blockNumber={n}")
    ts = blk["header"]["timestamp"]
    for txh, tx in blk["transactions"].items():
        touched = set()
        witnesses = [w.get("ContractWitness") for w in tx.get("witness", []) if "ContractWitness" in w]
        mint_contract = next((w["contractId"] for w in witnesses), None)
        for inp in tx.get("inputs", []):
            if "outpoint" in inp:
                op = "%s:%d" % (inp["outpoint"]["txHash"], inp["outpoint"]["index"])
                row = db.execute("SELECT asset FROM utxo WHERE outpoint=?", (op,)).fetchone()
                if row:
                    touched.add(row[0]); db.execute("DELETE FROM utxo WHERE outpoint=?", (op,))
            elif "mint" in inp:
                m = inp["mint"]; touched.add(m["asset"])
                db.execute("INSERT OR IGNORE INTO assets(asset, contract, first_block) VALUES (?,?,?)", (m["asset"], mint_contract or m["asset"][:72], n))
                cur = db.execute("SELECT minted FROM assets WHERE asset=?", (m["asset"],)).fetchone()[0]
                db.execute("UPDATE assets SET minted=? WHERE asset=?", (str(int(cur) + int(m["amount"])), m["asset"]))
        coinbase_miner = coinbase_cgp = 0
        for i, out in enumerate(tx.get("outputs", [])):
            kind, addr, cid = lock_info(out["lock"])
            sp = out["spend"]; touched.add(sp["asset"])
            if kind == "Coinbase": coinbase_miner += int(sp["amount"]) if sp["asset"] == "00" else 0
            if kind == "Contract" and cid == CGP_CONTRACT and sp["asset"] == "00": coinbase_cgp += int(sp["amount"])
            if kind == "Destroy":
                db.execute("INSERT OR IGNORE INTO assets(asset, contract, first_block) VALUES (?,?,?)", (sp["asset"], sp["asset"][:72], n))
                cur = db.execute("SELECT destroyed FROM assets WHERE asset=?", (sp["asset"],)).fetchone()[0]
                db.execute("UPDATE assets SET destroyed=? WHERE asset=?", (str(int(cur) + int(sp["amount"])), sp["asset"]))
            if addr and kind in ("PK", "Coinbase", "Contract"):
                db.execute("INSERT OR REPLACE INTO utxo VALUES (?,?,?,?)", ("%s:%d" % (txh, i), sp["asset"], addr, sp["amount"]))
        # allocation in force: the CGP share of the coinbase of the first block seen in each interval
        if coinbase_miner:
            iv = (n - 1) // INTERVAL + 1
            if not db.execute("SELECT 1 FROM allocation WHERE interval=?", (iv,)).fetchone():
                total = coinbase_miner + coinbase_cgp
                db.execute("INSERT INTO allocation VALUES (?,?,?)", (iv, round(coinbase_cgp * 100 / total) if total else 0, n))
        for w in witnesses:
            if w["contractId"] == VOTING_CONTRACT and w["command"] in ("Allocation", "Payout", "Nomination"):
                e = body_entries(w.get("messageBody"))
                b = next((v for k, (t, v) in e.items() if k != "Signature" and t == "string"), None)
                sigs = e.get("Signature", (None, None))[1] or []
                for pk, _sig in sigs:
                    db.execute("INSERT OR IGNORE INTO votes VALUES (?,?,?,?,?,?)", (txh, n, ts, w["command"], pk, b))
            if w["contractId"] == CGP_CONTRACT and w["command"] == "Payout":
                for out in tx.get("outputs", []):
                    kind, addr, cid = lock_info(out["lock"])
                    if kind in ("PK", "Contract") and cid != CGP_CONTRACT:
                        db.execute("INSERT INTO payouts VALUES (?,?,?,?,?,?)", (txh, n, ts, addr, out["spend"]["asset"], out["spend"]["amount"]))
        for asset_id in touched:
            db.execute("INSERT OR IGNORE INTO assets(asset, contract, first_block) VALUES (?,?,?)", (asset_id, "" if asset_id == "00" else asset_id[:72], n))
            db.execute("UPDATE assets SET txs = txs + 1 WHERE asset=?", (asset_id,))


# ---- index new blocks -------------------------------------------------------------------------
tip = get("/blockchain/info")["blocks"]
last = int(meta("last", "0"))
target = tip - CONFIRM
start = time.time()
while last < target and time.time() - start < a.budget:
    upto = min(target, last + 500)
    with db:
        for n in range(last + 1, upto + 1):
            index_block(n)
        last = upto
        db.execute("INSERT OR REPLACE INTO meta VALUES ('last', ?)", (str(last),))
print(f"chain-index: block {last} of {tip} ({'synced' if last >= target else 'catching up'})")

# ---- vote weights: balance at the snapshot block (address index), cached ----------------------
def weight(iv, pk):
    row = db.execute("SELECT zp FROM weights WHERE interval=? AND pk=?", (iv, pk)).fetchone()
    if row: return int(row[0])
    snap = (iv - 1) * INTERVAL + SNAPSHOT
    try:
        bal = post("/addressdb/balance", {"addresses": [pk_address(pk)], "blockNumber": str(snap)}, timeout=120)
        zp = sum(int(x["balance"]) for x in bal if x["asset"] == "00")
    except Exception:
        return None
    with db:
        db.execute("INSERT OR REPLACE INTO weights VALUES (?,?,?)", (iv, pk, str(zp)))
    return zp


# ---- cgp-history.json -------------------------------------------------------------------------
names = {}
try:
    with open(os.path.join(here, "contract-names.json")) as f:
        names = {k: v for k, v in json.load(f).items() if not k.startswith("_")}
except Exception:
    pass

alloc = dict(db.execute("SELECT interval, pct FROM allocation"))
intervals = {}
for tx, blk, ts, cmd, pk, b in db.execute("SELECT tx, block, time, command, pk, ballot FROM votes ORDER BY block, tx"):
    iv = (blk - 1) // INTERVAL + 1
    snap = (iv - 1) * INTERVAL + SNAPSHOT
    nom_end = snap + NOMINATION
    in_window = (snap < blk <= nom_end) if cmd == "Nomination" else (nom_end < blk <= iv * INTERVAL)
    try: dec = ballot(b) if b else None
    except Exception: dec = None
    it = intervals.setdefault(iv, {"votes": [], "seen": set()})
    key = (cmd, pk)
    counted = in_window and key not in it["seen"]       # only the first vote of a key per ballot type counts
    if counted: it["seen"].add(key)
    it["votes"].append({"tx": tx, "block": blk, "time": ts, "command": cmd, "voter": pk_address(pk), "ballot": dec,
                        "counted": counted, "weight": None, "_pk": pk})

if last >= target:          # weights only once the index is complete (they come from the address index)
    for iv, it in intervals.items():
        for v in it["votes"]:
            if v["counted"]:
                w = weight(iv, v["_pk"])
                v["weight"] = None if w is None else w / 1e8

payouts = {}
for tx, blk, ts, rec, asset_id, amt in db.execute("SELECT tx, block, time, recipient, asset, amount FROM payouts ORDER BY block"):
    iv = (blk - 2) // INTERVAL + 1          # paid at the end of the interval that voted for it
    payouts.setdefault(iv, []).append({"tx": tx, "block": blk, "time": ts, "recipient": rec, "recipientName": names.get(rec),
                                       "asset": asset_id, "amount": int(amt) / 1e8 if asset_id == "00" else amt})

out = []
current = (tip - 1) // INTERVAL + 1
first = min([*intervals, *payouts, current])
for iv in range(first, current + 1):
    it = intervals.get(iv, {"votes": []})
    vs = it["votes"]
    for v in vs: v.pop("_pk", None)
    weight_by = {}
    for v in vs:
        if v["counted"] and v["weight"] is not None and v["ballot"]:
            k = json.dumps(v["ballot"], sort_keys=True) + v["command"]
            weight_by[k] = weight_by.get(k, 0) + v["weight"]
    out.append({
        "interval": iv, "communityInterval": iv - COMMUNITY_INTERVAL_OFFSET,
        "start": (iv - 1) * INTERVAL + 1, "snapshot": (iv - 1) * INTERVAL + SNAPSHOT,
        "nominationEnd": (iv - 1) * INTERVAL + SNAPSHOT + NOMINATION, "end": iv * INTERVAL,
        "complete": tip > iv * INTERVAL,
        "allocationInForce": alloc.get(iv),
        "allocationDecided": alloc.get(iv + 1),
        "voters": len({v["voter"] for v in vs}),
        "weightVoted": round(sum(v["weight"] or 0 for v in vs if v["counted"]), 8),
        "votes": vs,
        "payouts": payouts.get(iv, []),
    })
out.reverse()
os.makedirs(a.web, exist_ok=True)
for name, data in (("cgp-history.json", {"updated": int(time.time() * 1000), "indexedTo": last, "tip": tip,
                                          "complete": last >= target, "intervals": out}),):
    tmp = os.path.join(a.web, name + ".tmp")
    with open(tmp, "w") as f: json.dump(data, f, separators=(",", ":"))
    os.replace(tmp, os.path.join(a.web, name))

# ---- assets.json ------------------------------------------------------------------------------
asset_names = {}
try:
    with open(os.path.join(here, "asset-names.json")) as f:
        asset_names = {k: v for k, v in json.load(f).items() if not k.startswith("_")}
except Exception:
    pass
outstanding, holders = {}, {}
for asset_id, address, amt in db.execute("SELECT asset, address, amount FROM utxo"):
    outstanding[asset_id] = outstanding.get(asset_id, 0) + int(amt)
    holders.setdefault(asset_id, set()).add(address)
def subtype_text(asset_id):
    """readable subtype of an asset, e.g. Bull / Bear"""
    sub = bytes.fromhex(asset_id[72:]).rstrip(b"\0") if len(asset_id) > 72 else b""
    return sub.decode() if sub and all(32 < c < 127 for c in sub) else None


def asset_name(asset_id, contract):
    if asset_id == "00": return "ZP"
    base = asset_names.get(asset_id) or (names.get(contract) and names[contract] + " token")
    sub = subtype_text(asset_id)
    return " ".join(x for x in (base, sub) if x) or None


rows = []
for asset_id, contract, minted, destroyed, txs, fb in db.execute("SELECT asset, contract, minted, destroyed, txs, first_block FROM assets"):
    rows.append({"asset": asset_id, "name": asset_name(asset_id, contract),
                 "contract": contract or None, "contractAddress": contract_address(contract) if contract and len(contract) == 72 else None,
                 "contractName": names.get(contract), "outstanding": outstanding.get(asset_id, 0) / 1e8,
                 "minted": int(minted) / 1e8, "destroyed": int(destroyed) / 1e8,
                 "holders": len(holders.get(asset_id, ())), "txs": txs, "firstBlock": fb})
rows.sort(key=lambda r: (r["asset"] != "00", -r["txs"]))
tmp = os.path.join(a.web, "assets.json.tmp")
with open(tmp, "w") as f:
    json.dump({"updated": int(time.time() * 1000), "indexedTo": last, "tip": tip, "complete": last >= target, "assets": rows}, f, separators=(",", ":"))
os.replace(tmp, os.path.join(a.web, "assets.json"))
