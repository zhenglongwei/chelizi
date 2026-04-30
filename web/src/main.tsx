import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './index.css';
import './theme.css';

// Vite 的 base 只影响打包后 JS/CSS 的 URL；官网与后台路由仍是域名根下 / 与 /admin/*。
// 勿把 BASE_URL 当作路由 basename，否则 path="/" 无法匹配会白屏。
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);

