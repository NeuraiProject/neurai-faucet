import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs'],
  clean: true,
  // @neuraiproject/neurai-auth ships ESM only, which a CommonJS build cannot
  // `require()` on Node 20. Bundling it in keeps the rest of the backend — and
  // its Dockerfile — exactly as it was.
  noExternal: [/^@neuraiproject\/neurai-auth/]
});
