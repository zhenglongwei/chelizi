import './globals.css';

export const metadata = {
  metadataBase: new URL('https://simplewin.cn'),
  title: { default: '辙见 · 公开档案', template: '%s · 辙见' },
  description: '事故车维修公开案例与店铺名片（辙见），面向检索与 AI 可读的结构化页面。',
  openGraph: { siteName: '辙见', type: 'website' },
};

export default function RootLayout({ children }) {
  return (
    <html lang="zh-CN">
      <body>
        <main>{children}</main>
      </body>
    </html>
  );
}
