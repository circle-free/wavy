// SPDX-License-Identifier: MIT

pragma solidity <=0.7.3;
pragma experimental ABIEncoderV2;

import "optimistic-roll-in/eth/contracts/optimistic-roll-in.sol";

contract Some_Roll_In is Optimistic_Roll_In {
  constructor(
    address _logic_address,
    bytes4 _initializer,
    uint256 _lock_time,
    uint256 _min_bond
  ) Optimistic_Roll_In(_logic_address, _initializer, _lock_time, _min_bond) {}
}
