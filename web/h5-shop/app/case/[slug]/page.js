import { fetchJson } from '../../../lib/api';

export async function generateMetadata({ params }) {
  const slug = params.slug;
  const canonical = `https://simplewin.cn/zhejian/case/${slug}`;
  return {
    title: `案例 ${slug}`,
    alternates: { canonical },
    robots: { index: true, follow: true },
    openGraph: { url: canonical, type: 'article' },
  };
}

function snapshotToText(snap) {
  if (!snap || typeof snap !== 'object') return '';
  const parts = [];
  if (snap.title) parts.push(String(snap.title));
  if (snap.summary) parts.push(String(snap.summary));
  if (snap.teaser) parts.push(String(snap.teaser));
  if (snap.damage_summary) parts.push(String(snap.damage_summary));
  return parts.join('\n\n').slice(0, 8000);
}

export default async function PublicCasePage({ params }) {
  const slug = String(params.slug || '').trim();
  const { ok, data, status } = await fetchJson(`/api/v1/public/cases/${encodeURIComponent(slug)}`);
  if (!ok || status === 404 || !data) {
    return (
      <div>
        <h1>案例未发布</h1>
        <p>该案例不存在、未审核通过或已撤回。</p>
        <meta name="robots" content="noindex" />
      </div>
    );
  }
  let snap = data.desensitized_snapshot;
  if (typeof snap === 'string') {
    try {
      snap = JSON.parse(snap);
    } catch (_) {
      snap = {};
    }
  }
  const bodyText = snapshotToText(snap);
  const canonical = data.published_url || `https://simplewin.cn/zhejian/case/${slug}`;
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: (snap && snap.title) || `维修案例 ${slug}`,
    url: canonical,
    author: data.shop_name ? { '@type': 'Organization', name: data.shop_name } : undefined,
    articleBody: bodyText || undefined,
  };
  return (
    <article>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <h1>{(snap && snap.title) || `维修案例`}</h1>
      <p>
        <strong>{data.shop_name || '维修企业'}</strong>
        {[data.city, data.address].filter(Boolean).join(' · ')}
      </p>
      <section>
        {bodyText ? bodyText.split('\n\n').map((para, i) => (
          <p key={i}>{para}</p>
        )) : <p>本案例正文由商家脱敏提交，暂无文字摘要。</p>}
      </section>
    </article>
  );
}
