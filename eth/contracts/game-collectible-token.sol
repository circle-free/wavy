pragma solidity <=0.7.3;

import "openzeppelin-solidity/contracts/token/ERC721/ERC721.sol";

contract Game_Collectible_Token is ERC721 {
    constructor () ERC721("GameCollectible", "GCT") {
    }

    function mint(address to, uint256 tokenId) external {
        _mint(to, tokenId);
    }

    function burn(uint256 tokenId) external {
        _burn(tokenId);
    }
}