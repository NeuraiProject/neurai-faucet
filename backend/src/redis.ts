import * as redis from 'redis';
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

export default client;
