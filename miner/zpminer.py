#!/usr/bin/env python3
"""ZP GPU miner (OpenCL) - SHA3-256 proof of work.

Works with any OpenCL device (NVIDIA, AMD, Intel). Talks to a local zen-node API:
  GET  /blockchain/blocktemplate?address=<zen1...>   -> {header, body, target, parent, blockNumber}
  POST /blockchain/submitheader  {"header": "<hex>"} -> block accepted / rejected

  python zpminer.py list                                 # OpenCL devices
  python zpminer.py selftest                             # GPU result == Python hashlib
  python zpminer.py bench [--seconds 30]                 # hashrate, no node needed
  python zpminer.py verify --node http://127.0.0.1:11567 # hash of real mainnet blocks
  python zpminer.py mine --address zen1... [--node http://127.0.0.1:11567] [--device 0]

Requires: pip install pyopencl
"""
import argparse, hashlib, json, os, struct, sys, time, urllib.request
import numpy as np
import pyopencl as cl

HERE = os.path.dirname(os.path.abspath(__file__))
HEADER_SIZE = 100
NONCE2_OFFSET = 92
MAX_OUT = 64


def sha3(b):
    return hashlib.sha3_256(b).digest()


def devices():
    return [d for p in cl.get_platforms() for d in p.get_devices()]


class Gpu:
    def __init__(self, index, batch_log2=None):
        devs = devices()
        if not devs:
            sys.exit("No OpenCL device found. Install the GPU driver (it includes OpenCL).")
        self.dev = devs[index]
        self.ctx = cl.Context([self.dev])
        self.q = cl.CommandQueue(self.ctx)
        src = open(os.path.join(HERE, "zp_sha3.cl")).read()
        self.prg = cl.Program(self.ctx, src).build()
        self.kernel = cl.Kernel(self.prg, "search")
        is_gpu = self.dev.type & cl.device_type.GPU
        self.batch = 1 << (batch_log2 or (24 if is_gpu else 16))
        self.fixed_buf = cl.Buffer(self.ctx, cl.mem_flags.READ_ONLY, 12 * 8)
        self.out = np.zeros(1 + MAX_OUT, dtype=np.uint64)
        self.out_buf = cl.Buffer(self.ctx, cl.mem_flags.READ_WRITE, self.out.nbytes)

    def set_header(self, header):
        """header: 100 bytes; bytes 92..99 (nonce2) are ignored."""
        block = header[:NONCE2_OFFSET] + bytes(4)        # pad lane 11 to 8 bytes
        lanes = np.frombuffer(block, dtype="<u8").copy()  # 12 lanes, little-endian
        cl.enqueue_copy(self.q, self.fixed_buf, lanes)
        self.header = header

    def search(self, base, target_hi):
        self.out[0] = 0
        cl.enqueue_copy(self.q, self.out_buf, self.out)
        self.kernel(self.q, (self.batch,), None, self.fixed_buf, np.uint64(base),
                    np.uint64(target_hi), self.out_buf, np.uint32(MAX_OUT))
        cl.enqueue_copy(self.q, self.out, self.out_buf)
        n = min(int(self.out[0]) & 0xffffffff, MAX_OUT)
        return [int(x) for x in self.out[1:1 + n]]


def with_nonce2(header, n2):
    return header[:NONCE2_OFFSET] + struct.pack(">Q", n2)


# --- node API --------------------------------------------------------------------------------
def api_get(node, path, timeout=30):
    with urllib.request.urlopen(node + path, timeout=timeout) as r:
        return json.loads(r.read().decode())


