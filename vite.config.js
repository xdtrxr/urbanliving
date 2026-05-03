import base44 from "@base44/vite-plugin"
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    base44({
      // Support for legacy code that imports the base44 SDK with @/integrations, @/entities, etc.
      // can be removed if the code has been updated to use the new SDK imports from @base44/sdk
      legacySDKImports: process.env.BASE44_LEGACY_SDK_IMPORTS === 'true'
    }),
    react(),
  ],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          if (id.includes('framer-motion')) return 'framer-motion';
          if (id.includes('lucide-react')) return 'lucide-react';
          if (id.includes('react-markdown') || id.includes('remark') || id.includes('micromark') || id.includes('mdast')) return 'react-markdown';
          if (id.includes('@base44/sdk')) return 'base44-sdk';
          if (id.includes('@radix-ui')) return 'radix-ui';
          if (id.includes('@tanstack')) return 'tanstack';
          if (id.includes('react-router')) return 'react-router';
          if (id.includes('date-fns') || id.includes('moment')) return 'date-libs';
          if (id.includes('react-dom') || id.match(/[\\/]react[\\/]/)) return 'react-vendor';
        },
      },
    },
  },
});