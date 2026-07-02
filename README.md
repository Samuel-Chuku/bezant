# Bezant

**Trust infrastructure for stablecoin trade.** Bezant is a stablecoin-native
trade-finance protocol on [Arc](https://docs.arc.network/) (Circle's L1). Buyers
lock USDC in escrow, sellers get paid on **verified delivery**, and every settled
deal builds a **portable on-chain credit passport** that prices the next trade.

> Repo directory is `arc-trade` (the original working title); the product is **Bezant** (bezant.trade).

---

## Overview

Cross-border SME trade still settles on trust it can't verify: opaque deposits,
slow escrow, no portable reputation. Bezant replaces that with:

- **Bonds** — USDC escrow (ERC-8183) struck between a buyer and seller. Funds
  release automatically once delivery is attested on chain.
- **Credit passport** — each settled bond writes to a portable ERC-8004 identity.
  Your history lowers your required deposit over time (100% → floor 40%).
- **Verified delivery** — an automated **Trade Officer** or a stake-weighted
  **verifier panel** attests delivery; a challenge window protects both sides.
- **Financing pool** — LPs front sellers their payment the moment escrow funds
  and earn the financing fee (plus idle-reserve USYC yield).
- **CCTP bridge** — move USDC to Arc from any supported testnet via Circle's
  Cross-Chain Transfer Protocol.
- **Passwordless onboarding** — sign in with an email + passkey backed by a
  Circle smart account, or connect your own wallet.

## How it works

```
 Strike ──▶ Fund ──▶ Deliver ──▶ Attest ──▶ Settle
  buyer     buyer     seller     officer/    escrow → seller
  sets      locks     uploads    panel       (passport updated)
  terms     deposit   proof      verifies
```

1. **Strike** — the buyer proposes amount, milestone and deadline; the deposit is
   priced by their credit passport tier.
2. **Fund** — the buyer locks the deposit in the escrow contract (optionally
   bridging USDC in first, or drawing seller financing from the pool).
3. **Deliver & attest** — the seller submits the delivery document; the Trade
   Officer or a drawn verifier panel checks it and signs an attestation on chain.
4. **Settle** — after the challenge window, escrow releases to the seller and the
   buyer's passport is updated. Disputes route to an arbitrator.

## Architecture

```
Browser ──HTTP──▶ backend (Fastify) ──┬──▶ Circle API (smart wallets, USDC)
   │                                  ├──▶ Arc RPC (contract reads/writes)
   │                                  └──▶ SQLite (event indexer + app state)
   └── wallet / passkey signs txs; backend builds unsigned txs + serves reads
```

The frontend never holds the Circle API key — only the backend does. Contract
events are indexed into SQLite so reads (activity, protocol stats, feeds) are
served without per-request chain scans.

### Monorepo layout

```
arc-trade/
  contracts/   Solidity contracts (Foundry)
  backend/     API + indexer (Fastify + TypeScript + better-sqlite3)
  frontend/    Web app (Next.js 15 App Router + TypeScript + Tailwind)
```

Each subdirectory is an independent project with its own `package.json`.

### Smart contracts (`contracts/src`)

| Contract | Role |
| --- | --- |
| `TradeEscrow.sol` | Core bond lifecycle: propose, fund, attest, settle, dispute, refund. |
| `TradePassport.sol` | Per-address credit passport; tiers deposit requirements from settled history. |
| `FinancingPool.sol` | LP vault that advances sellers against funded escrows; earns fees. |
| `StakedVerifierModule.sol` | Stake-weighted verifier panel that votes on delivery; slashes bad votes / no-shows. |
| `AccruingYieldVault.sol` | Idle-reserve yield (USYC) for the financing pool. |

## Tech stack

- **Contracts:** Solidity, Foundry (`forge`), Arc Testnet.
- **Backend:** Node.js, Fastify, TypeScript, `viem`, `better-sqlite3`, Circle SDK.
- **Frontend:** Next.js 15, React, TypeScript, Tailwind CSS, wagmi + RainbowKit,
  Circle Modular Wallets (passkeys). Design system: **Ink & Mint** (Fraunces /
  Bricolage Grotesque / JetBrains Mono).

## Prerequisites

- Node.js 20+
- [Foundry](https://book.getfoundry.sh/) (for contracts)
- A Circle Developer account (API key, client key, entity secret)
- Testnet USDC on Arc — [faucet.circle.com](https://faucet.circle.com/)

## Quickstart

```bash
git clone https://github.com/Samuel-Chuku/bezant.git
cd bezant
```

**Backend**

```bash
cd backend
npm install
cp .env.example .env   # fill in Circle keys + contract addresses
npm run dev            # http://localhost:3001
```

**Frontend**

```bash
cd frontend
npm install
cp .env.example .env   # NEXT_PUBLIC_API_BASE + Circle client keys
npm run dev            # http://localhost:3000
```

**Contracts**

```bash
cd contracts
forge build
forge test
# deploy with a script under contracts/script (see Foundry docs)
```

## Environment

Secrets live in each subdirectory's `.env` (never committed); `.env.example`
documents the required keys.

- **backend** — `PORT`, `CORS_ORIGINS`, Circle API key / entity secret,
  `CIRCLE_OPERATOR_ADDRESS`, contract addresses (`TRADE_ESCROW_ADDRESS`,
  `FINANCING_POOL_ADDRESS`, `STAKED_VERIFIER_ADDRESS`,
  `ARC_IDENTITY_REGISTRY_ADDRESS`), `TRADE_ESCROW_DEPLOY_BLOCK`,
  `OFFICER_CHALLENGE_WINDOW_SECONDS`.
- **frontend** — `NEXT_PUBLIC_API_BASE`, `NEXT_PUBLIC_CIRCLE_CLIENT_KEY`,
  `NEXT_PUBLIC_CIRCLE_CLIENT_URL`, `NEXT_PUBLIC_CIRCLE_CHAIN_ALIAS`,
  `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID`.

## Scripts

| Package | Command | What it does |
| --- | --- | --- |
| backend | `npm run dev` | Fastify API + indexer, hot-reload. |
| backend | `npm run smoke:trade` / `smoke:officer` / `smoke:dispute` | End-to-end flow smoke tests. |
| frontend | `npm run dev` / `build` / `start` | Next.js dev / production build / serve. |
| frontend | `npm run lint` | ESLint. |
| contracts | `forge build` / `forge test` | Compile / test contracts. |

## Networks

| Resource | Link |
| --- | --- |
| Arc docs | https://docs.arc.network/ |
| Circle docs | https://developers.circle.com/ |
| Arc Testnet explorer | https://testnet.arcscan.app/ |
| USDC faucet | https://faucet.circle.com/ |

## Status

Testnet. Deployed on Arc Testnet; USDC by Circle. Not audited — do not use with
real funds.

## License

MIT (unless noted otherwise per package).
