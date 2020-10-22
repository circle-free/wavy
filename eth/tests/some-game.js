const chai = require('chai');
const { expect } = chai;

const SomeGameArtifact = artifacts.require('Some_Game');
const SomeRollIn = artifacts.require('Some_Roll_In');

const SomeGame = require('../../js/src/index');

const { to32ByteBuffer, hashPacked, toHex, toBuffer } = require('../../js/src/utils');

const packsPurchasedEvent = '0x9146894c2ac6edd4e5aab8e0504cd0955e0937f8e8add1ab48c8c47d6c7d50c4';

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
      gameContractInstance = await SomeGameArtifact.deployed();
      gameAddress = gameContractInstance.address;

      optimismContractInstance = await SomeRollIn.deployed();
      optimismAddress = optimismContractInstance.address;

      const options = { optimisticTreeOptions: { elementPrefix: '00' }, web3 };
      userGame = new SomeGame(user, gameContractInstance, optimismContractInstance, options);
    });

    it('[ 1] allows a user to initialize and bond.', async () => {
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

      if (receipt.gasUsed !== 67318) {
        console.log(`Not Critical, but we expected gas used for [ 1] to be 67318, but got ${receipt.gasUsed}`);
      }
    });

    it('[ 2] allows a user to buy 5 packs of cards (normal state transition and remain outside of optimism).', async () => {
      const packCount = 5;
      const { tx } = await userGame.buyPack(packCount);
      const { receipt, logs } = tx;

      const accountState = await userGame.getOptimismAccountState();
      const bondBalance = await userGame.getOptimismBalance();
      const optimismBalance = await web3.eth.getBalance(optimismAddress);
      const gameBalance = await web3.eth.getBalance(gameAddress);

      expect(accountState).to.equal(toHex(userGame._ori.accountState));

      // TODO: this is incorrect but for some reason Some Game events aren't being decoded
      //       "Warning: Could not decode event!" They are still in receipt.rawLogs though
      expect(logs[0].event).to.equal('ORI_New_State');
      expect(logs[0].args[0]).to.equal(user);
      expect(logs[0].args[1].toString()).to.equal(toHex(userGame.currentStateRoot));

      expect(bondBalance.toString()).to.equal(userBondAmount);
      expect(optimismBalance.toString()).to.equal(userBondAmount);
      expect(gameBalance.toString()).to.equal(userGame.getPurchaseCost(packCount));

      if (receipt.gasUsed !== 48829) {
        console.log(`Not Critical, but we expected gas used for [ 1] to be 48829, but got ${receipt.gasUsed}`);
      }
    });

    it('[ 3] allows a user to perform a valid optimistic state transition (and enter optimism).', async () => {
      const packIndex = 0;
      const { tx } = await userGame.openPack(packIndex);
      const { receipt, logs } = tx;

      const accountState = await userGame.getOptimismAccountState();

      expect(accountState).to.equal(toHex(userGame._ori.accountState));

      expect(logs[0].event).to.equal('ORI_New_Optimistic_State');
      expect(logs[0].args[0]).to.equal(user);
      expect(logs[0].args[1].toString()).to.equal(userGame._ori.lastTime.toString());

      if (receipt.gasUsed !== 37674) {
        console.log(`Not Critical, but we expected gas used for [ 1] to be 37674, but got ${receipt.gasUsed}`);
      }
    });
  });
});
