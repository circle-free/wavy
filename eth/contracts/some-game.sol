// SPDX-License-Identifier: MIT

pragma solidity <=0.7.3;
pragma experimental ABIEncoderV2;

import "merkle-trees/eth/contracts/libraries/memory/bytes32/standard/merkle-library.sol";
import "openzeppelin-solidity/contracts/token/ERC721/IERC721.sol";

interface IGameCollectibleToken is IERC721 {
  function mint(address to, uint256 token_id) external;

  function burn(uint256 token_id) external;
}

contract Some_Game {
  IGameCollectibleToken public token_contract;
  mapping(uint256 => bytes32) public exported_cards;
  uint256 public exported_card_count;

  event SG_New_Packs(uint256 indexed pack_count, bytes32 indexed block_hash);
  event SG_Export_Card(uint256 indexed token_id);
  event SG_Import_Card(bytes32 indexed card);

  modifier valid_roots(
    bytes32 state,
    bytes32 packs_root,
    bytes32 cards_root
  ) {
    require(state == keccak256(abi.encodePacked(packs_root, cards_root)), "INVALID_USER_ROOTS");
    _;
  }

  constructor(address tokenContractAddress) {
    token_contract = IGameCollectibleToken(tokenContractAddress);
  }

  function initialize_state(address user) external payable returns (bytes32 new_state) {
    return keccak256(abi.encodePacked(bytes32(0), bytes32(0)));
  }

  // Impure, payable, and therefore not possible as an optimistic transition
  function buy_packs(
    address user,
    bytes32 state,
    bytes32 packs_root,
    bytes32[] calldata pack_append_proof,
    bytes32 cards_root
  ) external payable valid_roots(state, packs_root, cards_root) returns (bytes32 new_state) {
    uint256 pack_count = msg.value / 1e12;

    // Must pay for aat least 1 pack
    require(pack_count > 0, "INCORRECT_PAYMENT");

    // Use new_state as last block hash for now
    new_state = blockhash(block.number - 1);

    // Build random pack data
    bytes32[] memory packs = new bytes32[](pack_count);
    for (uint256 i; i < pack_count; ++i) {
      packs[i] = keccak256(abi.encodePacked(user, i, new_state));
    }

    // Append packs to user's packs root
    packs_root = Merkle_Library_MB32S.try_append_many(packs_root, packs, pack_append_proof);

    emit SG_New_Packs(pack_count, new_state);

    // Return new user state
    return keccak256(abi.encodePacked(packs_root, cards_root));
  }

  // Pure and therefore possible as an optimistic transition
  function open_pack(
    address user,
    bytes32 state,
    uint256 pack_index,
    bytes32 pack,
    bytes32 packs_root,
    bytes32[] calldata pack_proof,
    bytes32 cards_root,
    bytes32[] calldata cards_append_proof
  ) external pure valid_roots(state, packs_root, cards_root) returns (bytes32 new_state) {
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

    // Return new user state
    return keccak256(abi.encodePacked(packs_root, cards_root));
  }

  // Impure, and therefore not possible as an optimistic transition
  function export_card_to_token(
    address user,
    bytes32 state,
    bytes32 packs_root,
    bytes32 cards_root,
    uint256 card_index,
    bytes32 card,
    bytes32[] calldata card_proof
  ) external valid_roots(state, packs_root, cards_root) returns (bytes32 new_state) {
    // Make sure card slot is not empty
    require(card != bytes32(0), "INVALID_CARD");

    // Empty the card slot in the cards array
    cards_root = Merkle_Library_MB32S.try_update_one(cards_root, card_index, card, bytes32(0), card_proof);

    // Mints new token for this user, assigning it an incremental id
    token_contract.mint(user, exported_card_count);

    // Saves exported card data to world state
    exported_cards[exported_card_count] = card;

    emit SG_Export_Card(exported_card_count++);

    // Return new user state
    return keccak256(abi.encodePacked(packs_root, cards_root));
  }

  // Impure, and therefore not possible as an optimistic transition
  function import_card_from_token(
    address user,
    bytes32 state,
    bytes32 packs_root,
    bytes32 cards_root,
    bytes32[] calldata card_append_proof,
    uint256 token_id
  ) external valid_roots(state, packs_root, cards_root) returns (bytes32 new_state) {
    // Make sure user is owner of this token
    require(token_contract.ownerOf(token_id) == user, "NOT_OWNER");

    // Burn the token
    token_contract.burn(token_id);

    // Use new_state as card for now
    new_state = exported_cards[token_id];

    emit SG_Import_Card(new_state);

    // Empty this card's data from it's slot in the world state
    exported_cards[token_id] = bytes32(0);

    // Add card to card root
    cards_root = Merkle_Library_MB32S.try_append_one(cards_root, new_state, card_append_proof);

    // Return new user state
    return keccak256(abi.encodePacked(packs_root, cards_root));
  }
}
