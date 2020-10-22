const assert = require('assert');
const OptimisticRollIn = require('optimistic-roll-in');

const { to32ByteBuffer, hashPacked, toHex, toBuffer } = require('./utils');
const contractFunctions = require('./contract');

const COST_PER_PACK = BigInt('10') ** BigInt('12');

const proofOptions = { compact: true, simple: true };

const SG_New_Packs = '0xed7df3e335caa0b725b5ed38dfa67c4f0da28a4c983e29b247bb36454ace0758';
const SG_Export_Token = '0xbc596e90d5676116dacfbe535e34670aa4489014863e95695731902a28a09761';
const SG_Import_Token = '0x4be831fa28d5bc71f4a1ca7a8af7903d241ce9e68bfd2e781558bab122b23aa4';
const Token_Transfer = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

class SomeGame {
  constructor(user, gameContractInstance, oriContractInstance, tokenContractInstance, options = {}) {

    const { optimisticTreeOptions, web3 } = options;
    assert(web3, 'web3 option is mandatory for now.');
    const oriOptions = {
      sourceAddress: user,
      treeOptions: optimisticTreeOptions,
      web3,
    };

    this._ori = new OptimisticRollIn(oriContractInstance, gameContractInstance, user, oriOptions);

    this._user = user;

    this._state = {
      packsTree: null,
      cardsTree: null,
      tokenIds: null
    };

    this._contract = gameContractInstance;

    this._tokenContract = tokenContractInstance;
    
    this._web3 = web3;
  }

  // STATIC: Returns player state from packs and cards trees
  static getStateRoot = ({ packsTree, cardsTree }) => {
    return hashPacked([packsTree.root, cardsTree.root]);
  };

  // GETTER: Returns user's current game state
  get currentStateRoot() {
    return SomeGame.getStateRoot(this._state);
  }

  getPurchaseCost(packCount) {
    return (BigInt(packCount) * COST_PER_PACK).toString();
  }

  // PUBLIC: initializes the user's game state
  async initialize(bondAmount) {
    // TODO: prevent initializing already initialized account

    const result = await this._ori.initialize(bondAmount);
    const state = contractFunctions.getInitialState();

    assert(toHex(SomeGame.getStateRoot(state)) == result.logs[0].args[1], 'Initialize log mismatch.');

    this._state = state;

    return { tx: result };
  }

  async buyPack(packCount) {
    const cost = this.getPurchaseCost(packCount);
    const { root: packsRoot, compactProof } = this._state.packsTree.generateAppendProof(proofOptions);

    const callArgs = [packsRoot, compactProof, this._state.cardsTree.root];
    const callOptions = { value: cost };
    const result = await this._ori.buy_packs.normal(callArgs, callOptions);

    const gameLog = result.receipt.rawLogs.find(({ topics }) => topics[0] === SG_New_Packs);

    const impurities = { value: cost, blockHash: gameLog.topics[2] };
    const newState = contractFunctions.buyPacks(this._user, this._state, impurities);

    assert(SomeGame.getStateRoot(newState).equals(result.newState), 'New state mismatch');

    this._state = newState;

    return { tx: result };
  }

  async openPack(packIndex) {
    const newState = contractFunctions.openPack(this._user, this._state, packIndex);
    const newStateRoot = SomeGame.getStateRoot(newState);

    const { root: packsRoot, element: pack, compactProof: packProof } = this._state.packsTree.generateSingleProof(
      packIndex,
      proofOptions
    );

    const { root: cardsRoot, compactProof: cardsAppendProof } = this._state.cardsTree.generateAppendProof(proofOptions);

    const callArgs = [packIndex, pack, packsRoot, packProof, cardsRoot, cardsAppendProof];
    const result = await this._ori.open_pack.optimistic(callArgs, newStateRoot);

    assert(newStateRoot.equals(result.newState), 'New state mismatch');

    this._state = newState;

    return { tx: result };
  }

  async exportCardToToken(cardIndex) {
    const { root: cardsRoot, element: card, compactProof: cardProof } = this._state.cardsTree.generateSingleProof(
      cardIndex,
      proofOptions
    );
    
    const callArgs = [this._state.packsTree.root, cardsRoot, cardIndex, card, cardProof];
    const result = await this._ori.export_card_to_token.normal(callArgs, {});

    const gameLog = result.receipt.rawLogs.find(({ topics }) => topics[0] === SG_Export_Token);

    const impurities = { tokenId: gameLog.topics[1] };
    const newState = contractFunctions.exportCardToToken(this._user, this._state, cardIndex, impurities);
    
    const newStateRoot = SomeGame.getStateRoot(newState);
    assert(newStateRoot.equals(result.newState), 'New state mismatch');

    this._state = newState;

    return { tx: result };
  }

  async importCardFromToken(tokenId) {
    const { root: cardsRoot, compactProof: cardsAppendProof } = this._state.cardsTree.generateAppendProof(proofOptions);

    const callArgs = [this._state.packsTree.root, cardsRoot, cardsAppendProof, tokenId];
    const result = await this._ori.import_card_from_token.normal(callArgs, {});

    const gameLog = result.receipt.rawLogs.find(({ topics }) => topics[0] === SG_Import_Token);

    const impurities = { card: gameLog.topics[1] }
    const newState = contractFunctions.importCardFromToken(this._user, this._state, tokenId, impurities);
    
    const newStateRoot = SomeGame.getStateRoot(newState);
    
    assert(newStateRoot.equals(result.newState), 'New state mismatch');

    this._state = newState;

    return { tx: result };
  }

  // PUBLIC: Returns user's optimism account state (on chain)
  getOptimismAccountState() {
    return this._ori.getAccountState();
  }

  // PUBLIC: Returns user's optimism bond balance (on chain)
  getOptimismBalance() {
    return this._ori.getBalance();
  }

  getTokenIds() {
    return this._state.tokenIds;
  }

  async transferToken(to, tokenId) {
    const result = await this._tokenContract.transferFrom(this._user, to, tokenId, {from: this._user});

    this._state.tokenIds = this._state.tokenIds.filter(id => id !== tokenId);

    return result;
  }

  async findToken(txId) {
    const receipt = await this._web3.eth.getTransactionReceipt(txId);
    const gameLog = receipt.logs.find(({ topics }) => topics[0] === Token_Transfer);

    const to = web3.utils.toChecksumAddress('0x' + gameLog.topics[2].slice(26));

    if (to === this._user) {
      const tokenId = gameLog.topics[3];
      this._state.tokenIds = this._state.tokenIds.concat(tokenId);

      return tokenId;
    }

    return null;
  }

  // TODO: implement isBonded()
}

module.exports = SomeGame;
