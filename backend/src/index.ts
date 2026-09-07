import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import {
  connectRedis,
  checkRateLimit,
  rollbackRateLimit,
  issueConnectTicket,
  peekConnectTicket,
  consumeConnectTicket
} from './redis';
import { sendFaucetFunds, getFaucetWallet, getFaucetBalance } from './faucet';
import { decodeAddress } from '@neuraiproject/neurai-create-transaction';
import { handleBegin, handleComplete, readPreSession } from '@neuraiproject/neurai-auth';
import { getConnect, connectInfo, PRE_SESSION_COOKIE } from './connect';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const NETWORK = (process.env.NETWORK || 'testnet') as 'mainnet' | 'testnet';
const ALLOWED_DESTINATION_NETWORKS = NETWORK === 'mainnet'
  ? new Set(['xna', 'xna-pq'])
  : new Set(['xna-test', 'xna-pq-test']);

// ── Security middleware ──────────────────────────────────────────
app.use(cors({ origin: false }));
app.use(express.json({ limit: '10kb' }));

// ── Global in-memory rate limiter (flood protection) ─────────────
// Limits each IP to MAX_CLAIMS_PER_WINDOW HTTP requests per WINDOW_MS,
// before any Redis or queue logic runs.
const WINDOW_MS = 60_000;
const MAX_CLAIMS_PER_WINDOW = 5;
const claimAttempts = new Map<string, { count: number; resetAt: number }>();

// `bucket` keeps the budgets of different endpoints apart: retrying a QR code a
// few times must not eat the allowance of the claim that follows it.
function globalRateLimit(ip: string, bucket = 'claim'): boolean {
  const key = `${bucket}:${ip}`;
  const now = Date.now();
  const entry = claimAttempts.get(key);
  if (!entry || now > entry.resetAt) {
    claimAttempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }
  entry.count++;
  return entry.count > MAX_CLAIMS_PER_WINDOW;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, val] of claimAttempts) {
    if (now > val.resetAt) claimAttempts.delete(key);
  }
}, WINDOW_MS * 2);

// The frontend resolves the real client address and forwards it as a trusted
// internal header; this backend is not internet-facing, so it cannot be forged
// by an external client.
function clientIp(req: express.Request): string {
  return (req.headers['x-faucet-client-ip'] as string) || req.socket.remoteAddress || 'unknown';
}

// ── Serial claim queue ───────────────────────────────────────────
// All actual fund-sending is processed one at a time to avoid UTXO conflicts.
// Validation and rate-limit checks happen BEFORE entering the queue so that
// invalid/duplicate requests are rejected immediately without queuing.

const MAX_QUEUE_SIZE = Number(process.env.MAX_QUEUE_SIZE || 50);

type QueueJob = {
  address: string;
  ip: string;
  resolve: (result: { txid: string }) => void;
  reject:  (err: Error) => void;
};

const queue: QueueJob[] = [];
let processing = false;

function enqueue(job: QueueJob): number {
  queue.push(job);
  processQueue();
  return queue.length; // position for logging
}

async function processQueue() {
  if (processing || queue.length === 0) return;
  processing = true;
  while (queue.length > 0) {
    const job = queue.shift()!;
    try {
      const txid = await sendFaucetFunds(job.address);
      job.resolve({ txid });
    } catch (err: any) {
      // Roll back the rate-limit lock so the user can try again
      await rollbackRateLimit(job.ip, job.address).catch(() => {});
      const errMsg = err instanceof Error ? err.stack : JSON.stringify(err, null, 2);
      console.error('sendFaucetFunds raw error:', errMsg);
      job.reject(err instanceof Error ? err : new Error(errMsg ?? String(err)));
    }
  }
  processing = false;
}

// ── Health check ─────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', queueLength: queue.length });
});

// ── Faucet Info ───────────────────────────────────────────────────
app.get('/api/info', async (req, res) => {
  try {
    const wallet = getFaucetWallet();
    const balance = await getFaucetBalance();
    const siteKey = process.env.PUBLIC_TURNSTILE_SITE_KEY;
    const turnstileEnabled = !!(siteKey && siteKey !== '' && siteKey !== '1x00000000000000000000AA');
    res.json({
      address: wallet.address,
      balance: balance,
      amount: Number(process.env.FAUCET_AMOUNT || 100),
      network: process.env.NETWORK,
      waitHours: Number(process.env.WAIT_TIME_HOURS || 24),
      turnstile: turnstileEnabled ? siteKey : null,
      connect: connectInfo(),
      queueLength: queue.length
    });
  } catch (error: any) {
    console.error('API Info Error:', error);
    res.status(500).json({ error: 'Service temporarily unavailable.' });
  }
});

