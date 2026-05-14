export function GET() {
  const body = [
    '# 辙见（zhejian）公开 URL 模式',
    '',
    '- 店铺名片: https://simplewin.cn/zhejian/shop/{shopId}',
    '- 脱敏案例: https://simplewin.cn/zhejian/case/{slug}',
    '',
  ].join('\n');
  return new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}
