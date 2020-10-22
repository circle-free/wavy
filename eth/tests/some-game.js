const chai = require('chai');
const { expect } = chai;
var chaiAsPromised = require('chai-as-promised');
chai.use(chaiAsPromised);

const SomeGameTokens = artifacts.require('Some_Game_Tokens');
const SomeGameArtifact = artifacts.require('Some_Game');
const SomeRollIn = artifacts.require('Some_Roll_In');

const SomeGame = require('../../js/src/index');

const { to32ByteBuffer, hashPacked, toHex, toBuffer } = require('../../js/src/utils');

const packsPurchasedEvent = '0x9146894c2ac6edd4e5aab8e0504cd0955e0937f8e8add1ab48c8c47d6c7d50c4';

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

const someDelay = (seconds) => {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
};

contract('Some Game', (accounts) => {
  describe('Basic Testing (must be performed in order)', () => {
    let gameContractInstance = null;
    let gameAddress = null;
    let optimismContractInstance = null;
    let optimismAddress = null;

    let alice = accounts[0];
    let aliceGame = null;
    let aliceLastTxId = null;
    let aliceBondAmount = null;

    let bob = accounts[2];
    let bobGame = null;
    let bobLastTxId = null;
    let bobBondAmount = null;

    let watchTower = accounts[1];
    let watchTowerOptimist = null;
    let watchTowerBondAmount = null;

    before(async () => {
      tokenContractInstance = await SomeGameTokens.deployed();
      tokenContractAddress = tokenContractInstance.address;

      gameContractInstance = await SomeGameArtifact.deployed();
      gameAddress = gameContractInstance.address;

      optimismContractInstance = await SomeRollIn.deployed();
      optimismAddress = optimismContractInstance.address;

      const options = { optimisticTreeOptions: { elementPrefix: '00' }, web3 };
      aliceGame = new SomeGame(alice, gameContractInstance, tokenContractInstance, optimismContractInstance, options);
      bobGame = new SomeGame(bob, gameContractInstance, tokenContractInstance, optimismContractInstance, options);
    });

    it('[ 1] allows a user (Alice) to initialize and bond.', async () => {
      aliceBondAmount = '1000000000000000000';
      const { tx } = await aliceGame.initialize({ bond: aliceBondAmount });
      const { receipt, logs } = tx;

      const accountState = await aliceGame.getOptimismAccountState();
      const bondBalance = await aliceGame.getOptimismBalance();
      const optimismBalance = await web3.eth.getBalance(optimismAddress);

      expect(accountState).to.equal(toHex(aliceGame._ori.accountState));

      expect(logs[0].event).to.equal('ORI_New_State');
      expect(logs[0].args[0]).to.equal(alice);
      expect(logs[0].args[1].toString()).to.equal(toHex(aliceGame.currentStateRoot));

      expect(bondBalance.toString()).to.equal(aliceBondAmount);
      expect(optimismBalance.toString()).to.equal(aliceBondAmount);

      if (receipt.gasUsed !== 67378) {
        console.log(`Not Critical, but we expected gas used for [ 1] to be 67378, but got ${receipt.gasUsed}`);
      }
    });

    it('[ 2] allows a user (Alice) to buy 5 packs of cards (normal state transition and remain outside of optimism).', async () => {
      const packCount = 5;
      const { tx } = await aliceGame.buyPacks(packCount);
      const { receipt, logs } = tx;

      const accountState = await aliceGame.getOptimismAccountState();
      const bondBalance = await aliceGame.getOptimismBalance();
      const optimismBalance = await web3.eth.getBalance(optimismAddress);
      const gameBalance = await web3.eth.getBalance(gameAddress);

      expect(accountState).to.equal(toHex(aliceGame._ori.accountState));

      // TODO: this is incorrect but for some reason Some Game events aren't being decoded
      //       "Warning: Could not decode event!" They are still in receipt.rawLogs though
      expect(logs[0].event).to.equal('ORI_New_State');
      expect(logs[0].args[0]).to.equal(alice);
      expect(logs[0].args[1].toString()).to.equal(toHex(aliceGame.currentStateRoot));

      expect(bondBalance.toString()).to.equal(aliceBondAmount);
      expect(optimismBalance.toString()).to.equal(aliceBondAmount);
      expect(gameBalance.toString()).to.equal(aliceGame.getPurchaseCost(packCount));

      if (receipt.gasUsed !== 48826) {
        console.log(`Not Critical, but we expected gas used for [ 2] to be 48826, but got ${receipt.gasUsed}`);
      }
    });

    it('[ 3] allows a user (Alice) to open a pack of cards (optimistic state transition entering optimism).', async () => {
      const packIndex = 0;
      const { tx } = await aliceGame.openPack(packIndex);
      const { receipt, logs } = tx;

      const accountState = await aliceGame.getOptimismAccountState();

      expect(accountState).to.equal(toHex(aliceGame._ori.accountState));

      expect(logs[0].event).to.equal('ORI_New_Optimistic_State');
      expect(logs[0].args[0]).to.equal(alice);
      expect(logs[0].args[1].toString()).to.equal(aliceGame._ori.lastTime.toString());

      if (receipt.gasUsed !== 37686) {
        console.log(`Not Critical, but we expected gas used for [ 3] to be 37686, but got ${receipt.gasUsed}`);
      }
    });

    it('[ 4] allows a user (Alice) to export a card as an NFT (normal state transition exiting optimism)', async () => {
      const networkId = await web3.eth.net.getId();

      if (networkId === 5777) {
        // Need to increase time by at least 600 seconds for this to be allowed
        await advanceTime(aliceGame._ori.lastTime + 700);
      } else {
        // Need to wait at least 60 seconds for lock time to expire
        console.info('Waiting for 70 seconds...');
        await someDelay(70);
        console.info('Finished waiting.');
      }

      const cardIndex = 0;
      const { tx } = await aliceGame.exportCardToToken(cardIndex);
      const { receipt, logs } = tx;

      const accountState = await aliceGame.getOptimismAccountState();

      expect(accountState).to.equal(toHex(aliceGame._ori.accountState));

      const tokenBalance = await tokenContractInstance.balanceOf.call(alice);
      expect(tokenBalance.toNumber()).to.equal(1);
      const tokenOwner = await tokenContractInstance.ownerOf.call(aliceGame.tokenIds[0]);
      expect(tokenOwner).to.equal(alice);

      // TODO: this is incorrect but for some reason Some Game events aren't being decoded
      //       "Warning: Could not decode event!" They are still in receipt.rawLogs though
      expect(logs[0].event).to.equal('ORI_New_State');
      expect(logs[0].args[0]).to.equal(alice);
      expect(logs[0].args[1].toString()).to.equal(toHex(aliceGame.currentStateRoot));

      if (receipt.gasUsed !== 200054) {
        console.log(`Not Critical, but we expected gas used for [ 4] to be 200054, but got ${receipt.gasUsed}`);
      }
    });

    it('[ 5] allows a user (Alice) to re-import a card from an NFT (normal state transition and remain outside of optimism)', async () => {
      const tokenId = aliceGame.tokenIds[0];

      const { tx } = await aliceGame.importCardFromToken(tokenId);
      const { receipt, logs } = tx;

      const accountState = await aliceGame.getOptimismAccountState();

      expect(accountState).to.equal(toHex(aliceGame._ori.accountState));

      const tokenBalance = await tokenContractInstance.balanceOf.call(alice);
      expect(tokenBalance.toNumber()).to.equal(0);
      expect(tokenContractInstance.ownerOf.call(tokenId)).to.be.rejectedWith(
        Error,
        'owner query for nonexistent token'
      );

      // TODO: this is incorrect but for some reason Some Game events aren't being decoded
      //       "Warning: Could not decode event!" They are still in receipt.rawLogs though
      expect(logs[0].event).to.equal('ORI_New_State');
      expect(logs[0].args[0]).to.equal(alice);
      expect(logs[0].args[1].toString()).to.equal(toHex(aliceGame.currentStateRoot));

      if (receipt.gasUsed !== 54068) {
        console.log(`Not Critical, but we expected gas used for [ 5] to be 54068, but got ${receipt.gasUsed}`);
      }
    });

    it('[ 6] allows a user (Alice) to export and transfer a card as an NFT to another user (Bob) (normal state transition and remain outside of optimism)', async () => {
      bobBondAmount = '1000000000000000000';
      await bobGame.initialize({ bond: bobBondAmount });

      const cardIndex = 1;
      await aliceGame.exportCardToToken(cardIndex);
      const tokenId = aliceGame.tokenIds[0];

      const { tx, receipt, logs } = await aliceGame.transferToken(bob, tokenId);
      const receivedToken = await bobGame.findToken(tx);

      expect(receivedToken).to.equal(tokenId);
      expect(aliceGame.tokenIds.length).to.equal(0);
      expect(bobGame.tokenIds.length).to.equal(1);

      const userTokenBalance = await tokenContractInstance.balanceOf.call(alice);
      expect(userTokenBalance.toNumber()).to.equal(0);
      const user2TokenBalance = await tokenContractInstance.balanceOf.call(bob);
      expect(user2TokenBalance.toNumber()).to.equal(1);
      const tokenOwner = await tokenContractInstance.ownerOf.call(tokenId);
      expect(tokenOwner).to.equal(bob);

      if (receipt.gasUsed !== 83860) {
        console.log(`Not Critical, but we expected gas used for [ 6] to be 83860, but got ${receipt.gasUsed}`);
      }
    });

    it('[ 7] allows a user (Bob) to import a received card as an NFT (normal state transition and remain outside of optimism)', async () => {
      const tokenId = bobGame.tokenIds[0];

      const { tx } = await bobGame.importCardFromToken(tokenId);
      const { receipt, logs } = tx;

      expect(bobGame.tokenIds.length).to.equal(0);

      const accountState = await bobGame.getOptimismAccountState();

      expect(accountState).to.equal(toHex(bobGame._ori.accountState));

      const tokenBalance = await tokenContractInstance.balanceOf.call(bob);
      expect(tokenBalance.toNumber()).to.equal(0);
      expect(tokenContractInstance.ownerOf.call(tokenId)).to.be.rejectedWith(
        Error,
        'owner query for nonexistent token'
      );

      // TODO: this is incorrect but for some reason Some Game events aren't being decoded
      //       "Warning: Could not decode event!" They are still in receipt.rawLogs though
      expect(logs[0].event).to.equal('ORI_New_State');
      expect(logs[0].args[0]).to.equal(bob);
      expect(logs[0].args[1].toString()).to.equal(toHex(bobGame.currentStateRoot));

      if (receipt.gasUsed !== 56939) {
        console.log(`Not Critical, but we expected gas used for [ 7] to be 56939, but got ${receipt.gasUsed}`);
      }
    });
  });
});