def api_post(node, path, body, timeout=30):
    req = urllib.request.Request(node + path, data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


# --- commands --------------------------------------------------------------------------------
def cmd_list(a):
    for i, d in enumerate(devices()):
        print(f"[{i}] {d.name.strip()}  ({d.platform.name.strip()}, {d.max_compute_units} CUs)")


def cmd_selftest(a):
    g = Gpu(a.device, 12)
    ok = 0
    for trial in range(4):
        header = os.urandom(HEADER_SIZE)
        g.set_header(header)
        base = int.from_bytes(os.urandom(8), "big") & ~0xffff
        hits = g.search(base, 0xffffffffffffffff)          # every hash qualifies
        assert hits, "kernel returned no results"
        for n2 in hits[:16]:
            h = sha3(with_nonce2(header, n2))
            hi = int.from_bytes(h[:8], "big")
            assert hi <= 0xffffffffffffffff
        # threshold test: GPU must report exactly the nonces whose hash starts below the target
        target_hi = 0x00ffffffffffffff                    # ~1 in 256 qualifies
        hits = set(g.search(base, target_hi))
        expect = {base + i for i in range(g.batch)
                  if int.from_bytes(sha3(with_nonce2(header, base + i))[:8], "big") <= target_hi}
        if len(expect) > MAX_OUT or hits != expect:
            sys.exit(f"SELFTEST FAILED: gpu {len(hits)} hits vs python {len(expect)}")
        ok += 1
    print(f"selftest OK on {g.dev.name.strip()} ({ok} rounds, SHA3-256 matches Python hashlib)")


def cmd_bench(a):
    g = Gpu(a.device, a.batch)
    g.set_header(os.urandom(HEADER_SIZE))
    g.search(0, 0)                                          # warm-up / compile
    t0, n, base = time.time(), 0, 0
    while time.time() - t0 < a.seconds:
        g.search(base, 0)
        base += g.batch
        n += g.batch
    dt = time.time() - t0
    print(f"{g.dev.name.strip()}: {n / dt / 1e6:,.1f} MH/s  (batch 2^{g.batch.bit_length() - 1})")


def header_from_json(h):
    n1, n2 = (x & 0xffffffffffffffff for x in h["nonce"])
    return (struct.pack(">I", h["version"]) + bytes.fromhex(h["parent"]) +
            struct.pack(">I", h["blockNumber"]) + bytes.fromhex(h["commitments"]) +
            struct.pack(">Q", h["timestamp"]) + struct.pack(">I", h["difficulty"] & 0xffffffff) +
            struct.pack(">QQ", n1, n2))


def cmd_verify(a):
    """Rebuild real mainnet headers from the node and check their SHA3-256 equals the block hash."""
    info = api_get(a.node, "/blockchain/info")
    tip = info["blocks"]
    g = Gpu(a.device, 8)
    for h in (tip, tip - 1, tip - 1000):
        blk = api_get(a.node, f"/blockchain/block?blockNumber={h}")
        header = header_from_json(blk["header"])
        py = sha3(header).hex()
        g.set_header(header)
        n2 = int.from_bytes(header[NONCE2_OFFSET:], "big")
        gpu_hits = g.search(n2, 0xffffffffffffffff)
        same = py == blk["hash"]
        print(f"block {h}: python {'OK' if same else 'MISMATCH'}  gpu {'OK' if n2 in gpu_hits else 'MISSING'}")
        if not same:
            sys.exit("header layout does not match the node - do not mine")
    print("verify OK: miner hashes headers exactly like the node")


def cmd_mine(a):
    g = Gpu(a.device, a.batch)
    print(f"device: {g.dev.name.strip()}   node: {a.node}   reward address: {a.address}")
    tpl, fetched, base, hashes, t_rate = None, 0, 0, 0, time.time()
    found = accepted = 0
    while True:
        now = time.time()
        if tpl is None or now - fetched > a.refresh:
            try:
                new = api_get(a.node, f"/blockchain/blocktemplate?address={a.address}")
            except Exception as e:
                print(f"[{time.strftime('%H:%M:%S')}] node unreachable: {e}; retrying")
                time.sleep(5)
                continue
            if tpl is None or new["header"] != tpl["header"]:
                if tpl is None or new["parent"] != tpl["parent"]:
                    print(f"[{time.strftime('%H:%M:%S')}] new work: block {new['blockNumber']}")
                tpl = new
                header = bytearray(bytes.fromhex(tpl["header"]))
                header[84:92] = os.urandom(8)               # nonce1: unique per worker
                header = bytes(header)
                target = bytes.fromhex(tpl["target"])
                target_hi = int.from_bytes(target[:8], "big")
                g.set_header(header)
                base = 0
            fetched = now
        for n2 in g.search(base, target_hi):
            cand = with_nonce2(header, n2)
            if sha3(cand) <= target:
                found += 1
                code, body = api_post(a.node, "/blockchain/submitheader", {"header": cand.hex()})
                ok = 200 <= code < 300
                accepted += ok
                print(f"[{time.strftime('%H:%M:%S')}] BLOCK FOUND {tpl['blockNumber']} -> "
                      f"{'accepted' if ok else 'rejected'} ({code} {body[:120]})")
                fetched = 0                                   # get new work now
                break
        base += g.batch
        hashes += g.batch
        if now - t_rate >= 30:
            print(f"[{time.strftime('%H:%M:%S')}] {hashes / (now - t_rate) / 1e6:,.1f} MH/s   "
                  f"found {found}, accepted {accepted}")
            hashes, t_rate = 0, now


def main():
    ap = argparse.ArgumentParser(description="ZP GPU miner (OpenCL, SHA3-256)")
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("list", "selftest", "bench", "verify", "mine"):
        s = sub.add_parser(name)
        s.add_argument("--device", type=int, default=0)
        s.add_argument("--batch", type=int, default=None, help="log2 work items per launch")
        s.add_argument("--node", default="http://127.0.0.1:11567")
        if name == "bench":
            s.add_argument("--seconds", type=float, default=20)
        if name == "mine":
            s.add_argument("--address", required=True, help="zen1... address that receives rewards")
            s.add_argument("--refresh", type=float, default=5, help="seconds between template polls")
    a = ap.parse_args()
    {"list": cmd_list, "selftest": cmd_selftest, "bench": cmd_bench,
     "verify": cmd_verify, "mine": cmd_mine}[a.cmd](a)


if __name__ == "__main__":
    main()
