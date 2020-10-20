// SPDX-License-Identifier: MIT

pragma solidity >=0.5.0 <=0.7.3;

contract Migrations {
  address public owner;
  // solhint-disable-next-line var-name-mixedcase
  uint256 public last_completed_migration;

  constructor() public {
    owner = msg.sender;
  }

  modifier restricted() {
    if (msg.sender == owner) _;
  }

  function setCompleted(uint256 completed) public restricted {
    last_completed_migration = completed;
  }
}