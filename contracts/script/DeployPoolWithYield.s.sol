// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Script, console2} from "forge-std/Script.sol";
import {TradeEscrow} from "../src/TradeEscrow.sol";
import {FinancingPool} from "../src/FinancingPool.sol";
import {MockYieldVault} from "../test/helpers/MockYieldVault.sol";

// Redeploys the FinancingPool with USYC-on-idle and re-points the existing
// escrow at it — NO escrow/passport redeploy. Deploys a dedicated USYC stand-in
// vault for the pool (real USYC is gated; swap it in later via setYieldVault).
//
// Idle pool USDC is parked in this vault; sending USDC to the vault address
// raises its redemption value, which lifts pool NAV — that's the funded yield.
//
// setFinancingPool + setYieldVault are owner-gated, so the broadcaster MUST be
// the escrow owner (the deployer EOA).
//
// PRE-CHECK: the OLD pool must have outstanding == 0 (no live advances) and be
// drained of LP funds first — share state can't migrate to a new contract.
//
// Required env:
//   TP_USDC       — USDC address on Arc Testnet
//   TRADE_ESCROW  — deployed TradeEscrow address (to re-point)
//   PRIVATE_KEY   — escrow owner / deployer key (or --private-key)
//
// Usage:
//   TP_USDC=0x3600000000000000000000000000000000000000 \
//   TRADE_ESCROW=0x... \
//   forge script script/DeployPoolWithYield.s.sol:DeployPoolWithYield \
//     --rpc-url https://rpc.testnet.arc.network --broadcast --private-key $KEY
contract DeployPoolWithYield is Script {
    function run() external returns (FinancingPool pool, MockYieldVault vault) {
        address usdc = vm.envAddress("TP_USDC");
        address escrowAddr = vm.envAddress("TRADE_ESCROW");

        vm.startBroadcast();
        pool = new FinancingPool(usdc);
        vault = new MockYieldVault(usdc);
        pool.setEscrow(escrowAddr);
        pool.setYieldVault(address(vault));
        TradeEscrow(escrowAddr).setFinancingPool(address(pool));
        vm.stopBroadcast();

        console2.log("FinancingPool deployed at ", address(pool));
        console2.log("pool yield vault          ", address(pool.yieldVault()));
        console2.log("escrow.financingPool now  ", address(TradeEscrow(escrowAddr).financingPool()));
        console2.log("deploy block              ", block.number);
    }
}
