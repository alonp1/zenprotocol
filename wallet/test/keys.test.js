import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountFromMnemonic, receiveAddress, decodeAddress, encodeAddress, checkMnemonic } from '../src/keys.js';

// Reference: zen-node 1.0.13 /wallet/import + /wallet/address in CI (.github/workflows/build.yml)
const ABANDON = Array(23).fill('abandon').concat('art');
const NODE_ADDRESS = 'zen1qqfjjy6ewd4thlj7erqsp2575hnm9mqnlrpaze9z6aafa7camxzdqxkdj9s';

test('receive address matches zen-node for the test mnemonic', () => {
  assert.equal(receiveAddress(accountFromMnemonic(ABANDON)), NODE_ADDRESS);
});

test('address round trip', () => {
  const d = decodeAddress(NODE_ADDRESS);
  assert.equal(d.chain, 'main'); assert.equal(d.contract, false); assert.equal(d.hash.length, 32);
  assert.equal(encodeAddress(d.hash), NODE_ADDRESS);
});

test('mnemonic validation', () => {
  assert.equal(checkMnemonic(ABANDON), true);
  assert.equal(checkMnemonic(Array(24).fill('abandon')), false);
});
