# Neurai Faucet

A beautiful and lightweight faucet for Neurai (XNA) Testnet or Mainnet. Built with Astro, Node.js, and Redis.

## Features

- **Multi-network**: Supports both Mainnet and Testnet.
- **Modern UI**: Clean, responsive, light-purple design built with Astro.
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
   - `NETWORK`: `testnet` or `mainnet` — selects which RPC URL to use.
   - `RPC_URL_TESTNET`: Neurai Testnet RPC endpoint.
   - `RPC_URL_MAINNET`: Neurai Mainnet RPC endpoint.
   - `FAUCET_AMOUNT`: Amount of XNA to send per request.
   - `WAIT_TIME_HOURS`: Hours a user must wait before requesting again (`0` disables rate limiting).
   - `MAX_QUEUE_SIZE`: Maximum concurrent claims queued before returning 503 (default: `50`).
   - `MNEMONIC`: The 12-word mnemonic of the wallet that holds the faucet funds.
   - `FRONTEND_PORT`: External port to expose the faucet (default: `80`).
   - `PUBLIC_TURNSTILE_SITE_KEY`: (Optional) Cloudflare Turnstile Site Key.
   - `TURNSTILE_SECRET_KEY`: (Optional) Cloudflare Turnstile Secret Key.

3. **Deploy with Docker Compose**:
   ```bash
   docker compose up -d
   ```

## NGIX Configuration
   ```
location / {
    proxy_pass         http://%ip%:54321;
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
