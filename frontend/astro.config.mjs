import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import { loadEnv } from 'vite';

const env = loadEnv(process.env.NODE_ENV || 'production', process.cwd() + '/..', '');
const allowedHost = env.ALLOWED_HOST;

// https://astro.build/config
export default defineConfig({
  output: 'server',
  adapter: node({
    mode: 'standalone'
  }),
  server: {
    port: 4321,
    host: true
  },
  vite: {
    server: {
      allowedHosts: allowedHost ? [allowedHost] : 'all'
    }
  }
});
