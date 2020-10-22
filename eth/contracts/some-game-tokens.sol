pragma solidity <=0.7.3;

import "openzeppelin-solidity/contracts/token/ERC721/ERC721.sol";

contract Some_Game_Tokens is ERC721 {
  constructor() ERC721("Some_Game_Tokens", "SGT") {}

  function mint(address to, uint256 tokenId) external {
    _mint(to, tokenId);
  }

  function burn(uint256 tokenId) external {
    _burn(tokenId);
  }
}
