// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Script, console2} from "forge-std/Script.sol";
import {TradeEscrow} from "../src/TradeEscrow.sol";
import {TradePassport} from "../src/TradePassport.sol";
import {FinancingPool} from "../src/FinancingPool.sol";

// Deploys the standalone TradePass stack (no ERC-8183) and wires the seams.
//
// Required env vars:
//   TP_USDC      — USDC token address on the target chain
//   TP_ATTESTER  — the Trade Officer agent wallet (initial authorized attester)
//   PRIVATE_KEY  — deployer key (or pass --private-key)
//
// Optional:
//   TP_TREASURY  — yield-slice fallback when no pool set (defaults to deployer)
//   TP_POOL_SEED — USDC the deployer pre-funds into the financing pool (default 0;
//                  requires the deployer to hold + approve USDC, so usually 0 here)
//
// Arc Testnet defaults (override via env):
//   TP_USDC=0x3600000000000000000000000000000000000000
//
// Usage (real deploy):
//   forge script script/DeployTradePass.s.sol:DeployTradePass \
//     --rpc-url $ARC_RPC_URL --broadcast --verify
//
// Usage (local wiring simulation — no broadcast, prints addresses):
//   TP_USDC=0x3600000000000000000000000000000000000000 \
//   TP_ATTESTER=0x000000000000000000000000000000000000A11c \
//   forge script script/DeployTradePass.s.sol:DeployTradePass
contract DeployTradePass is Script {
    function run()
        external
        returns (TradePassport passport, FinancingPool pool, TradeEscrow escrow)
    {
        address usdc     = vm.envAddress("TP_USDC");
        address attester = vm.envAddress("TP_ATTESTER");

        console2.log("Deploying TradePass stack");
        console2.log("  usdc     ", usdc);
        console2.log("  attester ", attester);

        vm.startBroadcast();

        passport = new TradePassport();
        pool     = new FinancingPool(usdc);
        escrow   = new TradeEscrow(usdc, address(passport));

        // wire the seams
        passport.setWriter(address(escrow), true); // escrow may record outcomes
        pool.setEscrow(address(escrow));            // only escrow draws advances
        escrow.setFinancingPool(address(pool));     // financing leg
        escrow.setAttester(attester, true);         // Trade Officer agent = attester arm 1

        vm.stopBroadcast();

        console2.log("TradePassport deployed at", address(passport));
        console2.log("FinancingPool deployed at", address(pool));
        console2.log("TradeEscrow   deployed at", address(escrow));
        console2.log("escrow.owner            ", escrow.owner());
        console2.log("yieldVault (set later)  ", address(escrow.yieldVault()));
    }
}
