import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  // VITE_* values ship to every visitor. Presenter credentials are dev-only.
  if (command === 'build' && (env.VITE_ADMIN_TOKEN || process.env.VITE_ADMIN_TOKEN)) {
    throw new Error('Remove VITE_ADMIN_TOKEN before building. Admin controls are local development only.');
  }
  return {
    plugins: [react(), tailwindcss()],
    resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
    server: { port: 5173, strictPort: true },
    build: { target: 'es2022' },
  };
});
