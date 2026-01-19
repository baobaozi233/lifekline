import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  // Load env file based on `mode` in the current working directory.
  // Set the third parameter to '' to load all env regardless of the `VITE_` prefix.
  const env = loadEnv(mode, (process as any).cwd(), '');

  // Normalize and prioritize keys so frontend code (import.meta.env.VITE_*) can read them.
  // Priority: explicit VITE_OPENAI_KEY > generic API_KEY / OPENAI_API_KEY > VITE_API_KEY
  const apiKey =
    env.VITE_OPENAI_KEY ||
    env.API_KEY ||
    env.OPENAI_API_KEY ||
    env.VITE_API_KEY ||
    '';

  // Expose model/base (allow VITE_* prefixed overrides or fallbacks)
  const openaiModel = env.VITE_OPENAI_MODEL || env.OPENAI_MODEL || 'gpt-5';
  const openaiBase = env.VITE_OPENAI_BASE || env.OPENAI_BASE || 'https://api.openai.com/v1';

  return {
    plugins: [react()],
    base: './',
    build: {
      outDir: 'dist',
      assetsDir: 'assets',
      sourcemap: false,
    },
    define: {
      // Keep backward compatibility for any code using process.env.API_KEY
      'process.env.API_KEY': JSON.stringify(apiKey || ''),
      // Ensure import.meta.env.VITE_OPENAI_KEY / VITE_OPENAI_MODEL / VITE_OPENAI_BASE are defined at build time
      'import.meta.env.VITE_OPENAI_KEY': JSON.stringify(apiKey || ''),
      'import.meta.env.VITE_OPENAI_MODEL': JSON.stringify(openaiModel),
      'import.meta.env.VITE_OPENAI_BASE': JSON.stringify(openaiBase),
    }
  };
});
