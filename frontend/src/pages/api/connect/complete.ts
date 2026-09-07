import type { APIRoute } from 'astro';
import { proxyToBackend } from '../../../lib/proxy';

export const POST: APIRoute = ({ request, clientAddress }) =>
  proxyToBackend('/connect/complete', request, clientAddress);
