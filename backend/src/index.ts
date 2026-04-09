import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { connectRedis, checkRateLimit, rollbackRateLimit } from './redis';
import { sendFaucetFunds, getFaucetWallet, getFaucetBalance } from './faucet';
import { decodeAddress } from '@neuraiproject/neurai-create-transaction';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// ── Security middleware ──────────────────────────────────────────
app.use(cors({ origin: false }));
app.use(express.json({ limit: '10kb' }));

// ── Global in-memory rate limiter (flood protection) ─────────────
// Limits each IP to MAX_CLAIMS_PER_WINDOW HTTP requests per WINDOW_MS,
// before any Redis or queue logic runs.
const WINDOW_MS = 60_000;
const MAX_CLAIMS_PER_WINDOW = 5;
const claimAttempts = new Map<string, { count: number; resetAt: number }>();

function globalRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = claimAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    claimAttempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
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

// ── Faucet Claim Endpoint ─────────────────────────────────────────
app.post('/api/claim', async (req, res) => {
  const { address, captchaToken } = req.body;
  const ip: string =
    (req.headers['x-faucet-client-ip'] as string) ||
    req.socket.remoteAddress ||
    'unknown';
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
      decodeAddress(address);
    } catch {
      return res.status(400).json({ error: 'Invalid Neurai address' });
    }

    // ── Gate 5: captcha ──
    const secretKey = process.env.TURNSTILE_SECRET_KEY;
    if (secretKey && secretKey !== '' && secretKey !== '1x0000000000000000000000000000000AA') {
      if (!captchaToken) {
        return res.status(400).json({ error: 'Captcha token is required' });
      }
      if (!(await validateTurnstile(captchaToken))) {
        return res.status(400).json({ error: 'Invalid captcha' });
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
