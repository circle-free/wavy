const chai = require('chai');
const { expect } = chai;
const { Keccak } = require('sha3');
const { MerkleTree, PartialMerkleTree } = require('merkle-trees/js');
const txDecoder = require('ethereum-tx-decoder');
const { abi: optimismABI } = require('../build/Optimistic_Roll_In.json');
const { abi: gameABI } = require('../build/Game_Collectibles.json');

const OptimisticRollIn = artifacts.require('Optimistic_Roll_In');
const GameCollectibles = artifacts.require('Game_Collectibles');

const optimisticTreeOptions = {
  unbalanced: true,
  sortedHash: false,
  elementPrefix: '00',
};

const gameTreeOptions = {
  unbalanced: true,
  sortedHash: false,
  elementPrefix: '0000000000000000000000000000000000000000000000000000000000000000',
};

const leftPad = (num, size, char = '0') => {
  let s = num + '';

  while (s.length < size) s = char + s;

  return s;
};

const to32ByteBuffer = (number) => Buffer.from(leftPad(number.toString(16), 64), 'hex');

const hash = (buffer) => new Keccak(256).update(buffer).digest();

const hashPacked = (buffers) => hash(Buffer.concat(buffers));

const hashNode = (a, b) => hash(Buffer.concat([a, b]));

const initialStateSelector = '0x1e58e625';
const zeroAddress = '0x0000000000000000000000000000000000000000';
const costPerPack = 1000000000000;
const cardsPerPack = 10;
const packsPurchasedEvent = '0x9146894c2ac6edd4e5aab8e0504cd0955e0937f8e8add1ab48c8c47d6c7d50c4';

const getStateFromTrees = (packsTree, cardsTree) => {
  return hashPacked([packsTree.root, cardsTree.root]);
};

const buyPacksTransition = async (packsTree, cardsTree, packCount, gameContractInstance, user) => {
  const proofOptions = { compact: true };
  const currentState = getStateFromTrees(packsTree, cardsTree);
  const currentStateHex = '0x' + currentState.toString('hex');
  const packsRootHex = '0x' + packsTree.root.toString('hex');
  const cardsRootHex = '0x' + cardsTree.root.toString('hex');

  const { compactProof: packAppendProof } = packsTree.generateAppendProof(proofOptions);
  const packAppendProofHex = packAppendProof.map((p) => '0x' + p.toString('hex'));

  // Get the call logic contract address and call data from a logic request
  const cost = costPerPack * packCount;
  const { data: callDataHex } = await gameContractInstance.buy_packs.request(
    currentStateHex,
    packCount,
    packsRootHex,
    packAppendProofHex,
    cardsRootHex,
    { from: user, value: cost }
  );

  const newValues = (blockTime) => {
    const packs = Array(packCount)
      .fill(null)
      .map((_, i) => {
        return hashPacked([currentState, to32ByteBuffer(i), to32ByteBuffer(blockTime)]);
      });

    const { newMerkleTree: newPacksTree } = packsTree.appendMulti(packs);
    const newState = getStateFromTrees(newPacksTree, cardsTree);

    return { packsTree: newPacksTree, cardsTree, newState };
  };

  return { callDataHex, cost, newValues };
};

