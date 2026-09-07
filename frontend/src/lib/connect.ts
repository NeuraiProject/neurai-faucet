/**
 * The browser half of "Connect with NeuraiWallet".
 *
 * The site never sees a private key and never picks what is signed: the backend
 * owns the login transaction (domain, nonce, chain, expiry) and hands back an
 * `authPayload` that is passed through unchanged, so what the QR code asks for
 * is exactly what will be verified. What comes back is a CACAO the backend
 * turns into a short-lived claim ticket.
 */

import { NeuraiConnect, RpcError, NeuraiRpcError } from '@neuraiproject/neurai-connect';
import { BrowserStorage, type AuthPayload } from '@neuraiproject/neurai-connect-core';

export interface ConnectResult {
  address: string;
  ticket: string;
  expiresInSeconds: number;
}

export interface ConnectHandles {
  /** The pairing URI to paint as a QR code, its deep link, and when it lapses. */
  onPairing: (pairing: { uri: string; deepLink: string; expiresAt: number }) => void;
  /** Progress, for the line under the QR code. */
  onStatus?: (status: 'pairing' | 'waiting' | 'verifying') => void;
  signal?: AbortSignal;
}

interface BeginResponse {
  loginId: string;
  nonce: string;
  authPayload: AuthPayload;
}

let clientPromise: Promise<NeuraiConnect> | undefined;

/** One client per page: it holds the relay socket and the pairing storage. */
function getClient(relayUrl: string): Promise<NeuraiConnect> {
  clientPromise ??= NeuraiConnect.init({
    relayUrl,
    storage: new BrowserStorage(),
    metadata: {
      name: 'Neurai Faucet',
      url: window.location.origin,
      icons: [`${window.location.origin}/logo.png`]
    }
  });
  return clientPromise;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin', // the pre-session cookie the login is bound to
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = (data as any)?.error;
    throw new Error(typeof error === 'string' ? error : error?.message || `${path} failed (${res.status})`);
  }
  return data as T;
}

/** True when the user (or the wallet) refused, rather than something breaking. */
export function isUserRejection(error: unknown): boolean {
  return error instanceof RpcError && error.code === NeuraiRpcError.USER_REJECTED;
}

export async function connectWallet(relayUrl: string, handles: ConnectHandles): Promise<ConnectResult> {
  const nc = await getClient(relayUrl);

  handles.onStatus?.('pairing');
  // The pairing exists before the backend transaction: its topic is the
  // requestId that binds the signature to this QR code and no other.
  const { pairing } = await nc.createPairing({ methods: ['wc_sessionAuthenticate'] });
  const begun = await post<BeginResponse>('/api/connect/begin', { requestId: pairing.topic });

  const { uri, deepLink, response } = await nc.authenticate({
    pairing,
    authPayload: begun.authPayload,
    signal: handles.signal
  });

  handles.onPairing({
    uri,
    deepLink,
    expiresAt: Date.parse(begun.authPayload.exp ?? '') || pairing.expiry * 1000
  });
  handles.onStatus?.('waiting');

  const { cacaos } = await response;
  handles.onStatus?.('verifying');

  return post<ConnectResult>('/api/connect/complete', { loginId: begun.loginId, cacao: cacaos[0] });
}
