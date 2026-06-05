// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Script, console2} from "forge-std/Script.sol";
import {TradeEscrow} from "../src/TradeEscrow.sol";
import {MockYieldVault} from "../test/helpers/MockYieldVault.sol";

// Deploys a USYC stand-in vault and wires it into the escrow via setYieldVault.
// USYC is gated; this mock lets us prove the yield-split mechanism live now and
// swap in real USYC later with the same call. setYieldVault is owner-gated, so
// the broadcaster MUST be the escrow owner (the deployer EOA).
//
// Required env:
//   TP_USDC       — USDC address on Arc Testnet
//   TRADE_ESCROW  — deployed TradeEscrow address
//   PRIVATE_KEY   — owner/deployer key (or --private-key)
//
// Usage:
//   TP_USDC=0x3600000000000000000000000000000000000000 \
//   TRADE_ESCROW=0x905876413A9b56a6581CCe406CAb2ad849566172 \
//   forge script script/DeployYieldVault.s.sol:DeployYieldVault \
//     --rpc-url https://rpc.testnet.arc.network --broadcast --private-key $KEY
contract DeployYieldVault is Script {
    function run() external returns (MockYieldVault vault) {
        address usdc = vm.envAddress("TP_USDC");
        address escrowAddr = vm.envAddress("TRADE_ESCROW");

        vm.startBroadcast();
        vault = new MockYieldVault(usdc);
        TradeEscrow(escrowAddr).setYieldVault(address(vault));
        vm.stopBroadcast();

        console2.log("MockYieldVault deployed at", address(vault));
        console2.log("escrow.yieldVault now     ", address(TradeEscrow(escrowAddr).yieldVault()));
    }
}
