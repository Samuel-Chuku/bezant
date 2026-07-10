# Bezant

**Trade finance for stablecoins.** Buyers lock USDC in escrow, sellers get paid
the moment delivery is verified, and every settled deal builds a portable
on-chain credit history that prices the next one.

Live on [Arc](https://docs.arc.network/) (Circle's USDC-native L1) — **testnet**.
→ **App: [app.bezant.trade](https://app.bezant.trade)** · Site: [bezant.trade](https://bezant.trade)

---

## Why it exists

Cross-border trade still runs on trust it can't verify: opaque deposits, slow
escrow, and reputation that doesn't travel. A first-time counterparty and a
hundred-deal veteran get treated the same.

Bezant settles on **proof** and prices on **history**. USDC sits in escrow until
delivery is attested on chain; when it settles, both sides earn a credit passport
that follows them to the next deal and lowers what they have to put up.

## Who it's for

### 🤝 Traders — buyers & sellers
Strike a **bond**: a USDC escrow with agreed terms, milestone, and deadline. The
buyer's deposit is priced by their credit passport (starts at 100% of value,
falls to a 40% floor as their settled history grows). The seller is paid
automatically on verified delivery — no chasing, no counterparty risk on the
locked amount. Every settled bond upgrades both passports.

### ✅ Verifiers — earn by attesting delivery
Delivery is confirmed by an automated **Trade Officer** or, for higher-value
deals, a **stake-weighted verifier panel**. Verifiers stake USDC, get drawn onto
panels, vote on whether delivery matches terms, and earn fees for honest votes —
bad votes and no-shows are slashed. A challenge window protects both trader sides.

### 💰 Financiers — liquidity providers
Sellers often can't wait for the challenge window. LPs deposit into the
**financing pool** and front sellers their payment the instant escrow is funded,
earning the financing fee. Idle reserves earn USYC yield in the meantime.

## How a deal works

```
 Strike ──▶ Fund ──▶ Deliver ──▶ Attest ──▶ Settle
  buyer     buyer     seller     officer/    escrow → seller
  sets      locks     uploads    panel       (passports updated)
  terms     deposit   proof      verifies
```

1. **Strike** — the buyer proposes amount, milestone, and deadline; the deposit
   is priced by their passport tier.
2. **Fund** — the buyer locks the deposit (optionally bridging USDC in first, or
   the seller draws early payment from the financing pool).
3. **Deliver & attest** — the seller submits the delivery document; the Trade
   Officer or a drawn verifier panel checks it and attests on chain.
4. **Settle** — after the challenge window, escrow releases to the seller and
   both passports update. Disputes route to an arbitrator.

## Key features

- **Bonds** — USDC escrow (ERC-8183) between buyer and seller; releases on
  attested delivery.
- **Credit passport** — settled bonds write to a portable ERC-8004 identity;
  history tiers the required deposit (100% → 40% floor).
- **Verified delivery** — automated Trade Officer or a stake-weighted verifier
  panel, with a buyer challenge window.
- **Financing pool** — an LP vault that advances sellers against funded escrow
  and earns fees, plus idle-reserve USYC yield.
- **Cross-chain in** — bring USDC to Arc from supported testnets via Circle's
  Cross-Chain Transfer Protocol (CCTP).
- **Passwordless sign-in** — email + passkey backed by a Circle smart account, or
  connect your own wallet; the backend never holds your keys or a password.

Escrow, passports, and the financing pool are on-chain smart contracts on Arc
(Circle's USDC L1) — fully auditable, with USDC as the only unit of account.

## Try it

| | |
| --- | --- |
| App | [app.bezant.trade](https://app.bezant.trade) |
| Testnet USDC faucet | [faucet.circle.com](https://faucet.circle.com/) |
| Arc Testnet explorer | [testnet.arcscan.app](https://testnet.arcscan.app/) |
| Arc docs | [docs.arc.network](https://docs.arc.network/) |

Get testnet USDC from the faucet, open the app, sign in with an email + passkey,
and strike your first bond.

## Status

Testnet only. Deployed on Arc Testnet; USDC by Circle. **Not audited — do not use
with real funds.**

## License

MIT (unless noted otherwise per package).
