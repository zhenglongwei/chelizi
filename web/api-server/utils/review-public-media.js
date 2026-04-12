/**
 * 分项公示勾选 JSON（reviews.review_public_media），与极简 v3 一致
 */

function normalizeReviewPublicMedia(raw) {
  const d = {
    exterior_before_after: false,
    parts_contrast: false,
    settlement_docs: false,
    other: false,
  };
  if (!raw || typeof raw !== 'object') return d;
  for (const k of Object.keys(d)) {
    const v = raw[k];
    if (v === true || v === 1 || v === '1') d[k] = true;
  }
  return d;
}

function anyPublicMediaSelected(d) {
  return !!(d && Object.values(d).some(Boolean));
}

module.exports = {
  normalizeReviewPublicMedia,
  anyPublicMediaSelected,
};
