// SPDX-License-Identifier: MIT

pragma solidity <=0.7.3;
pragma experimental ABIEncoderV2;

import "merkle-trees/eth/contracts/libraries/memory/bytes32/standard/merkle-library.sol";

contract Some_Game {
  event SG_New_Packs(uint256 indexed pack_count, bytes32 indexed block_hash);

  modifier valid_roots(
    bytes32 current_state,
    bytes32 packs_root,
    bytes32 cards_root
  ) {
    require(current_state == keccak256(abi.encodePacked(packs_root, cards_root)), "INVALID_USER_ROOTS");
    _;
  }

  function get_initial_state(address user) external payable returns (bytes32) {
    return keccak256(abi.encodePacked(bytes32(0), bytes32(0)));
  }

  // Impure, payable, and therefore not possible as an optimistic transition
  function buy_packs(
    address user,
    bytes32 current_state,
    bytes32 packs_root,
    bytes32[] calldata pack_append_proof,
    bytes32 cards_root
  ) external payable valid_roots(current_state, packs_root, cards_root) returns (bytes32 new_state) {
    uint256 pack_count = msg.value / 1e12;

    // Must pay for aat least 1 pack
    require(pack_count > 0, "INCORRECT_PAYMENT");

    // use new_state as last block has for now
    bytes32 block_hash = blockhash(block.number - 1);

    // Build random pack data
    bytes32[] memory packs = new bytes32[](pack_count);
    for (uint256 i; i < pack_count; ++i) {
      packs[i] = keccak256(abi.encodePacked(user, i, block_hash));
    }

    // Append packs to user's packs root
    packs_root = Merkle_Library_MB32S.try_append_many(packs_root, packs, pack_append_proof);

    // returns new user state
    new_state = keccak256(abi.encodePacked(packs_root, cards_root));

    emit SG_New_Packs(pack_count, block_hash);
  }

  // Pure and therefore possible as an optimistic transition
  function open_pack(
    address user,
    bytes32 current_state,
    uint256 pack_index,
    bytes32 pack,
    bytes32 packs_root,
    bytes32[] calldata pack_proof,
    bytes32 cards_root,
    bytes32[] calldata cards_append_proof
  ) external pure valid_roots(current_state, packs_root, cards_root) returns (bytes32 new_state) {
    // Make sure pack isn't already opened
    require(pack != bytes32(0), "ALREADY_OPENED");

    // Build random card data
    bytes32[] memory cards = new bytes32[](10);
    for (uint256 i; i < 10; ++i) {
      cards[i] = keccak256(abi.encodePacked(user, pack, i));
    }

    // Clear pack to user's packs root
    packs_root = Merkle_Library_MB32S.try_update_one(packs_root, pack_index, pack, bytes32(0), pack_proof);

    // Append cards to user's cards root
    cards_root = Merkle_Library_MB32S.try_append_many(cards_root, cards, cards_append_proof);

    // returns new user state
    new_state = keccak256(abi.encodePacked(packs_root, cards_root));
  }
}
