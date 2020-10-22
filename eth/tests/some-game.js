const chai = require('chai');
const { expect } = chai;

const OptimisticRollIn = require('optimistic-roll-in');

const truffleContract = require('@truffle/contract');
const data = require('optimistic-roll-in/eth/build/Optimistic_Roll_In.json');
const OptimisticRollInArtifact = truffleContract(data);
OptimisticRollInArtifact.setProvider(web3.currentProvider);

const SomeGameArtifact = artifacts.require('Some_Game');

const SomeGame = require('../../js/src/index');

const { to32ByteBuffer, hashPacked, toHex, toBuffer } = require('../../js/src/utils');

const zeroAddress = '0x0000000000000000000000000000000000000000';
const costPerPack = 1000000000000;
const cardsPerPack = 10;
const packsPurchasedEvent = '0x9146894c2ac6edd4e5aab8e0504cd0955e0937f8e8add1ab48c8c47d6c7d50c4';

const getStateFromTrees = (packsTree, cardsTree) => {
  return hashPacked([packsTree.root, cardsTree.root]);
};

const advanceTime = (time) => {
  return new Promise((resolve, reject) => {
    web3.currentProvider.send(
      {
        jsonrpc: '2.0',
        method: 'evm_increaseTime',
        params: [time],
        id: new Date().getTime(),
      },
      (err, result) => {
        if (err) return reject(err);

        return resolve(result);
      }
    );
  });
};

contract('Some Game', (accounts) => {
  describe('Basic Testing (must be performed in order)', () => {
    let gameContractInstance = null;
    let gameAddress = null;
    let optimismContractInstance = null;
    let optimismAddress = null;

    let user = accounts[0];
    let userGame = null;
    let userLastTxId = null;
    let userBondAmount = null;
    let userPacksTree = null;
    let userCardsTree = null;

    let watchTower = accounts[1];
    let watchTowerOptimist = null;
    let watchTowerBondAmount = null;

    before(async () => {
      gameContractInstance = await SomeGameArtifact.new();
      gameAddress = gameContractInstance.address;

      const initialStateSelector = gameContractInstance.abi.find(({ name }) => name === 'get_initial_state').signature;

      optimismContractInstance = await OptimisticRollInArtifact.new(gameAddress, initialStateSelector, {
        from: accounts[0],
      });
      optimismAddress = optimismContractInstance.address;

      const options = { optimisticTreeOptions: { elementPrefix: '00' }, web3 };
      userGame = new SomeGame(user, gameContractInstance, optimismContractInstance, options);
    });

    it.only('[ 1] allows a user to initialize and bond.', async () => {
      userBondAmount = '1000000000000000000';
      const { tx } = await userGame.initialize({ bond: userBondAmount });
      const { receipt, logs } = tx;

      const accountState = await userGame.getOptimismAccountState();
      const bondBalance = await userGame.getOptimismBalance();
      const optimismBalance = await web3.eth.getBalance(optimismAddress);

      expect(accountState).to.equal(toHex(userGame._ori.accountState));

      expect(logs[0].event).to.equal('ORI_New_State');
      expect(logs[0].args[0]).to.equal(user);
      expect(logs[0].args[1].toString()).to.equal(toHex(userGame.currentStateRoot));

      expect(bondBalance.toString()).to.equal(userBondAmount);
      expect(optimismBalance.toString()).to.equal(userBondAmount);

      if (receipt.gasUsed !== 67296) {
        console.log(`Not Critical, but we expected gas used for [ 1] to be 42739, but got ${receipt.gasUsed}`);
      }
    });

    it.only('allows a user to buy 5 packs of cards (normal state transition and remain outside of optimism).', async () => {
      const packCount = 5;
      const { tx } = await userGame.buyPack(packCount);
      const { receipt, logs } = tx;

      const accountState = await userGame.getOptimismAccountState();
      const bondBalance = await userGame.getOptimismBalance();
      const optimismBalance = await web3.eth.getBalance(optimismAddress);
      const gameBalance = await web3.eth.getBalance(gameAddress);

      expect(accountState).to.equal(toHex(userGame._ori.accountState));

      expect(logs[0].event).to.equal('ORI_New_State');
      expect(logs[0].args[0]).to.equal(user);
      expect(logs[0].args[1].toString()).to.equal(toHex(userGame.currentStateRoot));

      expect(bondBalance.toString()).to.equal(userBondAmount);
      expect(optimismBalance.toString()).to.equal(userBondAmount);
      expect(gameBalance.toString()).to.equal(userGame.getPurchaseCost(packCount));

      if (receipt.gasUsed !== 67296) {
        console.log(`Not Critical, but we expected gas used for [ 1] to be 42739, but got ${receipt.gasUsed}`);
      }
    });

    it('allows a user to perform a valid optimistic state transition (and enter optimism).', async () => {
      const proofOptions = { compact: true };
      const packIndex = 0;

      const { callDataHex, newValues } = await openPackTransition(
        packsTree,
        cardsTree,
        packIndex,
        gameContractInstance,
        user
      );
      const transition = newValues();
      const newStateHex = '0x' + transition.newState.toString('hex');

      // Get the expect new call data tree and append proof
      const callData = Buffer.from(callDataHex.slice(2), 'hex');
      const { proof, newMerkleTree } = callDataTree.appendSingle(callData, proofOptions);
      const { compactProof: appendProof } = proof;
      const proofHex = appendProof.map((p) => '0x' + p.toString('hex'));

      const { receipt, logs } = await optimismContractInstance.perform_optimistically_and_enter(
        callDataHex,
        newStateHex,
        proofHex,
        { from: user }
      );

      // Since the transaction executed successfully, update the locally maintained variables
      const block = await web3.eth.getBlock(receipt.blockNumber);
      lastTime = block.timestamp;
      packsTree = transition.packsTree;
      cardsTree = transition.cardsTree;
      currentState = transition.newState;
      callDataTree = newMerkleTree;

      const accountState = await optimismContractInstance.account_states(user);
      const expectedAccountState = hashPacked([callDataTree.root, currentState, to32ByteBuffer(lastTime)]);

      expect(accountState).to.equal('0x' + expectedAccountState.toString('hex'));

      expect(logs[0].event).to.equal('ORI_New_Optimistic_State');
      expect(logs[0].args[0]).to.equal(user);
      expect(logs[0].args[1].toString()).to.equal(lastTime.toString());

      if (receipt.gasUsed !== 42739) {
        console.log(`Not Critical, but we expected gas used for [ 3] to be 42739, but got ${receipt.gasUsed}`);
      }
    });
  });
});
