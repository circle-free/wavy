// SPDX-License-Identifier: MIT

pragma solidity <=0.7.3;
pragma experimental ABIEncoderV2;

import "merkle-trees/eth/contracts/libraries/memory/bytes32/standard/merkle-library.sol";

contract Game_Collectibles {
  event Packs_Purchased(uint256 indexed pack_count, uint256 indexed block_time);

  function get_initial_state() external pure returns (bytes32) {
    return keccak256(abi.encodePacked(bytes32(0), bytes32(0)));
  }

  // Impure, payable, and therefore not possible as an optimistic transition
  function buy_packs(
    bytes32 current_state,
    uint256 pack_count,
    bytes32 packs_root,
    bytes32[] calldata pack_append_proof,
    bytes32 cards_root
  ) external payable returns (bytes32 new_state) {
    // Payment for the packs must be exact
    require(msg.value == 1e12 * pack_count, "INCORRECT_PAYMENT");

    // Check that user's provided pack and card roots match their current state
    require(keccak256(abi.encodePacked(packs_root, cards_root)) == current_state, "INVALID_USER_ROOTS");

    // Build random pack data
    bytes32[] memory packs = new bytes32[](pack_count);
    for (uint256 i; i < pack_count; ++i) {
      packs[i] = keccak256(abi.encodePacked(current_state, i, block.timestamp));
    }

    // Append packs to user's packs root
    packs_root = Merkle_Library_MB32S.try_append_many(packs_root, packs, pack_append_proof);

    emit Packs_Purchased(pack_count, block.timestamp);

    // returns new user state
    new_state = keccak256(abi.encodePacked(packs_root, cards_root));
  }

  // Pure and therefore possible as an optimistic transition
  function open_pack(
    bytes32 current_state,
    uint256 pack_index,
    bytes32 pack,
    bytes32 packs_root,
    bytes32[] calldata pack_proof,
    bytes32 cards_root,
    bytes32[] calldata cards_append_proof
  ) external pure returns (bytes32 new_state) {
    // Check that user's provided pack and card roots match their current state
    require(keccak256(abi.encodePacked(packs_root, cards_root)) == current_state, "INVALID_USER_ROOTS");

    // Make sure pack isn't already opened
    require(pack != bytes32(0), "ALREADY_OPENED");

    // Build random card data
    bytes32[] memory cards = new bytes32[](10);
    for (uint256 i; i < 10; ++i) {
      cards[i] = keccak256(abi.encodePacked(pack, i));
    }

    // Clear pack to user's packs root
    packs_root = Merkle_Library_MB32S.try_update_one(packs_root, pack_index, pack, bytes32(0), pack_proof);

    // Append cards to user's cards root
    cards_root = Merkle_Library_MB32S.try_append_many(cards_root, cards, cards_append_proof);

    // returns new user state
    new_state = keccak256(abi.encodePacked(packs_root, cards_root));
  }
}
