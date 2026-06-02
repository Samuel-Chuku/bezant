// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Script, console2} from "forge-std/Script.sol";
import {PactWrapper} from "../src/PactWrapper.sol";

// Deploys PactWrapper to the configured chain.
//
// Required env vars:
//   WRAPPER_USDC              — USDC token address on target chain
//   WRAPPER_AGENTIC_COMMERCE  — ERC-8183 reference contract address
//   WRAPPER_TREASURY          — initial platform treasury address
//   WRAPPER_FEE_BPS           — initial platform fee in bps (0..1000)
//   PRIVATE_KEY               — deployer private key (passed via --private-key flag is also fine)
//
// Arc Testnet defaults (override via env):
//   WRAPPER_USDC=0x3600000000000000000000000000000000000000
//   WRAPPER_AGENTIC_COMMERCE=0x0747EEf0706327138c69792bF28Cd525089e4583
//
// Usage:
//   forge script script/Deploy.s.sol:Deploy \
//     --rpc-url $ARC_RPC_URL \
//     --broadcast \
//     --verify
contract Deploy is Script {
    function run() external returns (PactWrapper wrapper) {
        address usdc            = vm.envAddress("WRAPPER_USDC");
        address agenticCommerce = vm.envAddress("WRAPPER_AGENTIC_COMMERCE");
        address treasury        = vm.envAddress("WRAPPER_TREASURY");
        uint256 feeBpsU256      = vm.envUint("WRAPPER_FEE_BPS");
        require(feeBpsU256 <= type(uint16).max, "WRAPPER_FEE_BPS overflow");
        uint16 feeBps = uint16(feeBpsU256);

        console2.log("Deploying PactWrapper");
        console2.log("  usdc            ", usdc);
        console2.log("  agenticCommerce ", agenticCommerce);
        console2.log("  treasury        ", treasury);
        console2.log("  feeBps          ", feeBps);

        vm.startBroadcast();
        wrapper = new PactWrapper(usdc, agenticCommerce, treasury, feeBps);
        vm.stopBroadcast();

        console2.log("PactWrapper deployed at", address(wrapper));
        console2.log("Owner                  ", wrapper.owner());
    }
}
