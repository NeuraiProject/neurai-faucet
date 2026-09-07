import * as redis from 'redis';
import { randomBytes } from 'crypto';
import dotenv from 'dotenv';
dotenv.config();

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

const client = redis.createClient({
  url: REDIS_URL
});

client.on('error', (err) => console.log('Redis Client Error', err));

export const connectRedis = async () => {
  if (!client.isOpen) {
    await client.connect();
    console.log('Connected to Redis');
  }
};

function formatTTL(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.ceil((seconds % 3600) / 60);
  if (h > 0 && m > 0) return `${h} hour${h !== 1 ? 's' : ''} and ${m} minute${m !== 1 ? 's' : ''}`;
  if (h > 0) return `${h} hour${h !== 1 ? 's' : ''}`;
  return `${m} minute${m !== 1 ? 's' : ''}`;
}

export const checkRateLimit = async (ip: string, address: string, waitHours: number): Promise<{ limited: boolean; message: string }> => {
  // If wait time is 0, rate limiting is disabled
  if (waitHours === 0) {
    return { limited: false, message: 'Rate limiting disabled' };
  }

  const waitSeconds = waitHours * 3600;
  const ipKey      = `faucet:ip:${ip}`;
  const addressKey = `faucet:address:${address}`;

  // Atomic check-and-set via SET NX EX — eliminates TOCTOU race condition.
  // SET returns null if the key already existed (limited), or "OK" if newly set.
  const [ipSet, addrSet] = await Promise.all([
    client.set(ipKey,      '1', { NX: true, EX: waitSeconds }),
    client.set(addressKey, '1', { NX: true, EX: waitSeconds }),
  ]);

  // If the address was already locked, also clean up the IP key we just set
  if (addrSet === null) {
    if (ipSet !== null) await client.del(ipKey); // rollback ip key
    const ttl = await client.ttl(addressKey);
    const wait = ttl > 0 ? formatTTL(ttl) : 'some time';
    return { limited: true, message: `This address has already received funds. Please wait ${wait} before requesting again.` };
  }

  // If the IP was already locked, clean up the address key we just set
  if (ipSet === null) {
    await client.del(addressKey); // rollback address key
    const ttl = await client.ttl(ipKey);
    const wait = ttl > 0 ? formatTTL(ttl) : 'some time';
    return { limited: true, message: `This IP has already requested funds. Please wait ${wait} before requesting again.` };
  }

  return { limited: false, message: 'Rate limit passed' };
};

/**
 * Rolls back rate-limit keys if the queued send failed,
 * so the user is not penalised for a backend error.
 */
export const rollbackRateLimit = async (ip: string, address: string): Promise<void> => {
  await Promise.all([
    client.del(`faucet:ip:${ip}`),
    client.del(`faucet:address:${address}`)
  ]);
};

// ── Neurai Connect ────────────────────────────────────────────────

/**
 * The `MinimalRedisClient` shape `@neuraiproject/neurai-auth` expects, over the
 * same connection. `eval` is what makes a login transaction single-use across
 * processes: the package refuses a client that offers neither `eval` nor
 * `getdel` rather than silently downgrading to a racy GET + DEL.
 */
export const redisAuthClient = {
  set: (key: string, value: string, opts?: { px?: number }) =>
    opts?.px ? client.set(key, value, { PX: opts.px }) : client.set(key, value),
  get: (key: string) => client.get(key),
  del: (key: string) => client.del(key),
  eval: (script: string, keys: string[], args: string[]) =>
    client.eval(script, { keys, arguments: args }) as Promise<unknown>
};

const TICKET_PREFIX = 'faucet:connect:ticket:';
const isTicket = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

/**
 * Issues the claim ticket handed to the browser once a Connect login verified.
 * It is the only thing that exempts a claim from the captcha, so it is opaque,
 * short-lived and bound to the address that actually signed.
 */
export const issueConnectTicket = async (address: string, ttlSeconds: number): Promise<string> => {
  const ticket = randomBytes(32).toString('hex');
  await client.set(`${TICKET_PREFIX}${ticket}`, address, { EX: ttlSeconds });
  return ticket;
};

/** The address a ticket was issued for, without spending it. */
export const peekConnectTicket = async (ticket: unknown): Promise<string | null> => {
  if (!isTicket(ticket)) return null;
  return client.get(`${TICKET_PREFIX}${ticket}`);
};

/** Spends a ticket. Atomic, so two concurrent claims cannot both use the same one. */
export const consumeConnectTicket = async (ticket: unknown): Promise<string | null> => {
  if (!isTicket(ticket)) return null;
  return client.getDel(`${TICKET_PREFIX}${ticket}`);
};

export default client;
