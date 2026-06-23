import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: 'index.html',
        confirm: 'confirm.html',
        privacy: 'privacy-policy.html',
      }
    }
  }
})