// ── Turnstile validation ──────────────────────────────────────────
async function validateTurnstile(token: string): Promise<boolean> {
  const secretKey = process.env.TURNSTILE_SECRET_KEY;
  if (!secretKey) return true;

  const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: secretKey, response: token })
  });

  const data: any = await response.json();
  return data.success === true;
}

// ── Neurai Connect ────────────────────────────────────────────────
// Two endpoints and nothing else: the browser opens a login transaction, shows
// the QR, and comes back with the CACAO the wallet signed. On success the claim
// ticket is the only thing that leaves this file — the CACAO itself is verified
// here and never travels further.

const CONNECT_TICKET_TTL_SECONDS = Number(process.env.CONNECT_TICKET_TTL_SECONDS || 300);

app.post('/api/connect/begin', async (req, res) => {
  const connect = getConnect();
  if (!connect) return res.status(404).json({ error: 'Neurai Connect is not enabled on this faucet.' });

  const ip = clientIp(req);
  if (globalRateLimit(ip, 'connect')) {
    return res.status(429).json({ error: 'Too many requests. Please slow down.' });
  }

  try {
    const outcome = await handleBegin(connect.auth, connect.routeOptions, {
      preSessionId: readPreSession(PRE_SESSION_COOKIE, undefined, req.headers.cookie),
      // The faucet owns the statement and the policy: it needs a spendable wallet
      // address, not a per-domain identity, because that is where the funds go.
      body: { requestId: req.body?.requestId, addressPolicy: 'wallet', statement: connect.statement }
    });

    if (outcome.setCookie) res.setHeader('Set-Cookie', outcome.setCookie);
    return res.status(outcome.status).json(outcome.body);
  } catch (error) {
    console.error('[connect] begin failed:', error);
    return res.status(500).json({ error: { code: 'internal_error', message: 'Could not open the connection. Please try again.' } });
  }
});

app.post('/api/connect/complete', async (req, res) => {
  const connect = getConnect();
  if (!connect) return res.status(404).json({ error: 'Neurai Connect is not enabled on this faucet.' });

  const ip = clientIp(req);
  if (globalRateLimit(ip, 'connect')) {
    return res.status(429).json({ error: 'Too many requests. Please slow down.' });
  }

  try {
    // Consumes the transaction and checks nonce, domain, aud, requestId, chain,
    // window and signature against what this backend stored at `begin`.
    const outcome = await handleComplete(connect.auth, connect.routeOptions, {
      preSessionId: readPreSession(PRE_SESSION_COOKIE, undefined, req.headers.cookie),
      body: req.body
    });

    if (outcome.setCookie) res.setHeader('Set-Cookie', outcome.setCookie);
    if (!outcome.login) return res.status(outcome.status).json(outcome.body);

    // The signature is valid, but the chain of `iss` is not by itself a promise
    // that the faucet can pay this address: check the encoding it will send to.
    const { address } = outcome.login;
    try {
      const destination = decodeAddress(address);
      if (!ALLOWED_DESTINATION_NETWORKS.has(destination.network)) {
        return res.status(400).json({
          error: { code: 'address_network_mismatch', message: `The wallet signed with a ${destination.network} address. This faucet is running on ${NETWORK}.` }
        });
      }
    } catch {
      return res.status(400).json({ error: { code: 'invalid_address', message: 'The wallet signed with an address this faucet cannot pay.' } });
    }

    const ticket = await issueConnectTicket(address, CONNECT_TICKET_TTL_SECONDS);
    console.log(`[connect] verified ${address} (IP ${ip})`);
    return res.status(200).json({
      address,
      chainId: outcome.login.chainId,
      ticket,
      expiresInSeconds: CONNECT_TICKET_TTL_SECONDS
    });
  } catch (error) {
    console.error('[connect] complete failed:', error);
    return res.status(500).json({ error: { code: 'internal_error', message: 'Could not verify the wallet. Please try again.' } });
  }
});

