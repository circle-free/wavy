const assert = require('assert');
const { MerkleTree } = require('merkle-trees/js');

const { to32ByteBuffer, hashPacked, toHex, toBuffer, toBigInt } = require('./utils');

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

  return { packsTree, cardsTree, tokenIds: [] };
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

  const { packsTree, cardsTree, tokenIds } = _currentState;

  const newPacks = Array(Number(packCount))
    .fill(null)
    .map((_, i) => hashPacked([user, to32ByteBuffer(i), blockhash]));

  const newPacksArray = packsTree.elements.concat(newPacks);
  const newPacksTree = new MerkleTree(newPacksArray, treeOptions);

  return { packsTree: newPacksTree, cardsTree, tokenIds };
};

const openPack = (_user, _currentState, _packIndex, _beacons) => {
  const { packsTree, cardsTree, tokenIds } = _currentState;
  const beacon = toBuffer(_beacons[_beacons.length - 1]);
  const packs = packsTree.elements;

  assert(!packs[_packIndex].equals(to32ByteBuffer(0)), 'ALREADY_OPENED');

  const newCards = Array(Number(CARDS_PER_PACK))
    .fill(null)
    .map((_, i) => hashPacked([beacon, to32ByteBuffer(i)]));

  packs[_packIndex] = to32ByteBuffer(0);
  const newPacksTree = new MerkleTree(packs, treeOptions);

  const cards = cardsTree.elements.concat(newCards);
  const newCardsTree = new MerkleTree(cards, treeOptions);

  return { packsTree: newPacksTree, cardsTree: newCardsTree, tokenIds };
};

const exportCardToToken = (_user, currentState, cardIndex, impurities = {}) => {
  const { packsTree, cardsTree, tokenIds } = currentState;
  const { tokenId } = impurities;

  const cards = cardsTree.elements;

  assert(!cards[cardIndex].equals(to32ByteBuffer(0)), 'CARD_ALREADY_EXPORTED');

  cards[cardIndex] = to32ByteBuffer(0);
  const newCardsTree = new MerkleTree(cards, treeOptions);

  return { packsTree, cardsTree: newCardsTree, tokenIds: tokenIds.concat(tokenId) };
};

const importCardFromToken = (_user, currentState, tokenId, impurities = {}) => {
  const { packsTree, cardsTree, tokenIds } = currentState;
  const { card } = impurities;

  const cards = cardsTree.elements.concat(toBuffer(card));
  const newCardsTree = new MerkleTree(cards, treeOptions);

  return { packsTree: packsTree, cardsTree: newCardsTree, tokenIds: tokenIds.filter((id) => id !== tokenId) };
};

module.exports = {
  getInitialState,
  buyPacks,
  openPack,
  exportCardToToken,
  importCardFromToken,
};
