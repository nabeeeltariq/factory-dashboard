import {defineConfig} from 'vite';
import { resolve } from 'path';

export default defineConfig(() => {
  return {
    server: {
      hmr: process.env.DISABLE_HMR !== 'true',
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
    build: {
      rollupOptions: {
        input: {
          main: resolve(__dirname, 'index.html'),
          history: resolve(__dirname, 'history.html'),
        },
      },
    },
  };
});
