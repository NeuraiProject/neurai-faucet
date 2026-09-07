/**
 * Forwarding of the Neurai Connect endpoints to the internal backend.
 *
 * Unlike `/api/claim`, these two carry a cookie in both directions: the login
 * transaction is bound to a pre-session cookie the backend mints and later
 * destroys, so `Cookie` has to travel in and every `Set-Cookie` has to travel
 * back out. Nothing else from the browser's headers is passed on.
 */

const backendUrl = () => process.env.PUBLIC_BACKEND_URL || 'http://backend:3000/api';

export async function proxyToBackend(path: string, request: Request, clientAddress: string | undefined): Promise<Response> {
  try {
    const body = await request.text();

    const forward = new Headers({
      'Content-Type': 'application/json',
      // Resolved by the Node adapter from the socket or a trusted
      // x-forwarded-for; the backend is not internet-facing, so it can rely on it.
      'X-Faucet-Client-IP': clientAddress ?? 'unknown'
    });
    const cookie = request.headers.get('cookie');
    if (cookie) forward.set('Cookie', cookie);

    const response = await fetch(`${backendUrl()}${path}`, { method: 'POST', headers: forward, body });

    const headers = new Headers({ 'Content-Type': 'application/json' });
    for (const setCookie of response.headers.getSetCookie()) headers.append('Set-Cookie', setCookie);

    return new Response(await response.text(), { status: response.status, headers });
  } catch (error: any) {
    console.error(`Proxy error (${path}):`, error);
    return new Response(
      JSON.stringify({ error: { code: 'backend_unreachable', message: 'The faucet backend is currently unreachable.' } }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
