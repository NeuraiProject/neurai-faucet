import type { APIRoute } from 'astro';

export const POST: APIRoute = async ({ request, clientAddress }) => {
  try {
    const body = await request.json();
    
    // Internal Docker URL for the backend
    const internalBackendUrl = process.env.PUBLIC_BACKEND_URL || 'http://backend:3000/api';

    // Use Astro's clientAddress (resolved by the Node adapter from socket or
    // trusted x-forwarded-for if behind a reverse proxy) and forward it as a
    // trusted internal header. The backend is not internet-facing so this
    // header cannot be injected by external clients.
    const forward = new Headers({
      'Content-Type': 'application/json',
      'X-Faucet-Client-IP': clientAddress ?? 'unknown',
    });
    
    // Forward the request to the internal backend
    const response = await fetch(`${internalBackendUrl}/claim`, {
      method: 'POST',
      headers: forward,
      body: JSON.stringify(body),
    });

    const data = await response.json();
    
    return new Response(JSON.stringify(data), {
      status: response.status,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: any) {
    console.error('Proxy error:', error);
    return new Response(JSON.stringify({ 
      error: 'The faucet backend is currently unreachable. Please try again later.' 
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
