import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  base: '/assets/', // 资源路径前缀，使 index.html 可放根目录，JS/CSS 放 assets/
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

