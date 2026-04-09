import type { APIRoute } from 'astro';

export const GET: APIRoute = async () => {
  try {
    // Internal Docker URL for the backend
    const internalBackendUrl = process.env.PUBLIC_BACKEND_URL || 'http://backend:3000/api';
    
    // Forward the request to the internal backend
    const response = await fetch(`${internalBackendUrl}/info`);

    const data = await response.json();
    
    return new Response(JSON.stringify(data), {
      status: response.status,
      headers: {
        'Content-Type': 'application/json'
      }
    });

  } catch (error: any) {
    console.error('Proxy error (info):', error);
    return new Response(JSON.stringify({ 
      error: 'The faucet backend is currently unreachable.' 
    }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json'
      }
    });
  }
};
