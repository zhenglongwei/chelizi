const API_INTERNAL = process.env.ZHEJIAN_API_INTERNAL || 'http://127.0.0.1:3000';

export async function fetchJson(path) {
  const url = `${API_INTERNAL.replace(/\/$/, '')}${path.startsWith('/') ? path : '/' + path}`;
  const res = await fetch(url, { next: { revalidate: 120 } });
  if (!res.ok) return { ok: false, status: res.status, data: null };
  const body = await res.json();
  const data = body && body.data !== undefined ? body.data : body;
  return { ok: true, status: res.status, data };
}
