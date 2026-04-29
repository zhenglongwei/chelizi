import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './index.css';

// Vite 的 base: '/assets/' 只影响打包后 JS/CSS 的 URL（如 /assets/index-xxx.js），
// 官网与后台路由仍是域名根下 / 与 /admin/*。勿把 BASE_URL 当作路由 basename：
// 若 basename='/assets'，用户访问 / 时无法匹配到 path="/" → 白屏仅见 <title>。
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);

