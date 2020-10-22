const assert = require('assert');
const { MerkleTree } = require('merkle-trees/js');

const { to32ByteBuffer, hashPacked, toHex, toBuffer } = require('./utils');

const COST_PER_PACK = BigInt('10') ** BigInt('12');
const CARDS_PER_PACK = BigInt('10');

const treeOptions = {
  sortedHash: false,
  unbalanced: true,
  elementPrefix: '0000000000000000000000000000000000000000000000000000000000000000',
};

const getInitialState = (_user) => {
  const newState = hashPacked([to32ByteBuffer(0), to32ByteBuffer(0)]);
  const packsTree = new MerkleTree([], treeOptions);
  const cardsTree = new MerkleTree([], treeOptions);

  return { packsTree, cardsTree };
};

// Impure, so takes impurities
// Note: Unlike the smart contract, which needed the current state root, this takes the entire current state
//       and outputs the entire state. Think of it as a more transparent version of what's happening on chain.
//       So you don't need things like roots or merkle proofs, like the smart contract does!
// Note: Even if user is not used, its a good idea to keep the interface consistent, as it might be.
const buyPacks = (_user, _currentState, impurities = {}) => {
  const user = toBuffer(_user);
  const value = BigInt(impurities.value);
  const blockhash = toBuffer(impurities.blockHash);
  const packCount = value / COST_PER_PACK;
  assert(packCount > 0n, 'Incorrect payment.');

  const { packsTree, cardsTree } = _currentState;

  const packs = Array(packCount)
    .fill(null)
    .map((_, i) => hashPacked([user, to32ByteBuffer(i), blockhash]));

  const newPacksArray = packsTree.elements.concat(packs);
  const newPacksTree = new MerkleTree(newPacksArray, treeOptions);

  return { packsTree: newPacksTree, cardsTree };
};

const openPack = (_user, _currentState, _packIndex, _pack, _packsRoot, _packProof, _cardsRoot, _cardsAppendProof) => {
  const user = toBuffer(_user);
  const currentState = toBuffer(_currentState);
  const packIndex = toBuffer(_packIndex);
  const pack = toBuffer(_pack);
  const packsRoot = toBuffer(_packsRoot);
  const packProof = toBuffer(_packProof);
  const cardsRoot = toBuffer(_cardsRoot);
  const cardsAppendProof = toBuffer(_cardsAppendProof);

  assert(hashPacked([packsRoot, cardsRoot]) == currentState, 'Invalid user roots.');
  assert(!pack.equals(to32ByteBuffer(0)), 'ALREADY_OPENED');

  const cards = Array(CARDS_PER_PACK)
    .fill(null)
    .map((_, i) => hashPacked([user, pack, to32ByteBuffer(i)]));

  const params1 = {
    root: packsRoot,
    index: packIndex,
    element: pack,
    updateElement: to32ByteBuffer(0),
    compactProof: packProof,
  };
  const { root: newPacksRoot } = MerkleTree.updateWithSingleProof(params1, treeOptions);

  const params2 = { root: cardsRoot, appendElements: cards, compactProof: cardsAppendProof };
  const { root: newCardsRoot } = MerkleTree.appendWithAppendProof(params2, treeOptions);

  const newState = hashPacked([newPacksRoot, newCardsRoot]);

  return { newState, cards };
};

module.exports = {
  getInitialState,
  buyPacks,
  openPack,
};