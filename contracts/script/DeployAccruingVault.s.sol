// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Script, console2} from "forge-std/Script.sol";
import {FinancingPool} from "../src/FinancingPool.sol";
import {AccruingYieldVault} from "../src/AccruingYieldVault.sol";

// Deploys a USYC-faithful accruing vault and points the FinancingPool at it via
// setYieldVault — which divests the pool's current (inert) vault position and
// re-parks it into the accruing one. NO pool/escrow redeploy.
//
// After this runs: fund the new vault's reserve by sending USDC to its address
// (covers the accrued yield on redemption); NAV then grows hands-off at APY_BPS.
//
// setYieldVault is owner-gated, so the broadcaster MUST be the pool owner
// (the deployer EOA).
//
// Required env:
//   TP_USDC         — USDC address on Arc Testnet
//   FINANCING_POOL  — deployed FinancingPool address (the live pool)
//   APY_BPS         — optional, annual yield in bps (default 400 = 4%)
//   PRIVATE_KEY     — pool owner / deployer key (or --private-key)
//
// Usage:
//   TP_USDC=0x3600000000000000000000000000000000000000 \
//   FINANCING_POOL=0xB968aF326313692DDF423B86383d31C684D24eE5 \
//   APY_BPS=400 \
//   forge script script/DeployAccruingVault.s.sol:DeployAccruingVault \
//     --rpc-url https://rpc.testnet.arc.network --broadcast --private-key $KEY
contract DeployAccruingVault is Script {
    function run() external returns (AccruingYieldVault vault) {
        address usdc = vm.envAddress("TP_USDC");
        address poolAddr = vm.envAddress("FINANCING_POOL");
        uint256 apyBps = vm.envOr("APY_BPS", uint256(400));

        vm.startBroadcast();
        vault = new AccruingYieldVault(usdc, apyBps);
        FinancingPool(poolAddr).setYieldVault(address(vault));
        vm.stopBroadcast();

        console2.log("AccruingYieldVault deployed at", address(vault));
        console2.log("apyBps                        ", vault.apyBps());
        console2.log("pool.yieldVault now           ", address(FinancingPool(poolAddr).yieldVault()));
        console2.log("FUND THE RESERVE: send USDC to the vault address above.");
    }
}
