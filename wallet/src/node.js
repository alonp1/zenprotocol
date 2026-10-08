// Client for a ZP node's public API (the community node's /node/ path, or a local node).
// Only read-only chain/address endpoints plus publishtransaction are used.

export class NodeError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

export class NodeClient {
  constructor(baseUrl, { timeoutMs = 30000, fetchFn } = {}) {
    this.base = baseUrl.replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
    this.fetch = fetchFn || ((...a) => globalThis.fetch(...a));   // unbound window.fetch throws "Illegal invocation"
  }

  async request(path, body) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res;
    try {
      res = await this.fetch(this.base + path, body === undefined
        ? { signal: ctrl.signal }
        : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal });
    } catch (e) {
      throw new NodeError(e.name === 'AbortError' ? 'Node did not answer in time' : 'Node unreachable', 0);
    } finally { clearTimeout(timer); }
    const text = await res.text();
    if (!res.ok) throw new NodeError(text.replace(/<[^>]*>/g, ' ').trim().slice(0, 200) || `HTTP ${res.status}`, res.status);
    try { return text ? JSON.parse(text) : null; } catch { return text; }
  }

  info() { return this.request('/blockchain/info'); }
  cgp() { return this.request('/blockchain/cgp'); }
  // [{asset, balance}] - unspent, includes immature coinbase outputs
  balance(addresses) { return this.request('/addressdb/balance', { addresses }); }
  // [{outpoint:{txHash,index}, lock, spend:{asset,amount}}]
  outputs(addresses) { return this.request('/addressdb/outputs', { addresses, mode: 'unspentOnly' }); }
  // [{txHash, asset, amount (signed string), confirmations, timestamp, lock}]
  history(addresses, skip = 0, take = 50) { return this.request('/addressdb/transactions', { addresses, skip, take }); }
  // [{address, hasBalance, hasTxs}]
  discovery(addresses) { return this.request('/addressdb/discovery', { addresses, full: false }); }
  // [{contractId, address, expire, code}]
  activeContracts() { return this.request('/contract/active'); }
  // text/plain hex of the transaction with the contract witness added by the node
  executeContract(body) { return this.request('/blockchain/contract/execute', body); }
  candidates() { return this.request('/blockchain/candidates'); }
  publish(txHex) { return this.request('/blockchain/publishtransaction', { tx: txHex }); }
}

export const DEFAULT_NODES = {
  main: ['https://zen.sealinkgps.com/node'],
  test: [],
};
