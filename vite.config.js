import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: 'index.html',
        confirm: 'confirm.html',
        privacy: 'privacy-policy.html',
        blogIndex: 'blog/index.html',
        blogMyBrotherSaysHeStudied: 'blog/my-brother-says-he-studied.html',
      }
    }
  }
})