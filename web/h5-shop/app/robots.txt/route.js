export function GET() {
  const body = [
    'User-agent: *',
    'Allow: /zhejian/',
    '',
    'Sitemap: https://simplewin.cn/zhejian/sitemap.xml',
    '',
  ].join('\n');
  return new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}
