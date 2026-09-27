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
   - `RPC_GENESIS_HASH`: (Optional) Only to run against a regtest node: the genesis block the RPC node must serve. By default it is the one of `NETWORK`.
   - `FAUCET_AMOUNT`: Amount of XNA to send per request.
   - `WAIT_TIME_HOURS`: Hours a user must wait before requesting again (`0` disables rate limiting).
   - `MAX_QUEUE_SIZE`: Maximum concurrent claims queued before returning 503 (default: `50`).
   - `MNEMONIC`: The 12-word mnemonic of the wallet that holds the faucet funds.
   - `FAUCET_WALLET_TYPE`: `legacy` (default), `authscript`, `pq` or `ecdsa` — the address type of the faucet funding wallet (see [Address support](#address-support)).
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
- **Which address gets paid.** Whatever address the user approves in the wallet. The faucet asks for a spendable wallet address (`addressPolicy: "wallet"`) and runs the same address checks as a manual claim before paying.
- **Address types.** A login can come from any of the four address types (`neurai-auth` 0.0.2). The wallet signs each one as the node's `signmessage` does, and for PQ v2 and ECDSA v3 the signature is bound to the address. The retired `nq1p…` / `tnq1p…` encoding is rejected.
- **Chain identifier.** The testnet reset of 2026-09-26 changed the testnet CAIP-2 identifier to `bip122:0000008b384aeffecdab182575dc4e86`. The wallet must use `neurai-connect-core` 0.0.2 or later too, otherwise its testnet logins fail with `unsupported_chain`.
- Requires a NeuraiWallet build with Neurai Connect, and `PUBLIC_SITE_URL` must match the origin the browser actually loads, otherwise every login fails the domain check.

## Address support

The faucet uses the address types of `@neuraiproject/neurai-key` 5:

| Type | Mainnet | Testnet | What it is |
|---|---|---|---|
| `legacy` | `N…` | `t…` | Base58 P2PKH |
| `authscript` | `nc1p…` | `tnc1p…` | AuthScript witness v1 with a post-quantum key |
| `pq` | `pq1z…` | `tpq1z…` | Strict post-quantum witness v2 |
| `ecdsa` | `nq1r…` | `tnq1r…` | Strict ECDSA witness v3 |

- **Only active types.** Before a type activates, its outputs can be spent by anyone. The faucet pays only to the types active on its network: all four on testnet, and only `legacy` on mainnet. It also refuses a funding wallet (`FAUCET_WALLET_TYPE`) of an inactive type.
- **The node has the last word.** A recipient must also pass the node's `validateaddress`. The node refuses the v2/v3 types until they are active, so an RPC node that does not run those rules yet cannot receive a payment to them.
- **The right chain.** Before its first RPC call the backend checks that the node's genesis block is the one of `NETWORK` (the reset testnet on testnet). Legacy addresses look the same on the old and the reset testnet, so an RPC URL left on the old chain would otherwise pay claims there without any error. With a mismatch the balance shows as unavailable and claims fail, and the log names both hashes. Set `RPC_GENESIS_HASH` only to run the faucet against a regtest node.
- **Wrong chain.** Addresses from the other network are rejected. So is the old `nq1p…` / `tnq1p…` AuthScript encoding: the node no longer accepts it.
- **Fees.** The fee is computed on the signed size of the transaction, at 2000 sat/vB. A post-quantum input weighs about 977 vB, against 148 for a Legacy one. Change below the node's dust threshold (546 sats for Legacy, 3060 for post-quantum) goes to the fee.
- **Upgrading.** `legacy` keeps the same address and funds as earlier faucet versions. `pq` used to mean the AuthScript v1 wallet (`tnq1p…`). That type is now `authscript`, and neurai-key 5 derives a different key for it, so it needs new funds.

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
