import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

export default defineConfig({
  plugins: [svelte()],
  base: './',
  // site/data is a live bind mount of ../fleet: never wipe site/ on build.
  build: { outDir: '../site', emptyOutDir: false },
})