const openPackTransition = async (packsTree, cardsTree, packIndex, gameContractInstance, user) => {
  const proofOptions = { compact: true };
  const currentState = getStateFromTrees(packsTree, cardsTree);
  const currentStateHex = '0x' + currentState.toString('hex');

  const { proof: packsUpdateProof, newMerkleTree: newPacksTree } = packsTree.updateSingle(
    packIndex,
    to32ByteBuffer(0),
    proofOptions
  );
  const { root: packsRoot, element: pack, compactProof: packProof } = packsUpdateProof;
  const packsRootHex = '0x' + packsRoot.toString('hex');
  const packHex = '0x' + pack.toString('hex');
  const packProofHex = packProof.map((p) => '0x' + p.toString('hex'));

  const cards = Array(cardsPerPack)
    .fill(null)
    .map((_, i) => {
      return hashPacked([pack, to32ByteBuffer(i)]);
    });

  const { proof: cardsAppendProof, newMerkleTree: newCardsTree } = cardsTree.appendMulti(cards, proofOptions);
  const { root: cardsRoot, compactProof: cardsCompactProof } = cardsAppendProof;
  const cardsRootHex = '0x' + cardsRoot.toString('hex');
  const cardsAppendProofHex = cardsCompactProof.map((p) => '0x' + p.toString('hex'));

  // Get the call logic contract address and call data from a logic request
  const { data: callDataHex } = await gameContractInstance.open_pack.request(
    currentStateHex,
    packIndex,
    packHex,
    packsRootHex,
    packProofHex,
    cardsRootHex,
    cardsAppendProofHex,
    { from: user }
  );

  const newValues = () => {
    const newState = getStateFromTrees(newPacksTree, newCardsTree);

    return { packsTree: newPacksTree, cardsTree: newCardsTree, newState };
  };

  return { callDataHex, newValues };
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

contract('Game Collectibles', (accounts) => {
  describe('Basic Testing (must be performed in order)', async () => {
    let user = accounts[0];
    let gameContractInstance = null;
    let gameAddress = null;
    let optimismContractInstance = null;
    let userBondAmount = null;
    let packsTree = null;
    let cardsTree = null;

    let prover = accounts[1];
    let callDataTree = null;
    let currentState = null;
    let lastTime = null;
    let fraudulentTransitionIndex = null;
    let fraudulentTxId = null;
    let callDataPartialTree = null;
    let txIdAfterFraudulentTxId = null;
    let proverBondAmount = null;

    before(async () => {
      gameContractInstance = await GameCollectibles.new();
      gameAddress = gameContractInstance.address;
      optimismContractInstance = await OptimisticRollIn.new(gameAddress, initialStateSelector);
    });

    it.only('can bond a user.', async () => {
      userBondAmount = '1000000000000000000';
      const { receipt, logs } = await optimismContractInstance.bond(user, { from: user, value: userBondAmount });
      const balance = await optimismContractInstance.balances(user);

      expect(balance.toString()).to.equal(userBondAmount);
      expect(receipt.gasUsed).to.equal(42706);
    });

    it.only('can initialize a user.', async () => {
      // When initialized, the user's account state will be an initial state, call data tree, and the last optimistic time will be 0
      const { receipt, logs } = await optimismContractInstance.initialize({ from: user });
      callDataTree = new MerkleTree([], optimisticTreeOptions);
      packsTree = new MerkleTree([], gameTreeOptions);
      cardsTree = new MerkleTree([], gameTreeOptions);
      currentState = getStateFromTrees(packsTree, cardsTree);
      lastTime = 0;

      const accountState = await optimismContractInstance.account_states(user);
      const expectedAccountStateHex =
        '0x' + hashPacked([callDataTree.root, currentState, to32ByteBuffer(lastTime)]).toString('hex');

      expect(accountState).to.equal(expectedAccountStateHex);

      expect(logs[0].event).to.equal('ORI_Initialized');
      expect(logs[0].args[0]).to.equal(user);
      expect(logs[0].args[1].toString()).to.equal('0x' + currentState.toString('hex'));

      expect(receipt.gasUsed).to.equal(46678);
    });

    it.only('allows a user to perform a normal state transition (and remain outside of optimism).', async () => {
      const packCount = 5;
      const { callDataHex, cost, newValues } = await buyPacksTransition(
        packsTree,
        cardsTree,
        packCount,
        gameContractInstance,
        user
      );

      const { receipt, logs } = await optimismContractInstance.perform(callDataHex, { from: user, value: cost });

      // Locally Compute the new state from the current state (which is the last state)
      const block = await web3.eth.getBlock(receipt.blockNumber);
      const transition = newValues(block.timestamp);
      packsTree = transition.packsTree;
      cardsTree = transition.cardsTree;
      currentState = transition.newState;

      const accountState = await optimismContractInstance.account_states(user);
      const expectedAccountStateHex =
        '0x' + hashPacked([callDataTree.root, currentState, to32ByteBuffer(lastTime)]).toString('hex');

      expect(accountState).to.equal(expectedAccountStateHex);

      expect(receipt.rawLogs[0].topics[0]).to.equal(packsPurchasedEvent);
      expect(receipt.rawLogs[0].topics[1]).to.equal('0x' + to32ByteBuffer(packCount).toString('hex'));
      expect(receipt.rawLogs[0].topics[2]).to.equal('0x' + to32ByteBuffer(block.timestamp).toString('hex'));

      expect(receipt.gasUsed).to.equal(46499);
    });

    it.only('allows a user to perform a valid optimistic state transition (and enter optimism).', async () => {
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

      expect(receipt.gasUsed).to.equal(37284);
    });

    it('allows a user (suspect) to perform a valid optimistic state transition.', async () => {
      const arg = generateElements(1, { seed: '66' })[0];
      const argHex = '0x' + arg.toString('hex');
      const currentStateHex = '0x' + currentState.toString('hex');
      const proofOptions = { compact: true };

      // Compute the new state from the current state (which is the last state) and the arg
      const newState = getNewState(currentState, arg);
      const newStateHex = '0x' + newState.toString('hex');

      // Get the call logic contract address and call data from a logic request
      const { data: callDataHex } = await logicContractInstance.some_pure_transition.request(currentStateHex, argHex, {
        from: suspect,
      });

      const callData = Buffer.from(callDataHex.slice(2), 'hex');

      // Build an Append Proof that enables appending a new call data to the call data tree
      const { proof, newMerkleTree } = callDataTree.appendSingle(callData, proofOptions);
      const { compactProof: appendProof } = proof;
      const proofHex = appendProof.map((p) => '0x' + p.toString('hex'));

      const callDataRootHex = '0x' + callDataTree.root.toString('hex');

      const { receipt, logs } = await contractInstance.perform_optimistically(
        callDataHex,
        newStateHex,
        callDataRootHex,
        proofHex,
        lastTime,
        { from: suspect }
      );

      // Since the transaction executed successfully, update the locally maintained variables
      const block = await web3.eth.getBlock(receipt.blockNumber);
      lastTime = block.timestamp;
      callDataTree = newMerkleTree;
      currentState = newState;

      const accountState = await contractInstance.account_states(suspect);
      const expectedAccountState = hashPacked([callDataTree.root, currentState, to32ByteBuffer(lastTime)]);

      expect(logs[0].event).to.equal('ORI_New_Optimistic_State');
      expect(logs[0].args[0]).to.equal(suspect);
      expect(logs[0].args[1].toString()).to.equal(lastTime.toString());

      expect(accountState).to.equal('0x' + expectedAccountState.toString('hex'));

      expect(receipt.gasUsed).to.equal(35707);
    });

    it('allows a user (suspect) to perform valid optimistic state transitions in batch.', async () => {
      const transitions = 100;
      const args = generateElements(transitions, { seed: '77' });
      const argsHex = args.map((a) => '0x' + a.toString('hex'));
      const proofOptions = { compact: true };

      // Compute the new states from the current state (which is the last state) and the args
      const callDataArray = [];
      let interimState = currentState;

      for (let i = 0; i < transitions; i++) {
        const interimStateHex = '0x' + interimState.toString('hex');

        // Get the call data from a logic request
        const { data: callDataHex } = await logicContractInstance.some_pure_transition.request(
          interimStateHex,
          argsHex[i],
          { from: suspect }
        );

        // Append call data to array, and update interim state
        const callData = Buffer.from(callDataHex.slice(2), 'hex');
        callDataArray.push(callData);
        interimState = getNewState(interimState, args[i]);
      }

      const callDataArrayHex = callDataArray.map((c) => '0x' + c.toString('hex'));
      const newStateHex = '0x' + interimState.toString('hex');
      const callDataRootHex = '0x' + callDataTree.root.toString('hex');

      // Build an Append Proof that enables appending new call data to the call data tree
      const { proof, newMerkleTree } = callDataTree.appendMulti(callDataArray, proofOptions);
      const { compactProof: appendProof } = proof;
      const proofHex = appendProof.map((p) => '0x' + p.toString('hex'));

      const { receipt, logs } = await contractInstance.perform_many_optimistically(
        callDataArrayHex,
        newStateHex,
        callDataRootHex,
        proofHex,
        lastTime,
        { from: suspect }
      );

      // Since the transaction executed successfully, update the locally maintained variables
      const block = await web3.eth.getBlock(receipt.blockNumber);
      lastTime = block.timestamp;
      callDataTree = newMerkleTree;
      currentState = interimState;

      const accountState = await contractInstance.account_states(suspect);
      const expectedAccountState = hashPacked([callDataTree.root, currentState, to32ByteBuffer(lastTime)]);

      expect(logs[0].event).to.equal('ORI_New_Optimistic_States');
      expect(logs[0].args[0]).to.equal(suspect);
      expect(logs[0].args[1].toString()).to.equal(lastTime.toString());

      expect(accountState).to.equal('0x' + expectedAccountState.toString('hex'));

      expect(receipt.gasUsed).to.equal(286083);
    });

    it('allows a user (suspect) to perform fraudulent optimistic state transitions in batch.', async () => {
      const transitions = 100;
      const args = generateElements(transitions, { seed: '88' });
      const argsHex = args.map((a) => '0x' + a.toString('hex'));
      const proofOptions = { compact: true };
      const fraudulentIndex = 20;
      fraudulentTransitionIndex = callDataTree.elements.length + fraudulentIndex;

      // Compute the new states from the current state (which is the last state) and the args
      const callDataArray = [];
      let interimState = currentState;

      for (let i = 0; i < transitions; i++) {
        const interimStateHex = '0x' + interimState.toString('hex');

        // Get the call data from a logic request
        const { data: callDataHex } = await logicContractInstance.some_pure_transition.request(
          interimStateHex,
          argsHex[i],
          { from: suspect }
        );

        // Append call data to array, and update interim state
        const callData = Buffer.from(callDataHex.slice(2), 'hex');
        callDataArray.push(callData);

        // Slip in an incorrect state transition
        interimState = i !== fraudulentIndex ? getNewState(interimState, args[i]) : to32ByteBuffer(1337);
      }

      const callDataArrayHex = callDataArray.map((c) => '0x' + c.toString('hex'));
      const newStateHex = '0x' + interimState.toString('hex');
      const callDataRootHex = '0x' + callDataTree.root.toString('hex');

      // Build an Append Proof that enables appending new call data to the call data tree
      const { proof, newMerkleTree } = callDataTree.appendMulti(callDataArray, proofOptions);
      const { compactProof: appendProof } = proof;
      const proofHex = appendProof.map((p) => '0x' + p.toString('hex'));

      const { receipt, logs } = await contractInstance.perform_many_optimistically(
        callDataArrayHex,
        newStateHex,
        callDataRootHex,
        proofHex,
        lastTime,
        { from: suspect }
      );

      // Since the transaction executed successfully, update the locally maintained variables
      const block = await web3.eth.getBlock(receipt.blockNumber);
      lastTime = block.timestamp;
      callDataTree = newMerkleTree;
      currentState = interimState;
      fraudulentTxId = receipt.transactionHash;

      const accountState = await contractInstance.account_states(suspect);
      const expectedAccountState = hashPacked([callDataTree.root, currentState, to32ByteBuffer(lastTime)]);

      expect(logs[0].event).to.equal('ORI_New_Optimistic_States');
      expect(logs[0].args[0]).to.equal(suspect);
      expect(logs[0].args[1].toString()).to.equal(lastTime.toString());

      expect(accountState).to.equal('0x' + expectedAccountState.toString('hex'));

      expect(receipt.gasUsed).to.equal(289042);
    });

    it('allows a user (accuser) to immediately detect a transaction containing a fraudulent state transition.', async () => {
      const optimismDecoder = new txDecoder.FunctionDecoder(optimismABI);
      const logicDecoder = new txDecoder.FunctionDecoder(logicABI);

      // Pull the transaction containing the suspected fraudulent transition
      const fraudulentTx = await web3.eth.getTransaction(fraudulentTxId);
      const decodedOptimismData = optimismDecoder.decodeFn(fraudulentTx.input);

      // Pull the transaction receipt containing the suspected fraudulent transition's logs, and last time
      const fraudulentTxReceipt = await web3.eth.getTransactionReceipt(fraudulentTxId);
      const lastTimeHex = fraudulentTxReceipt.logs[0].topics[2];

      // Pull the transaction receipt of the suspected fraudulent transition, to get the new last time
      // Note: I don't feel like parsing logs, so just pull the timestamp from the block itself
      const block = await web3.eth.getBlock(fraudulentTx.blockNumber);

      // Decode the optimism input data
      const {
        sighash: optimismSig,
        call_data: callDataArrayHex,
        new_state: newStateHex,
        call_data_root: callDataRootHex,
        proof: proofHex,
        last_time: lastTime,
      } = decodedOptimismData;

      // Convert Big Numbers to numbers, and hex strings to Buffers
      const callDataArray = callDataArrayHex.map((c) => Buffer.from(c.slice(2), 'hex'));
      const newState = Buffer.from(newStateHex.slice(2), 'hex');
      const callDataRoot = Buffer.from(callDataRootHex.slice(2), 'hex');
      const proof = proofHex.map((p) => Buffer.from(p.slice(2), 'hex'));

      // Compute what the new states should have been, from the original current state (which is the last state) and the args
      for (let i = 0; i < callDataArrayHex.length; i++) {
        // Decode arg from calldata and compute expected new state
        const { current_state: startingStateHex, arg: argHex } = logicDecoder.decodeFn(callDataArrayHex[i]);
        const startingState = Buffer.from(startingStateHex.slice(2), 'hex');
        const arg = Buffer.from(argHex.slice(2), 'hex');
        const endState = getNewState(startingState, arg);

        // Get the provided new state for this transition (final or from next call data)
        const providedEndState =
          i === callDataArrayHex.length - 1
            ? newState
            : Buffer.from(logicDecoder.decodeFn(callDataArrayHex[i + 1]).current_state.slice(2), 'hex');

        // Fraudulent if the new state computed does not match what was optimistically provided
        if (!endState.equals(providedEndState)) {
          // Recall that this fraudulent transition should be the 21st (0-indexed) transition in this batch
          expect(i).to.equals(20);
        }
      }

      // Build a partial merkle tree (for the call data) from the proof data pulled from this transaction
      const appendProof = { appendElements: callDataArray, compactProof: proof };
      callDataPartialTree = PartialMerkleTree.fromAppendProof(appendProof, treeOptions);

      const accountState = await contractInstance.account_states(suspect);
      const expectedAccountState = hashPacked([
        callDataPartialTree.root,
        newState,
        Buffer.from(lastTimeHex.slice(2), 'hex'),
      ]);

      // We expect this partial tree roots, when combined, to have the same root as the suspects combined trees on-chain
      expect(accountState).to.equal('0x' + expectedAccountState.toString('hex'));
    });

    it('allows a user (suspect) to perform a valid optimistic state transition on top of an invalid state.', async () => {
      const arg = generateElements(1, { seed: '99' })[0];
      const argHex = '0x' + arg.toString('hex');
      const currentStateHex = '0x' + currentState.toString('hex');
      const proofOptions = { compact: true };

      // Compute the new state from the current state (which is the last state) and the arg
      const newState = getNewState(currentState, arg);
      const newStateHex = '0x' + newState.toString('hex');

      // Get the call logic contract address and call data from a logic request
      const { data: callDataHex } = await logicContractInstance.some_pure_transition.request(currentStateHex, argHex, {
        from: suspect,
      });

      const callData = Buffer.from(callDataHex.slice(2), 'hex');

      // Build an Append Proof that enables appending a new call data to the call data tree
      const { proof, newMerkleTree } = callDataTree.appendSingle(callData, proofOptions);
      const { compactProof: appendProof } = proof;
      const proofHex = appendProof.map((p) => '0x' + p.toString('hex'));

      const callDataRootHex = '0x' + callDataTree.root.toString('hex');

      const { receipt, logs } = await contractInstance.perform_optimistically(
        callDataHex,
        newStateHex,
        callDataRootHex,
        proofHex,
        lastTime,
        { from: suspect }
      );

      // Since the transaction executed successfully, update the locally maintained variables
      const block = await web3.eth.getBlock(receipt.blockNumber);
      lastTime = block.timestamp;
      callDataTree = newMerkleTree;
      currentState = newState;
      txIdAfterFraudulentTxId = receipt.transactionHash;

      const accountState = await contractInstance.account_states(suspect);
      const expectedAccountState = hashPacked([callDataTree.root, currentState, to32ByteBuffer(lastTime)]);

      expect(logs[0].event).to.equal('ORI_New_Optimistic_State');
      expect(logs[0].args[0]).to.equal(suspect);
      expect(logs[0].args[1].toString()).to.equal(lastTime.toString());

      expect(accountState).to.equal('0x' + expectedAccountState.toString('hex'));

      expect(receipt.gasUsed).to.equal(38164);
    });

    it("allows a user (accuser) to lock a suspect's account for a time frame.", async () => {
      // An accuser, who previously detected the fraudulent transition will, will lco out the suspect (and bond themselves at the same time)
      accuserBondAmount = '1000000000000000000';
      const { receipt, logs } = await contractInstance.lock_user(suspect, { value: accuserBondAmount, from: accuser });

      const block = await web3.eth.getBlock(receipt.blockNumber);
      const balance = await contractInstance.balances(accuser);
      const suspectLocker = await contractInstance.lockers(suspect);
      const suspectLockedTime = await contractInstance.locked_times(suspect);
      const accuserLocker = await contractInstance.lockers(accuser);
      const accuserLockedTime = await contractInstance.locked_times(accuser);

      expect(logs[0].event).to.equal('Locked');
      expect(logs[0].args[0]).to.equal(suspect);
      expect(logs[0].args[1]).to.equal(accuser);

      expect(balance.toString()).to.equal(accuserBondAmount);

      expect(suspectLocker).to.equal(accuser);
      expect(suspectLockedTime.toString()).to.equal(block.timestamp.toString());
      expect(accuserLocker).to.equal(accuser);
      expect(accuserLockedTime.toString()).to.equal(block.timestamp.toString());

      expect(receipt.gasUsed).to.equal(128045);
    });

    it("allows a user (accuser) to update their local partial tree with the suspect's pre-lockout valid transition.", async () => {
      const optimismDecoder = new txDecoder.FunctionDecoder(optimismABI);
      const logicDecoder = new txDecoder.FunctionDecoder(logicABI);

      // Pull the transaction that occurred after the suspected fraudulent transition
      const txAfterFraudulentTx = await web3.eth.getTransaction(txIdAfterFraudulentTxId);
      const decodedOptimismData = optimismDecoder.decodeFn(txAfterFraudulentTx.input);

      // Pull the transaction receipt containing the suspected fraudulent transition's logs, and last time
      const receiptAfterFraudulentTx = await web3.eth.getTransactionReceipt(txIdAfterFraudulentTxId);
      const lastTimeHex = receiptAfterFraudulentTx.logs[0].topics[2];

      // Decode the optimism input data
      const {
        sighash: optimismSig,
        call_data: callDataHex,
        new_state: newStateHex,
        call_data_root: callDataRootHex,
        proof: proofHex,
        last_time: lastTime,
      } = decodedOptimismData;

      // Convert the hex strings to Buffers
      const callData = Buffer.from(callDataHex.slice(2), 'hex');
      const newState = Buffer.from(newStateHex.slice(2), 'hex');
      const callDataRoot = Buffer.from(callDataRootHex.slice(2), 'hex');

      // Expect the call data root provided to match that of the local partial tree maintained
      expect(callDataRoot.equals(callDataPartialTree.root)).to.be.true;

      // Check that this last transition was valid, by decoding arg from calldata and compute expected new state
      const { current_state: startingStateHex, arg: argHex } = logicDecoder.decodeFn(callDataHex);
      const startingState = Buffer.from(startingStateHex.slice(2), 'hex');
      const arg = Buffer.from(argHex.slice(2), 'hex');
      const endState = getNewState(startingState, arg);

      // Given this test story, we know this transition is valid
      expect(endState.equals(newState)).to.be.true;

      // Append the new call data to the locally maintained call data partial tree
      callDataPartialTree = callDataPartialTree.append(callData);

      const accountState = await contractInstance.account_states(suspect);
      const expectedAccountState = hashPacked([
        callDataPartialTree.root,
        newState,
        Buffer.from(lastTimeHex.slice(2), 'hex'),
      ]);

      // We expect this partial tree roots, when combined, to have the same root as the suspects combined trees on-chain
      expect(accountState).to.equal('0x' + expectedAccountState.toString('hex'));
    });

    it("allows a user (accuser) to prove a suspect's fraud (from a partial tree).", async () => {
      const proofOptions = { compact: true };

      // Build a Multi Proof for the call data of the fraudulent transition
      const indices = [fraudulentTransitionIndex, fraudulentTransitionIndex + 1];
      const { root, elements, compactProof } = callDataPartialTree.generateMultiProof(indices, proofOptions);
      const callDataArrayHex = elements.map((c) => '0x' + c.toString('hex'));
      const proofHex = compactProof.map((p) => '0x' + p.toString('hex'));
      const stateHex = '0x' + currentState.toString('hex');
      const callDataRootHex = '0x' + root.toString('hex');

      // Prove the fraud
      const { receipt, logs } = await contractInstance.prove_fraud(
        suspect,
        callDataArrayHex,
        stateHex,
        callDataRootHex,
        proofHex,
        lastTime,
        { from: accuser }
      );

      const suspectBalance = await contractInstance.balances(suspect);
      const suspectLocker = await contractInstance.lockers(suspect);
      const suspectLockedTime = await contractInstance.locked_times(suspect);
      const suspectRollbackSize = await contractInstance.rollback_sizes(suspect);

      const accuserBalance = await contractInstance.balances(accuser);
      const accuserLocker = await contractInstance.lockers(accuser);
      const accuserLockedTime = await contractInstance.locked_times(accuser);

      const expectedAccuserBalance = web3.utils.toBN(bondAmount).add(web3.utils.toBN(accuserBondAmount)).toString();

      expect(logs[0].event).to.equal('ORI_Fraud_Proven');
      expect(logs[0].args[0]).to.equal(accuser);
      expect(logs[0].args[1]).to.equal(suspect);
      expect(logs[0].args[2].toString()).to.equal(fraudulentTransitionIndex.toString());
      expect(logs[0].args[3].toString()).to.equal(bondAmount);

      expect(suspectBalance.toString()).to.equal('0');
      expect(suspectLocker).to.equal(suspect);
      expect(suspectLockedTime.toString()).to.equal('0');
      expect(suspectRollbackSize.toString()).to.equal(fraudulentTransitionIndex.toString());

      expect(accuserBalance.toString()).to.equal(expectedAccuserBalance);
      expect(accuserLocker).to.equal(zeroAddress);
      expect(accuserLockedTime.toString()).to.equal('0');

      expect(receipt.gasUsed).to.equal(298471);
    });

    it('allows a user (accuser) to withdraw their balance (including thee reward).', async () => {
      const { receipt } = await contractInstance.withdraw(suspect, { from: accuser });
      const balanceUser0 = await contractInstance.balances(suspect);
      const balanceUser1 = await contractInstance.balances(accuser);

      expect(receipt.gasUsed).to.equal(21080);
      expect(balanceUser0.toString()).to.equal('0');
      expect(balanceUser1.toString()).to.equal('0');
    });

    it('allows a user (suspect) to rollback their call data tree.', async () => {
      const currentStateHex = '0x' + currentState.toString('hex');
      const proofOptions = { compact: true };

      // Suspect needs to create a call data Merkle Tree of all pre-invalid-transition call data
      // Note: rollbackSize is a bad name. Its really the expected size of the tree after the rollback is performed
      const oldCallData = callDataTree.elements.slice(0, fraudulentTransitionIndex);
      const rolledBackCallDataTree = new MerkleTree(oldCallData, treeOptions);
      const rolledBackCallDataRootHex = '0x' + rolledBackCallDataTree.root.toString('hex');

      const rolledBackCallDataArray = callDataTree.elements.slice(fraudulentTransitionIndex);
      const rolledBackCallDataArrayHex = rolledBackCallDataArray.map((c) => '0x' + c.toString('hex'));

      // Suspect needs to build an Append Proof to prove that the old call data root, when appended with the rolled call data,
      // has the root that equals the root of current on-chain call data tree
      const { proof } = rolledBackCallDataTree.appendMulti(rolledBackCallDataArray, proofOptions);
      const { compactProof: appendProof } = proof;
      const rollBackProofHex = appendProof.map((p) => '0x' + p.toString('hex'));

      // Suspect needs to prove to the current size of the on-chain call data tree
      const { root, elementCount: currentSize, elementRoot: sizeProof } = callDataTree.generateSizeProof({
        simple: true,
      });
      const callDataRootHex = '0x' + root.toString('hex');
      const currentSizeProofHex = '0x' + sizeProof.toString('hex');

      // Suspect performs the rollback while bonding new coin at the same time
      const { receipt, logs } = await contractInstance.rollback(
        rolledBackCallDataRootHex,
        rolledBackCallDataArrayHex,
        rollBackProofHex,
        currentSize,
        currentSizeProofHex,
        callDataRootHex,
        currentStateHex,
        lastTime,
        { value: bondAmount, from: suspect }
      );

      // Since the transaction executed successfully, update the locally maintained variables
      const block = await web3.eth.getBlock(receipt.blockNumber);
      lastTime = block.timestamp;
      callDataTree = rolledBackCallDataTree;
      currentState = rolledBackCallDataArray[0].slice(4, 36);
      fraudulentTransitionIndex = null;

      const accountState = await contractInstance.account_states(suspect);
      const expectedAccountState = hashPacked([callDataTree.root, currentState, to32ByteBuffer(lastTime)]);

      const suspectBalance = await contractInstance.balances(suspect);
      const suspectLocker = await contractInstance.lockers(suspect);
      const suspectRollbackSize = await contractInstance.rollback_sizes(suspect);

      expect(logs[0].event).to.equal('ORI_Rolled_Back');
      expect(logs[0].args[0]).to.equal(suspect);
      expect(logs[0].args[1].toString()).to.equal(callDataTree.elements.length.toString());
      expect(logs[0].args[2].toString()).to.equal(lastTime.toString());

      expect(suspectBalance.toString()).to.equal(bondAmount);
      expect(suspectLocker).to.equal(zeroAddress);
      expect(suspectRollbackSize.toString()).to.equal('0');

      expect(accountState).to.equal('0x' + expectedAccountState.toString('hex'));

      expect(receipt.gasUsed).to.equal(246897);
    });

    it('allows a user (suspect) to re-perform valid optimistic state transitions in batch.', async () => {
      const transitions = 100;
      const args = generateElements(transitions, { seed: '88' });
      const argsHex = args.map((a) => '0x' + a.toString('hex'));
      const proofOptions = { compact: true };

      // Compute the new states from the current state (which is the last state) and the args
      const callDataArray = [];
      let interimState = currentState;

      for (let i = 0; i < transitions; i++) {
        const interimStateHex = '0x' + interimState.toString('hex');

        // Get the call data from a logic request
        const { data: callDataHex } = await logicContractInstance.some_pure_transition.request(
          interimStateHex,
          argsHex[i],
          { from: suspect }
        );

        // Append call data to array, and update interim state
        const callData = Buffer.from(callDataHex.slice(2), 'hex');
        callDataArray.push(callData);
        interimState = getNewState(interimState, args[i]);
      }

      const callDataArrayHex = callDataArray.map((c) => '0x' + c.toString('hex'));
      const newStateHex = '0x' + interimState.toString('hex');
      const callDataRootHex = '0x' + callDataTree.root.toString('hex');

      // Build an Append Proof that enables appending new call data to the call data tree
      const { proof, newMerkleTree } = callDataTree.appendMulti(callDataArray, proofOptions);
      const { compactProof: appendProof } = proof;
      const proofHex = appendProof.map((p) => '0x' + p.toString('hex'));

      const { receipt, logs } = await contractInstance.perform_many_optimistically(
        callDataArrayHex,
        newStateHex,
        callDataRootHex,
        proofHex,
        lastTime,
        { from: suspect }
      );

      // Since the transaction executed successfully, update the locally maintained variables
      const block = await web3.eth.getBlock(receipt.blockNumber);
      lastTime = block.timestamp;
      callDataTree = newMerkleTree;
      currentState = interimState;

      const accountState = await contractInstance.account_states(suspect);
      const expectedAccountState = hashPacked([callDataTree.root, currentState, to32ByteBuffer(lastTime)]);

      expect(logs[0].event).to.equal('ORI_New_Optimistic_States');
      expect(logs[0].args[0]).to.equal(suspect);
      expect(logs[0].args[1].toString()).to.equal(lastTime.toString());

      expect(accountState).to.equal('0x' + expectedAccountState.toString('hex'));

      expect(receipt.gasUsed).to.equal(290306);
    });

    it('allows a user (suspect) to perform a normal state transition (and exit optimism).', async () => {
      // Need to increase time by at least 600 seconds for this to be allowed
      await advanceTime(lastTime + 700);

      const arg = generateElements(1, { seed: '99' })[0];
      const argHex = '0x' + arg.toString('hex');
      const currentStateHex = '0x' + currentState.toString('hex');

      // Get the call logic contract address and call data from a logic request
      const { data: callDataHex } = await logicContractInstance.some_pure_transition.request(currentStateHex, argHex, {
        from: suspect,
      });

      const callDataRootHex = '0x' + callDataTree.root.toString('hex');

      const { receipt, logs } = await contractInstance.perform_and_exit(callDataHex, callDataRootHex, lastTime, {
        from: suspect,
      });

      // Since the transaction executed successfully, update the locally maintained variables
      lastTime = 0;
      callDataTree = new MerkleTree([], treeOptions);
      currentState = getNewState(currentState, arg);

      const accountState = await contractInstance.account_states(suspect);
      const expectedAccountState = hashPacked([callDataTree.root, currentState, to32ByteBuffer(lastTime)]);
      const expectedAccountStateHex = '0x' + expectedAccountState.toString('hex');

      expect(accountState).to.equal(expectedAccountStateHex);

      expect(logs[0].event).to.equal('ORI_Exited_Optimism');
      expect(logs[0].args[0]).to.equal(suspect);

      expect(receipt.gasUsed).to.equal(289468);
    });

    it('allows a user (suspect) to perform valid optimistic state transitions in batch (and reenter optimism).', async () => {
      const transitions = 100;
      const args = generateElements(transitions, { seed: 'aa' });
      const argsHex = args.map((a) => '0x' + a.toString('hex'));
      const proofOptions = { compact: true };

      // Compute the new states from the current state (which is the last state) and the args
      const callDataArray = [];
      let interimState = currentState;

      for (let i = 0; i < transitions; i++) {
        const interimStateHex = '0x' + interimState.toString('hex');

        // Get the call data from a logic request
        const { data: callDataHex } = await logicContractInstance.some_pure_transition.request(
          interimStateHex,
          argsHex[i],
          { from: suspect }
        );

        // Append call data to array, and update interim state
        const callData = Buffer.from(callDataHex.slice(2), 'hex');
        callDataArray.push(callData);
        interimState = getNewState(interimState, args[i]);
      }

      const callDataArrayHex = callDataArray.map((c) => '0x' + c.toString('hex'));
      const newStateHex = '0x' + interimState.toString('hex');

      // Build an Append Proof that enables appending new call data to the call data tree
      const { proof, newMerkleTree } = callDataTree.appendMulti(callDataArray, proofOptions);
      const { compactProof: appendProof } = proof;
      const proofHex = appendProof.map((p) => '0x' + p.toString('hex'));

      const { receipt, logs } = await contractInstance.perform_many_optimistically_and_enter(
        callDataArrayHex,
        newStateHex,
        proofHex,
        { from: suspect }
      );

      // Since the transaction executed successfully, update the locally maintained variables
      const block = await web3.eth.getBlock(receipt.blockNumber);
      lastTime = block.timestamp;
      callDataTree = newMerkleTree;
      currentState = interimState;

      const accountState = await contractInstance.account_states(suspect);
      const expectedAccountState = hashPacked([callDataTree.root, currentState, to32ByteBuffer(lastTime)]);

      expect(logs[0].event).to.equal('ORI_New_Optimistic_States');
      expect(logs[0].args[0]).to.equal(suspect);
      expect(logs[0].args[1].toString()).to.equal(lastTime.toString());

      expect(accountState).to.equal('0x' + expectedAccountState.toString('hex'));

      expect(receipt.gasUsed).to.equal(261585);
    });
  });
});
