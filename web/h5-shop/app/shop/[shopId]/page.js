import { fetchJson } from '../../../lib/api';

export async function generateMetadata({ params }) {
  const shopId = params.shopId;
  const canonical = `https://simplewin.cn/zhejian/shop/${shopId}`;
  return {
    title: `店铺 ${shopId}`,
    alternates: { canonical },
    openGraph: { url: canonical, type: 'website' },
  };
}

export default async function PublicShopPage({ params }) {
  const shopId = String(params.shopId || '').trim();
  const { ok, data } = await fetchJson(`/api/v1/public/shops/${encodeURIComponent(shopId)}/summary`);
  if (!ok || !data || !data.shop) {
    return (
      <div>
        <h1>店铺未找到</h1>
        <p>该店铺不存在或未在辙见公开收录。</p>
      </div>
    );
  }
  const shop = data.shop;
  const cases = Array.isArray(data.cases) ? data.cases : [];
  const canonical = `https://simplewin.cn/zhejian/shop/${shopId}`;
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'AutoRepair',
    name: shop.name,
    url: canonical,
    address: [shop.province, shop.city, shop.district, shop.address].filter(Boolean).join(''),
    telephone: shop.phone || undefined,
  };
  return (
    <article>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <h1>{shop.name}</h1>
      <p>{[shop.province, shop.city, shop.district, shop.address].filter(Boolean).join(' · ')}</p>
      {shop.phone ? <p>电话：{shop.phone}</p> : null}
      <section>
        <h2>公开维修案例</h2>
        {cases.length === 0 ? <p>暂无已发布案例。</p> : null}
        <ul>
          {cases.map((c) => (
            <li key={c.public_case_slug}>
              <a href={`/zhejian/case/${encodeURIComponent(c.public_case_slug)}`}>{c.public_case_slug}</a>
            </li>
          ))}
        </ul>
      </section>
    </article>
  );
}
