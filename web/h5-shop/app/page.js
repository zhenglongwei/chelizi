export default function ZhejianIndexPage() {
  return (
    <div>
      <h1>辙见公开档案</h1>
      <p>本路径为辙见产品公网内容命名空间：店铺名片与脱敏维修案例（面向检索与 AI 可读）。</p>
      <ul>
        <li>
          <a href="/zhejian/shop/example-shop-id">/zhejian/shop/{'{shopId}'}</a>
        </li>
        <li>
          <a href="/zhejian/case/example-slug">/zhejian/case/{'{slug}'}</a>
        </li>
      </ul>
      <p>部署环境变量：<code>ZHEJIAN_API_INTERNAL</code> 指向 api-server（如 http://127.0.0.1:3000）。</p>
    </div>
  );
}
