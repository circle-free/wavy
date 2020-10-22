const SomeGameTokens = artifacts.require('Some_Game_Tokens');
const SomeGameArtifact = artifacts.require('Some_Game');
const SomeRollIn = artifacts.require('Some_Roll_In');

module.exports = function(deployer, network) {
  deployer.deploy(SomeGameTokens)
    .then(() => SomeGameTokens.deployed())
    .then(tokenContact => deployer.deploy(SomeGameArtifact, tokenContact.address))
    .then(() => SomeGameArtifact.deployed())
    .then(gameContact => {
      const lockTime = network === 'development' ? '600' : '60';   // 10 minutes or 1 minute
      const minBond = network === 'development' ? '1000000000000000000' : '10000000000000';   // 1 or 0.0001

      return deployer.deploy(SomeRollIn, gameContact.address, '0x7ed30689', lockTime, minBond);
    })
    .then(() => SomeRollIn.deployed());
};
