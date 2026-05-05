/**
 * 小程序端统一按「北京时间 Asia/Shanghai」解析后端时间并展示。
 * - 带 Z / 时区偏移的 ISO：按绝对时刻解析，再格式化为北京时间。
 * - 无时区的 `YYYY-MM-DD HH:mm:ss` / `YYYY-MM-DDTHH:mm:ss`：按东八区本地时刻解析（与常见 MySQL 存库习惯一致）。
 * 展示用固定 +8 换算（中国无夏令时），不依赖设备本地时区。
 */

function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * @param {string|Date|number|null|undefined} input
 * @returns {Date|null}
 */
function parseBackendDate(input) {
  if (input == null || input === '') return null;
  if (input instanceof Date) {
    return Number.isNaN(input.getTime()) ? null : input;
  }
  if (typeof input === 'number' && Number.isFinite(input)) {
    const d = new Date(input);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const s = String(input).trim();
  if (!s) return null;

  const hasExplicitZone = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(s);
  const looksLikeSqlLocal =
    /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(s) && !hasExplicitZone;

  if (looksLikeSqlLocal) {
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
    if (m) {
      const sec = m[6] != null ? m[6] : '00';
      const t = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${sec}+08:00`);
      if (!Number.isNaN(t)) return new Date(t);
    }
  }

  const normalized = s.includes('T') ? s : s.replace(' ', 'T');
  const t2 = Date.parse(normalized);
  if (!Number.isNaN(t2)) return new Date(t2);
  return null;
}

function formatBeijingFromUtcMs(utcMs, withSeconds) {
  const u = new Date(Number(utcMs) + 8 * 3600000);
  if (Number.isNaN(u.getTime())) return '';
  const y = u.getUTCFullYear();
  const mo = pad2(u.getUTCMonth() + 1);
  const d = pad2(u.getUTCDate());
  const h = pad2(u.getUTCHours());
  const mi = pad2(u.getUTCMinutes());
  if (withSeconds) {
    const sec = pad2(u.getUTCSeconds());
    return `${y}-${mo}-${d} ${h}:${mi}:${sec}`;
  }
  return `${y}-${mo}-${d} ${h}:${mi}`;
}

/**
 * @param {string|Date|number|null|undefined} input
 * @returns {string} YYYY-MM-DD HH:mm
 */
function formatBeijingDateTimeShort(input) {
  const dt = parseBackendDate(input);
  if (!dt) return '';
  return formatBeijingFromUtcMs(dt.getTime(), false);
}

/**
 * @param {string|Date|number|null|undefined} input
 * @returns {string} YYYY-MM-DD HH:mm:ss
 */
function formatBeijingDateTimeFull(input) {
  const dt = parseBackendDate(input);
  if (!dt) return '';
  return formatBeijingFromUtcMs(dt.getTime(), true);
}

/**
 * 距截止时间剩余文案（与北京时间解析后的绝对时刻一致）
 * @param {string|Date|null|undefined} expireAt
 * @param {number} [nowMs]
 */
function formatExpireCountdown(expireAt, nowMs) {
  const end = parseBackendDate(expireAt);
  if (!end) return '--';
  const now = typeof nowMs === 'number' ? nowMs : Date.now();
  const diff = end.getTime() - now;
  if (diff <= 0) return '已结束';
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  if (h > 0) return `${h}小时后`;
  if (m > 0) return `${m}分钟后`;
  return '即将结束';
}

module.exports = {
  parseBackendDate,
  formatBeijingDateTimeShort,
  formatBeijingDateTimeFull,
  formatExpireCountdown,
};
