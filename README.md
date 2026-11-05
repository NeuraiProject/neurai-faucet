# Neurai Faucet

A beautiful and lightweight faucet for Neurai (XNA) Testnet or Mainnet. Built with Astro, Node.js, and Redis.

## Features

- **Multi-network**: Supports both Mainnet and Testnet.
- **Modern UI**: Clean, responsive, light-purple design built with Astro.
- **Neurai Connect**: claim by scanning a QR code with the NeuraiWallet mobile app — the wallet signs with the address that will receive the funds, so no captcha is needed and the XNA is sent as soon as the user approves.
- **Anti-Abuse**:
  - Rate limiting by IP and Address using Redis (with automatic expiration).
  - Optional Cloudflare Turnstile (Captcha) integration.
- **Lightweight**: Uses Redis for state, no heavy databases required.
- **Docker Ready**: Easy deployment with Docker Compose.

## Prerequisites

- Docker and Docker Compose.
- A Neurai RPC node address (Mainnet or Testnet).
- A 12-word mnemonic for your faucet wallet.

## Setup

1. **Clone the repository**:
   ```bash
   git clone <repo-url>
   cd neurai-faucet
   ```

2. **Configure environment variables**:
   Copy `.env.example` to `.env` and fill in your details.
   ```bash
   cp .env.example .env
   ```

   **Key settings in `.env`**:
   - `NETWORK`: `testnet` or `mainnet` — selects which RPC URL to use and which recipient address networks are accepted.
   - `RPC_URL_TESTNET`: Neurai Testnet RPC endpoint.
   - `RPC_URL_MAINNET`: Neurai Mainnet RPC endpoint.
   - `EXPECTED_GENESIS`: (Optional) Genesis hash the RPC node must have. Defaults to the mainnet or testnet genesis; the faucet refuses to read balances or pay through a node of another chain. Set it for regtest or a private network.
   - `FAUCET_AMOUNT`: Amount of XNA to send per request.
   - `WAIT_TIME_HOURS`: Hours a user must wait before requesting again (`0` disables rate limiting).
   - `MAX_QUEUE_SIZE`: Maximum concurrent claims queued before returning 503 (default: `50`).
   - `MNEMONIC`: The 12-word mnemonic of the wallet that holds the faucet funds.
   - `FAUCET_WALLET_TYPE`: `ecdsa` (default), `legacy` or `pq` — which address of the mnemonic holds the faucet funds (see [Address support](#address-support)). Only `ecdsa` can pay silent payment codes, and mainnet only allows `legacy` for now.
   - `FEE_RATE_SAT_PER_VBYTE`: (Optional) Fee rate in satoshis per virtual byte, default `2000` (the node relays from `1000`). The fee is computed on the signed size, so post-quantum inputs (about 1,000 vbytes each) are paid in full.
   - `COINBASE_MATURITY`: Confirmations a coin needs before the faucet spends it (default `10`). The node needs 100 on mainnet and 5 on testnet for coinbase coins.
   - `FRONTEND_PORT`: Port the faucet is published on (default: `54321`). Keep it outside the ephemeral range (`32768-60999`), or an outgoing connection may take it and the container will fail to start with `address already in use`.
   - `FRONTEND_BIND`: Interface to publish it on (default: `127.0.0.1`, reachable only through the reverse proxy). Use `0.0.0.0` to expose the faucet directly.
   - `PUBLIC_TURNSTILE_SITE_KEY`: (Optional) Cloudflare Turnstile Site Key.
   - `TURNSTILE_SECRET_KEY`: (Optional) Cloudflare Turnstile Secret Key.
   - `PUBLIC_SITE_URL`: (Optional) Public origin of the faucet, e.g. `https://faucet.neurai.org`. Enables Neurai Connect.
   - `CONNECT_RELAY_URL`: (Optional) Neurai Connect relay. Default `wss://relay.neurai.org/v1`.

## Neurai Connect

With `PUBLIC_SITE_URL` set, the claim card offers **Connect with NeuraiWallet**. The visitor scans a QR code with the mobile app and approves; the wallet signs a CAIP-122 message with the address that will receive the funds, and the faucet sends the XNA straight away.

```
browser ──1. begin (pre-session cookie)──▶ faucet backend      (nonce, domain, chain, 10-min window)
   │                                                            
   └──2. QR / deep link ──▶ relay ──▶ NeuraiWallet ──3. approve and sign──▶ relay ──▶ browser
                                                                            │
   ◀──5. claim ticket ── faucet backend ◀──4. complete (CACAO) ─────────────┘
```

- **Why it replaces the captcha.** A Turnstile challenge says something about the browser and nothing about the address typed next to it. A Connect login is a signature over this faucet's own nonce made by the key that owns the destination address, so it is a strictly stronger claim. The per-IP and per-address rate limits still apply exactly as before — Connect changes who is asking, not how often they may ask.
- **What is fixed on the server.** The domain, the login URI, the chain and the nonce come from `PUBLIC_SITE_URL` and the backend's own configuration, never from the browser. The login is bound to an `HttpOnly` pre-session cookie and consumed exactly once, so a CACAO obtained elsewhere cannot be submitted through someone else's browser.
- **What the relay sees.** Topics, sizes and timing. Everything between the site and the wallet is end-to-end encrypted, and no private key leaves the phone. Run your own relay with `CONNECT_RELAY_URL` if you prefer.
- **Which address gets paid.** Whatever address the user approves in the wallet. The faucet asks for a spendable wallet address (`addressPolicy: "wallet"`) and re-checks that its encoding belongs to the configured network before paying.
- Requires a NeuraiWallet build with Neurai Connect, and `PUBLIC_SITE_URL` must match the origin the browser actually loads, otherwise every login fails the domain check.

## Address support

On testnet the faucet pays:

| Destination | Example |
| --- | --- |
| Legacy (Base58 P2PKH) | `t…` |
| ECDSA (strict ECDSA witness v3) | `tnq1r…` |
| Post-quantum (strict PQ witness v2) | `tpq1z…` |
| Silent payment code (NIP-047), with an `ecdsa` funding wallet | `tnsp1…` |

- **Contract addresses are not paid.** Generic AuthScript v1 addresses (`nc1p…` / `tnc1p…`) are spent by a script, not by a wallet key, so the faucet refuses them. The old `nq1p…` / `tnq1p…` AuthScript encoding is refused as invalid.
- **Silent payments.** A payment code gets the XNA at a new one-time ECDSA address that only the code's owner can link to it; the claim response includes that address. NIP-047 needs every input of the transaction to be a strict ECDSA v3 output, so the faucet accepts codes only when `FAUCET_WALLET_TYPE=ecdsa`.
- **Mainnet** only accepts Legacy addresses (`N…`) and only funds from a `legacy` wallet: the strict PQ and ECDSA families and silent payments are not active on mainnet yet.
- Addresses and codes of another network are refused. Bech32m addresses and codes are case-insensitive and are rate-limited in lower case.
- `/api/info` lists the accepted destinations (`accepts`) and whether codes are paid (`silentPayments`); the page shows them under the address field.

### Testnet reset of 2026-11-05

The testnet restarted from a new genesis block (`000000c710413a4265a996d30c86043aedef6a563900f1bc43fea61d5b2dc77d`). `RPC_URL_TESTNET` must point to a node of the new chain with `-addressindex` (the faucet reads `getaddressutxos`, `getaddressmempool` and `getaddressbalance`), and the funding wallet must be funded again on it.

With neurai-key 5 the `pq` funding wallet is a strict PQ address (`tpq1z…`) instead of the old AuthScript `tnq1p…` one, and the new `ecdsa` wallet is the `tnq1r…` address of the mnemonic: check `/api/info` for the address to fund. Neurai Connect uses `@neuraiproject/neurai-connect-core` 0.0.2, the version NeuraiWallet uses.

3. **Deploy with Docker Compose**:
   ```bash
   docker compose up -d
   ```

## NGIX Configuration

With the default `FRONTEND_BIND=127.0.0.1`, the container is published on loopback only, so nginx runs on the host and is the sole way in. Point `proxy_pass` at the same port as `FRONTEND_PORT`.

   ```
location / {
    proxy_pass         http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header   Host              $host;
    proxy_set_header   X-Real-IP         $remote_addr;
    proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header   X-Forwarded-Proto $scheme;
    proxy_set_header   Upgrade           $http_upgrade;
    proxy_set_header   Connection        "upgrade";
}
   ```

## Architecture

- **Frontend**: Astro (SSR) on the port defined by `FRONTEND_PORT` (default: `80`), mapped to internal port `4321`.
- **Backend**: Node.js/TypeScript API on port `3000` (internal only, not exposed).
- **Database**: Redis for tracking IP/Address requests with TTL-based expiration.

## Troubleshooting wallet information

If the address or balance is unavailable, check the backend logs:

```bash
docker compose logs --tail=100 backend
```

`API Info Balance Error` identifies a failed balance query. The address and faucet
configuration still load, but the balance is `null` and `rpcOnline` is `false`;
the page shows an error and disables claims until a successful refresh. A failed
query is never displayed as a zero balance. `API Info Error` indicates that the
remaining faucet information could not be loaded (for example, wallet derivation
failed).

An RPC error with `status: 403` means the configured RPC endpoint rejected the
backend's request. Check the URL selected by `NETWORK` and test access from the
faucet server. For the default public testnet endpoint:

```bash
curl -i --max-time 15 -u user:pass \
  -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"getblockcount","params":[]}' \
  https://rpc-testnet.neurai.org/rpc
```


## License

Apache License 2.0. See `LICENSE` for details.
