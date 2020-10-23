const assert = require('assert');
const VerifiableDelayFunction = require('verifiable-delay-functions');

const { openPack } = require('./contract');

// Returns the index of invalidity
const verifyBeacons = (_beacons, _prime, _iterations, _vdfValues) => {
  const beacons = toBigInt(_beacons);
  const prime = toBigInt(_prime);
  const iterations = toBigInt(_iterations);
  const vdfValues = toBigInt(_vdfValues);

  if (beacons.length !== vdfValues) return 0;

  const x = beacons[0];
  const yValues = beacons.slice(1);

  const vdfOptions = { type: 'sloth', prime };
  const result = VerifiableDelayFunction.verifyDelayWithIntermediates(yValues, x, iterations, vdfOptions);
  const { valid, invalidBeaconIndex } = result;

  return valid ? null : invalidBeaconIndex;
};

const openPackVerifier = (prime, iterations, vdfValues) => (decodedCallData, newStateHex) => {
  const { user: userHex, state: currentStateHex, pack_index: packIndex, beacons } = decodedCallData;

  const invalidBeaconIndex = verifyBeacons(beacons, prime, iterations, vdfValues);

  if (invalidBeaconIndex != null) return { valid: false, additionalInfo: { invalidBeaconIndex } };

  const { packsTree, cardsTree } = openPack(userHex, currentStateHex, packIndex, beacons);

  return { valid: toHex(hashPacked([packsTree.root, cardsTree.root])) === newStateHex };
};

module.exports = {
  openPackVerifier,
};
