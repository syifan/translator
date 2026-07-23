import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const shared = resolve(__dirname, 'src/shared')
const alias = { '@shared': shared }
const rendererAlias = { ...alias, '@': resolve(__dirname, 'src/renderer/src') }

export default defineConfig({
  main: {
    resolve: { alias },
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') },
      },
    },
  },
  preload: {
    resolve: { alias },
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          control: resolve(__dirname, 'src/preload/control.ts'),
          overlay: resolve(__dirname, 'src/preload/overlay.ts'),
        },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: { alias: rendererAlias },
    server: { fs: { allow: [resolve(__dirname)] } },
    plugins: [react(), tailwindcss()],
    build: {
      rollupOptions: {
        input: {
          control: resolve(__dirname, 'src/renderer/control.html'),
          overlay: resolve(__dirname, 'src/renderer/overlay.html'),
        },
      },
    },
  },
})
