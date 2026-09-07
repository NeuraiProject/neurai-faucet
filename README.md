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
   - `FAUCET_AMOUNT`: Amount of XNA to send per request.
   - `WAIT_TIME_HOURS`: Hours a user must wait before requesting again (`0` disables rate limiting).
   - `MAX_QUEUE_SIZE`: Maximum concurrent claims queued before returning 503 (default: `50`).
   - `MNEMONIC`: The 12-word mnemonic of the wallet that holds the faucet funds.
   - `FAUCET_WALLET_TYPE`: `legacy` or `pq` — how to derive the faucet funding wallet from the mnemonic.
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

- Recipient addresses can now be either Legacy base58 (`N...` / `t...`) or the new PQ/AuthScript Bech32m (`nq1...` / `tnq1...`).
- The faucet rejects addresses from the wrong chain. Testnet only accepts `t...` and `tnq1...`; mainnet only accepts `N...` and `nq1...`.
- The funding wallet itself can also be configured as `legacy` or `pq` with `FAUCET_WALLET_TYPE`.

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

## License

Apache License 2.0. See `LICENSE` for details.
