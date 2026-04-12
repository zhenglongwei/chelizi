/**
 * 写入 MySQL JSON 列前的序列化：避免 BigInt（mysql2 部分类型）等导致 JSON.stringify 抛错
 */

function jsonStringifyForDb(value) {
  return JSON.stringify(value, (_k, v) => {
    if (typeof v === 'bigint') return v.toString();
    if (v instanceof Date) return v.toISOString();
    return v;
  });
}

module.exports = { jsonStringifyForDb };
