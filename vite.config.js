import { defineConfig } from 'vite'

export default defineConfig({
  appType: 'mpa',
  build: {
    rollupOptions: {
      input: {
        // --- existing landing site (unchanged) ---
        main: 'index.html',
        confirm: 'confirm.html',
        privacy: 'privacy-policy.html',
        tos: 'tos.html',
        // --- authenticated app ---
        login: 'app/login.html',
        verify: 'app/verify.html',
        dashboard: 'app/dashboard.html',
        analytics: 'app/analytics.html',
        child: 'app/child.html',
        study: 'app/study.html',
        addChild: 'app/add-child.html',
      }
    }
  }
})