// ── Faucet Claim Endpoint ─────────────────────────────────────────
app.post('/api/claim', async (req, res) => {
  const { address, captchaToken, connectTicket } = req.body;
  const ip = clientIp(req);
  const waitHours = Number(process.env.WAIT_TIME_HOURS || 24);

  // ── Gate 1: basic input validation ──
  if (!address || typeof address !== 'string') {
    return res.status(400).json({ error: 'Address is required' });
  }

  // ── Gate 2: flood protection ──
  if (globalRateLimit(ip)) {
    return res.status(429).json({ error: 'Too many requests. Please slow down.' });
  }

  // ── Gate 3: queue capacity ──
  if (queue.length >= MAX_QUEUE_SIZE) {
    return res.status(503).json({ error: 'Faucet is busy. Please try again in a moment.' });
  }

  try {
    // ── Gate 4: address format ──
    try {
      const destination = decodeAddress(address);
      if (!ALLOWED_DESTINATION_NETWORKS.has(destination.network)) {
        return res.status(400).json({
          error: `Address network mismatch. This faucet is running on ${NETWORK}.`
        });
      }
    } catch {
      return res.status(400).json({ error: 'Invalid Neurai address' });
    }

    // ── Gate 5: captcha, unless a Neurai Connect login already proved the address ──
    // A wallet signature over this faucet's own nonce says more than a captcha
    // does: it proves the destination key is controlled by whoever is asking.
    // The ticket is only spent once every later gate has passed, so a claim
    // rejected for being too early does not cost the user another scan.
    const connectEnabled = getConnect() !== null;
    const connectAddress = connectEnabled ? await peekConnectTicket(connectTicket) : null;
    const connectVerified = connectAddress !== null && connectAddress === address;

    if (connectEnabled && !connectVerified && typeof connectTicket === 'string' && connectTicket !== '') {
      // Saying "captcha required" here would send the user looking for a
      // challenge that is not on screen: a spent or lapsed ticket needs a new scan.
      return res.status(400).json({ error: 'This wallet connection has expired or was already used. Please connect again.' });
    }

    if (!connectVerified) {
      const secretKey = process.env.TURNSTILE_SECRET_KEY;
      if (secretKey && secretKey !== '' && secretKey !== '1x0000000000000000000000000000000AA') {
        if (!captchaToken) {
          return res.status(400).json({ error: 'Captcha token is required' });
        }
        if (!(await validateTurnstile(captchaToken))) {
          return res.status(400).json({ error: 'Invalid captcha' });
        }
      }
    }

    // ── Gate 6: minimum balance ──
    const balance = await getFaucetBalance();
    const amount = Number(process.env.FAUCET_AMOUNT || 100);
    if (balance < amount) {
      return res.status(503).json({ error: 'Faucet is empty. Please try again later.' });
    }

    // ── Gate 7: per-IP / per-address rate limit (atomic, Redis) ──
    const limitCheck = await checkRateLimit(ip, address, waitHours);
    if (limitCheck.limited) {
      return res.status(429).json({ error: limitCheck.message });
    }

    // Every gate passed: spend the Connect ticket so it cannot pay twice.
    if (connectVerified) {
      const spent = await consumeConnectTicket(connectTicket);
      if (spent !== address) {
        await rollbackRateLimit(ip, address).catch(() => {});
        return res.status(400).json({ error: 'This wallet connection was already used. Please connect again.' });
      }
    }

    // ── All gates passed: enqueue the send ──
    const position = enqueue({
      address,
      ip,
      resolve: ({ txid }) => {
        res.json({ success: true, message: 'Funds sent successfully!', txid });
      },
      reject: (err) => {
        console.error('Queue job error:', err instanceof Error ? err.stack : JSON.stringify(err));
        res.status(500).json({ error: 'An internal error occurred. Please try again later.' });
      }
    });

    console.log(`[Queue] Enqueued ${address} (IP ${ip}), position ${position}`);

  } catch (error: any) {
    console.error('Faucet Error:', error);
    res.status(500).json({ error: 'An internal error occurred. Please try again later.' });
  }
});

const start = async () => {
  try {
    await connectRedis();
    app.listen(PORT, () => {
      console.log(`Backend running on port ${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
};

start();
