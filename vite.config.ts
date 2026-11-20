import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base relative : fonctionne sur GitHub Pages (https://<user>.github.io/<repo>/) sans configuration.
export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    // sorties des tests Playwright : leur réécriture verrouille les fichiers sous Windows (EBUSY) et fait planter le serveur
    watch: { ignored: ['**/playwright-report/**', '**/test-results/**', '**/backups/**'] },
  },
  build: {
    rollupOptions: {
      output: {
        // bibliothèques dans des fichiers séparés : mises en cache par le navigateur d'une version à l'autre
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          supabase: ['@supabase/supabase-js'],
          leaflet: ['leaflet'],
        },
      },
    },
  },
});