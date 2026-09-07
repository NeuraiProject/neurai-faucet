/**
 * Neurai Connect ("Sign in with Neurai") for the faucet.
 *
 * The visitor scans a QR code with NeuraiWallet and approves on the phone. The
 * wallet signs a CAIP-122 message with the very address that will receive the
 * funds, so the faucet ends up holding a cryptographic proof that whoever asked
 * controls the destination key. That is a stronger signal than a captcha —
 * solving a Turnstile challenge proves nothing about the address typed next to
 * it — which is why a claim backed by a Connect login skips Turnstile.
 *
 * Nothing here can be driven from the browser: the domain, the login URI, the
 * chain and the nonce are fixed on this side, the login transaction is bound to
 * the browser's pre-session cookie, and it is consumed exactly once.
 *
 * Disabled (and invisible to the frontend) unless PUBLIC_SITE_URL is set: the
 * domain a user signs must be configured, never guessed from a Host header.
 */

import {
  DEFAULT_PRE_SESSION_COOKIE,
  NeuraiAuth,
  RedisTransactionStore,
  type NeuraiAuthRoutesOptions,
} from '@neuraiproject/neurai-auth';
import { NEURAI_CHAIN_MAINNET, NEURAI_CHAIN_TESTNET } from '@neuraiproject/neurai-connect-core';
import dotenv from 'dotenv';
import { redisAuthClient } from './redis';

dotenv.config();

const NETWORK = (process.env.NETWORK || 'testnet') as 'mainnet' | 'testnet';
const SITE_URL = (process.env.PUBLIC_SITE_URL || '').trim();
const RELAY_URL = (process.env.CONNECT_RELAY_URL || 'wss://relay.neurai.org/v1').trim();
const LOGIN_TTL_SECONDS = Number(process.env.CONNECT_LOGIN_TTL_SECONDS || 600);

/** The CAIP-2 chain of this faucet. Constants, never derived at runtime. */
export const CONNECT_CHAIN_ID = NETWORK === 'mainnet' ? NEURAI_CHAIN_MAINNET : NEURAI_CHAIN_TESTNET;

export const PRE_SESSION_COOKIE = DEFAULT_PRE_SESSION_COOKIE;

type ConnectSetup = {
  auth: NeuraiAuth;
  routeOptions: NeuraiAuthRoutesOptions;
  relayUrl: string;
  chainId: string;
  domain: string;
  loginUri: string;
  statement: string;
};

let setup: ConnectSetup | null | undefined;

/**
 * The statement the wallet shows above the address chooser. It must not contain
 * a newline (the backend would reject it), and it has to say plainly what the
 * approval does: the funds land on whichever address the user approves.
 */
function buildStatement(): string {
  const amount = Number(process.env.FAUCET_AMOUNT || 100);
  const chain = NETWORK === 'mainnet' ? 'Mainnet' : 'Testnet';
  return `Receive ${amount} XNA from the Neurai ${chain} faucet at the address you approve. No transaction is signed.`;
}

/**
 * Builds the Connect setup once, or returns null when it is not configured.
 * A malformed PUBLIC_SITE_URL disables the feature loudly instead of starting
 * a faucet whose logins would fail one by one at verification time.
 */
function getSetup(): ConnectSetup | null {
  if (setup !== undefined) return setup;

  if (SITE_URL === '') {
    setup = null;
    return setup;
  }

  let site: URL;
  try {
    site = new URL(SITE_URL);
  } catch {
    console.error(`[connect] PUBLIC_SITE_URL is not a URL ("${SITE_URL}"). Neurai Connect stays disabled.`);
    setup = null;
    return setup;
  }

  const auth = new NeuraiAuth({
    // The domain and the login URI are the backend's, never the browser's.
    domain: site.host,
    uri: site.origin + site.pathname.replace(/\/$/, ''),
    chains: [CONNECT_CHAIN_ID],
    ttlSeconds: LOGIN_TTL_SECONDS,
    // Redis so the transaction survives a restart and works with more than one process.
    store: new RedisTransactionStore(redisAuthClient, { prefix: 'faucet:connect:tx:' }),
  });

  setup = {
    auth,
    routeOptions: {
      preSessionCookie: PRE_SESSION_COOKIE,
      cookieOptions: {
        httpOnly: true,
        sameSite: 'Lax',
        // Dropped on plain http so Connect still works on a local deployment.
        secure: site.protocol === 'https:',
        path: '/',
      },
      onError: (error) => console.error('[connect]', error),
    },
    relayUrl: RELAY_URL,
    chainId: CONNECT_CHAIN_ID,
    domain: site.host,
    loginUri: site.origin + site.pathname.replace(/\/$/, ''),
    statement: buildStatement(),
  };

  console.log(`[connect] enabled for ${setup.domain} on ${CONNECT_CHAIN_ID} via ${RELAY_URL}`);
  return setup;
}

/** The Connect setup, or null when PUBLIC_SITE_URL is not configured. */
export const getConnect = (): ConnectSetup | null => getSetup();

/** What `/api/info` publishes so the browser can build the same QR the backend will verify. */
export const connectInfo = (): { relayUrl: string; chainId: string } | null => {
  const connect = getSetup();
  return connect ? { relayUrl: connect.relayUrl, chainId: connect.chainId } : null;
};
