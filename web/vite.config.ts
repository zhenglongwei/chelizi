import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  // 注意：base 必须与 build.assetsDir 的产物结构一致。
  // 当前 assetsDir 为空字符串（产物输出到 dist 根目录），所以 base 应为 '/'，避免运行时去 /assets/ 下找文件导致白屏。
  base: '/',
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 3001, // 开发服务器端口（避免与API服务端口冲突）
    proxy: {
      '/api': {
        target: 'http://localhost:3000', // 开发环境代理到本地API服务
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, '/api'),
      },
    },
  },
  build: {
    outDir: 'dist',
    assetsDir: '', // 空字符串：JS/CSS 输出到 dist 根目录，避免部署到 assets 时出现 assets/assets
    sourcemap: false,
  },
});

