// Small EVM helpers for trying the bridge on a test network (Base Sepolia). Test keys only: never use a key that holds real money.
//   node evm-tools.mjs newkey                         a new random key: prints the address and the private key
//   node evm-tools.mjs link <privateKey> <zpAddress>  prints the JSON for the bridge's POST /link (signs "Link <evm> to <zp>")
//   node evm-tools.mjs balance <address>              ETH and USDC of an address on the test network
//   node evm-tools.mjs send <privateKey> <to> <usdc>  sends test USDC (amount in USDC, e.g. 5 or 0.5)
// Environment: BRIDGE_EVM (rpc, default https://sepolia.base.org), BRIDGE_USDC (default Base Sepolia USDC)
import { ethers } from 'ethers';
const RPC = process.env.BRIDGE_EVM?.startsWith('http') ? process.env.BRIDGE_EVM : 'https://sepolia.base.org';
const USDC = process.env.BRIDGE_USDC || '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const ABI = ['function balanceOf(address) view returns (uint256)', 'function transfer(address,uint256) returns (bool)'];
const [cmd, a, b, c] = process.argv.slice(2);
const provider = new ethers.JsonRpcProvider(RPC);
const usdc = s => new ethers.Contract(USDC, ABI, s);
if (cmd === 'newkey') { const w = ethers.Wallet.createRandom(); console.log(JSON.stringify({ address: w.address, privateKey: w.privateKey }, null, 1)); }
else if (cmd === 'link') {
  const w = new ethers.Wallet(a), message = `Link ${w.address} to ${b}`;
  console.log(JSON.stringify({ evm: w.address, zp: b, message, signature: await w.signMessage(message) }));
} else if (cmd === 'balance') {
  const [eth, u] = await Promise.all([provider.getBalance(a), usdc(provider).balanceOf(a)]);
  console.log(`ETH ${ethers.formatEther(eth)}  USDC ${ethers.formatUnits(u, 6)}`);
} else if (cmd === 'send') {
  const w = new ethers.Wallet(a, provider), tx = await usdc(w).transfer(b, ethers.parseUnits(c, 6));
  console.log('sent', tx.hash); await tx.wait(); console.log('confirmed');
} else { console.error('commands: newkey | link <key> <zp> | balance <address> | send <key> <to> <usdc>'); process.exit(1); }
