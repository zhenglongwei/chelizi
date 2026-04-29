/**
 * 代理人分销：分享路径统一附带 ref（推荐人 user_id），与 app.js / 登录后 bindReferrer 一致
 */
const { getUserId } = require('./api');

function appendRefToPath(path) {
  const p = path && String(path).trim() ? (path.startsWith('/') ? path : '/' + path) : '/pages/index/index';
  const ref = String(getUserId() || '').trim();
  if (!ref) return p;
  const join = p.includes('?') ? '&' : '?';
  if (p.includes('ref=')) return p;
  return `${p}${join}ref=${encodeURIComponent(ref)}`;
}

/**
 * @param {string} route - 以 / 开头的路由，如 /pages/shop/detail/index
 * @param {Record<string, string|number|undefined|null>} [query] - 查询参数（不含 ref）
 */
function buildReferralSharePath(route, query) {
  const base = route && String(route).trim() ? (route.startsWith('/') ? route : '/' + route) : '/pages/index/index';
  const parts = [];
  if (query && typeof query === 'object') {
    for (const k of Object.keys(query)) {
      const v = query[k];
      if (v == null || v === '') continue;
      parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
    }
  }
  const q = parts.length ? `${base}?${parts.join('&')}` : base;
  return appendRefToPath(q);
}

const SHARE_TITLES = {
  home: '辙见 · 事故车维修透明报价',
  shop: '辙见 · 维修厂口碑',
  reputationShop: '辙见 · 口碑好店',
  reputationReviews: '辙见 · 车主真实评价',
  review: '辙见 · 车主真实评价',
  invite: '辙见 · 邀请你用车维修更省心'
};

module.exports = {
  appendRefToPath,
  buildReferralSharePath,
  SHARE_TITLES
};
