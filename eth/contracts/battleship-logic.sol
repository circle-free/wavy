pragma solidity >=0.6.0 <=0.7.3;
pragma experimental ABIEncoderV2;

// SPDX-License-Identifier: MIT

// board is 10x10 = 100 bits on right

// 1 Carrier of size 5
// 1 Battleship of size 4
// 2 Destroyers of size 3
// 2 Submarines of size 2

// bit-0 from left is carrier_is_placed
// bit-1 from left is battleship_is_placed
// bit-2 from left is destroyer_1_is_placed
// bit-3 from left is destroyer_2_is_placed
// bit-4 from left is submarine_1_is_placed
// bit-5 from left is submarine_2_is_placed

// bit-100 from right is ready

contract Battleship_Logic {
  function recover(bytes32 hash, bytes memory signature) internal pure returns (address signer) {
    require(signature.length == 65, "INVALID_SIG_LENGTH");

    // Divide the signature in r, s and v variables
    bytes32 r;
    bytes32 s;
    uint8 v;

    // ecrecover takes the signature parameters, and the only way to get them currently is to use assembly.
    // solhint-disable-next-line no-inline-assembly
    assembly {
      r := mload(add(signature, 0x20))
      s := mload(add(signature, 0x40))
      v := byte(0, mload(add(signature, 0x60)))
    }

    require(s <= 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0, "INVALID_SIG_S");

    require(v == 27 || v == 28, "INVALID_SIG_V");

    signer = ecrecover(hash, v, r, s);
    require(signer != address(0), "ECDSA: invalid signature");
  }

  function toEthSignedMessageHash(bytes32 hash) internal pure returns (bytes32) {
    return keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", hash));
  }

  function place_piece(
    bytes32 board_state,
    uint8 x,
    uint8 y,
    uint8 orientation,
    uint8 size
  ) public pure returns (bytes32) {
    require(size > 1 && size < 6, "INVALID_PIECE");
    require(size > 1 && size < 6, "INVALID_PIECE");
    require(orientation < 4, "INVALID_ORIENTATION");
    require(x < 10, "INVALID_ORIENTATION");
    require(y < 10, "INVALID_ORIENTATION");

    // first bit from left can't already be set
    if (size == 5) require(board_state >> 255 == bytes32(0), "ALREADY_PLACE");

    // second bit from left can't already be set
    if (size == 4) require((board_state >> 254) & bytes32(uint256(1)) == bytes32(0), "ALREADY_PLACE");

    // both of the third and fourth bit from left can't already be set
    if (size == 3) require((board_state >> 252) & bytes32(uint256(3)) != bytes32(uint256(3)), "ALREADY_PLACE");

    // both of the fifth and sixth bit from left can't already be set
    if (size == 2) require((board_state >> 250) & bytes32(uint256(3)) != bytes32(uint256(3)), "ALREADY_PLACE");

    // compute the starting bit mask from right
    bytes32 mask = bytes32(uint256(1)) << ((10 * y) + x);

    for (uint256 i; i < size; ++i) {
      require(mask > bytes32(0), "POSITION_TOO_LOW");
      require(mask < bytes32(uint256(100)), "POSITION_TOO_HIGh");
      require(board_state & mask != mask, "COORDINATE_TAKEN");

      // set the bit
      board_state |= mask;

      if (orientation == 0) {
        mask <<= 10; // 10 spots higher (north)
      } else if (orientation == 1) {
        mask <<= 1; // 1 spot higher (east)
      } else if (orientation == 2) {
        mask >>= 10; // 10 spots lower (south)
      } else {
        mask >>= 1; // 1 spot lower (west)
      }
    }

    return board_state;
  }

  function ready(bytes32 board_state) public pure returns (bytes32) {
    // first six bits must be set
    require(board_state >> 250 == bytes32(uint256(63)), "MISSING_PIECES");

    // now check that the total amount fo set bits in lower 100 is 19
    // this is useless, given place_piece should do correct work, but I want to waste gas
    bytes32 mask = bytes32(uint256(1));
    uint8 count;

    for (uint256 i; i < 100; ++i) {
      if (board_state & mask == mask) {
        count += 1;
      }

      mask <<= 1;
    }

    require(count == 19, "INVALID_SETUP");

    // set the 100-th bit from the right to mean "ready"
    board_state |= mask;

    return board_state;
  }

  function battle(
    address[2] memory addresses,
    bytes32[2] memory board_states,
    uint8[2][] memory x,
    uint8[2][] memory y,
    bytes[2] memory signatures
  ) public pure returns (bytes32[2] memory) {
    // Compute the game hash and check signatures
    // Note: This should be done in the Optimistic layer
    bytes32 game_hash = keccak256(abi.encodePacked(board_states, x, y));
    game_hash = toEthSignedMessageHash(game_hash);
    require(addresses[0] == recover(game_hash, signatures[0]));
    require(addresses[1] == recover(game_hash, signatures[1]));

    uint256 value1 = x[0].length;
    uint256 value2 = y[0].length;

    // Check that player 1 x and y lengths match
    require(value1 == value2, "INSTRUCTION_MISMATCH");

    value2 = y[1].length;

    // Check that player 1 as many, or one more, moves than player 2
    require((value1 == value2) || (value1 + 1 == value2), "INSTRUCTION_MISMATCH");

    value1 = x[1].length;

    // Check that player 2 x and y lengths match
    require(value1 == value2, "INSTRUCTION_MISMATCH");

    // Save states to stack
    bytes32 player_1_board_state = board_states[0];
    bytes32 player_2_board_state = board_states[1];

    value1 = 0; // instruction index
    value2 = 0; // turn
    bytes32 mask;

    uint256 value3; // player 1 damage count
    uint256 value4; // player 2 damage count

    while (true) {
      if (value2 == 0) {
        // Compute hit mask
        mask = bytes32(uint256(1)) << ((10 * y[0][value1]) + x[0][value1]);

        if (player_2_board_state & mask != mask) continue; // missed

        player_2_board_state &= ~mask; // unset the bit (was hit)
        value4 += 1; // increase damage

        if (value4 != 19) continue; // not enough damage

        mask = bytes32(uint256(1)) << 100;
        player_2_board_state &= ~mask; // unset the ready flag (player 2 lost)

        break;
      } else {
        mask = bytes32(uint256(1)) << ((10 * y[1][value1]) + x[1][value1]);

        if (player_1_board_state & mask != mask) continue; // missed

        player_1_board_state &= ~mask; // unset the bit (was hit)
        value3 += 1; // increase damage

        if (value3 != 19) continue; // not enough damage

        mask = bytes32(uint256(1)) << 100;
        player_1_board_state &= ~mask; // unset the ready flag (player 1 lost)

        break;
      }
    }

    board_states[0] = player_1_board_state;
    board_states[1] = player_2_board_state;

    return board_states;
  }
}
