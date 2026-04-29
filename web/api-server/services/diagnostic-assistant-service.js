/**
 * 诊断与验真聚合服务（M1骨架）
 * - 提供统一输出协议，便于小程序与外部H5复用
 * - 当前为最小可用规则版，后续可替换为模型/供应商聚合
 */
const crypto = require('crypto');
const { BRAND_CHANNEL_TEMPLATES, BRAND_ALIASES } = require('../config/parts-auth-channels');
const AUTO_OFFICIAL_BRANDS = Object.freeze(new Set(['toyota', 'bmw']));

function normalizeText(v) {
  return String(v || '').trim();
}

function normalizeStringArray(list) {
  return Array.isArray(list) ? list.map((x) => normalizeText(x)).filter(Boolean) : [];
}

function toNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function pickSeverityByKeywords(text) {
  const t = normalizeText(text);
  if (!t) return 'medium';
  if (/(无法启动|熄火|制动失灵|冒烟|漏油严重|动力丢失)/.test(t)) return 'high';
  if (/(异响|抖动|故障灯|渗油|温度偏高)/.test(t)) return 'medium';
  return 'low';
}

function inferSymptomTags(text) {
  const t = normalizeText(text);
  const tags = [];
  if (/(发动机|机油|抖动|怠速)/.test(t)) tags.push('engine');
  if (/(变速箱|换挡|顿挫)/.test(t)) tags.push('transmission');
  if (/(刹车|制动|异响)/.test(t)) tags.push('brake');
  if (/(空调|制冷|异味)/.test(t)) tags.push('ac');
  if (!tags.length) tags.push('general');
  return tags;
}

function inferDtcSeverity(code) {
  const c = normalizeText(code).toUpperCase();
  if (!c) return 'medium';
  if (/^P0/.test(c) || /^C0/.test(c)) return 'high';
  if (/^P1/.test(c) || /^B1/.test(c)) return 'medium';
  return 'low';
}

function resolveBrandKey(rawBrand) {
  const b = normalizeText(rawBrand).toLowerCase();
  if (!b) return '';
  return BRAND_ALIASES[b] || BRAND_ALIASES[normalizeText(rawBrand)] || b;
}

function normalizeReceiptItems(receipts) {
  if (!Array.isArray(receipts)) return [];
  return receipts
    .map((r) => {
      if (!r || typeof r !== 'object') return null;
      const item = {
        channel_name: normalizeText(r.channel_name),
        receipt_url: normalizeText(r.receipt_url),
        queried_at: normalizeText(r.queried_at),
        result_code: normalizeText(r.result_code).toLowerCase(),
        result_text: normalizeText(r.result_text),
      };
      if (!item.channel_name && !item.receipt_url && !item.result_code) return null;
      return item;
    })
    .filter(Boolean);
}

function hasVerifiedReceipt(receipts) {
  return (receipts || []).some((r) => ['verified', 'authentic', 'official_ok', 'pass'].includes(r.result_code));
}

function normalizeImageUrls(imageUrls) {
  if (!Array.isArray(imageUrls)) return [];
  return imageUrls.map((x) => normalizeText(x)).filter(Boolean);
}

function stableStringify(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map((v) => stableStringify(v)).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

function normalizeSignaturePayload(input) {
  return {
    part_code: normalizeText(input.part_code),
    brand: normalizeText(input.brand),
    vin: normalizeText(input.vin),
    official_verified: input.official_verified === true,
    user_receipts: normalizeReceiptItems(input.user_receipts).map((r) => ({
      channel_name: r.channel_name,
      receipt_url: r.receipt_url,
      queried_at: r.queried_at,
      result_code: r.result_code,
      result_text: r.result_text,
    })),
  };
}

function verifyCallbackSignature(input) {
  const signature = normalizeText(input.callback_signature).toLowerCase();
  if (!signature) return { provided: false, valid: null, reason: 'missing' };
  const secret = normalizeText(process.env.PARTS_AUTH_CALLBACK_SECRET);
  if (!secret) return { provided: true, valid: null, reason: 'secret_not_configured' };
  const payload = normalizeSignaturePayload(input);
  const canonical = stableStringify(payload);
  const expected = crypto.createHmac('sha256', secret).update(canonical).digest('hex');
  const valid = expected === signature;
  return { provided: true, valid, reason: valid ? 'ok' : 'invalid' };
}

function buildCallbackSigningPayload(input) {
  const payload = normalizeSignaturePayload(input || {});
  return {
    algorithm: 'HMAC-SHA256',
    signature_encoding: 'hex',
    canonical_payload: stableStringify(payload),
    payload,
    note: '请使用服务端与调用方约定的 PARTS_AUTH_CALLBACK_SECRET 对 canonical_payload 做 HMAC-SHA256。'
  };
}

function buildDiagnosisResponse(input) {
  const obviousDamage = normalizeStringArray(input.obvious_damage);
  const possibleDamage = normalizeStringArray(input.possible_damage);
  const repairAdvice = normalizeStringArray(input.repair_options);
  return {
    report_title: '损失报告（AI）',
    problem_summary: normalizeText(input.problem_summary),
    severity: normalizeText(input.severity || 'medium'),
    repair_options: repairAdvice,
    price_range: Array.isArray(input.price_range) ? input.price_range : [0, 0],
    safety_notes: normalizeStringArray(input.safety_notes),
    confidence: Number.isFinite(input.confidence) ? Number(input.confidence) : 0.5,
    report_sections: [
      { key: 'obvious_damage', title: '明显损伤', items: obviousDamage },
      { key: 'possible_damage', title: '可能损伤', items: possibleDamage },
      { key: 'repair_advice', title: '维修建议', items: repairAdvice },
    ],
    disclaimer: normalizeText(
      input.disclaimer || '该结果为辅助诊断建议，不构成最终维修方案或法律结论。'
    ),
    source: normalizeText(input.source || 'rule_based_v1'),
  };
}

function fromDamageAnalysis(analysisResult) {
  const ar = analysisResult && typeof analysisResult === 'object' ? analysisResult : {};
  const repairSuggestions = Array.isArray(ar.repair_suggestions) ? ar.repair_suggestions : [];
  const totalEstimate = Array.isArray(ar.total_estimate) ? ar.total_estimate : [0, 0];
  const summary =
    normalizeText(ar.summary) ||
    (repairSuggestions.length ? `识别到 ${repairSuggestions.length} 项建议维修项` : '已完成图片诊断');
  return buildDiagnosisResponse({
    problem_summary: summary,
    severity: Number(ar.confidence_score) < 0.5 ? 'medium' : 'low',
    obvious_damage: normalizeStringArray((ar.human_display && ar.human_display.obvious_damage) || []),
    possible_damage: normalizeStringArray((ar.human_display && ar.human_display.possible_damage) || []),
    repair_options: repairSuggestions
      .map((x) => normalizeText(x && (x.item || x.damage_part || x.repair_method)))
      .filter(Boolean),
    price_range: totalEstimate,
    safety_notes: ['建议到店复检后确认最终维修范围与价格。'],
    confidence: Number(ar.confidence_score) || 0.6,
    source: 'damage_ai',
    disclaimer: '该结果基于图片分析，仅供参考，不构成最终维修承诺。',
  });
}

function analyzeSymptom(payload) {
  const symptomText = normalizeText(payload && payload.symptom_text);
  const severity = pickSeverityByKeywords(symptomText);
  const tags = inferSymptomTags(symptomText);
  const options = [];
  const obvious = [];
  const possible = [];
  if (tags.includes('engine')) options.push('先检查机油液位与点火系统，再进行故障码读取');
  if (tags.includes('transmission')) options.push('检查变速箱油液状态并进行路试复核');
  if (tags.includes('brake')) options.push('优先检查刹车片厚度与制动盘磨损');
  if (tags.includes('ac')) options.push('检查制冷剂压力与冷凝器工况');
  if (tags.includes('general')) options.push('建议先做全车电脑检测与基础体检');
  if (symptomText) possible.push(symptomText);
  if (severity === 'high') obvious.push('故障现象疑似已影响行车安全');
  return buildDiagnosisResponse({
    problem_summary: symptomText || '用户未提供明确故障症状',
    severity,
    obvious_damage: obvious,
    possible_damage: possible,
    repair_options: options,
    price_range: severity === 'high' ? [1000, 5000] : severity === 'medium' ? [500, 2500] : [200, 1200],
    safety_notes:
      severity === 'high'
        ? ['存在行车风险，建议停止长途行驶并尽快到店检查。']
        : ['建议在7天内完成到店复检。'],
    confidence: symptomText ? 0.62 : 0.35,
    source: 'symptom_rule_v1',
  });
}

function interpretDtc(payload) {
  const code = normalizeText(payload && payload.dtc_code).toUpperCase();
  const severity = inferDtcSeverity(code);
  const mapping = {
    P0300: '检测到发动机多缸失火，常见于点火或供油系统问题',
    P0420: '三元催化效率偏低，可能与氧传感器或催化器老化有关',
    C0035: '轮速传感器信号异常，可能影响ABS功能',
  };
  return buildDiagnosisResponse({
    problem_summary: mapping[code] || `${code || '未知故障码'} 需要结合车型与实车工况进一步诊断`,
    severity,
    possible_damage: [mapping[code] || `${code || '未知故障码'} 需到店进一步排查`],
    repair_options: [
      '先做故障码清除与复现确认，避免历史故障干扰判断',
      '结合实车检测结果确认是否需要更换零部件',
    ],
    price_range: severity === 'high' ? [800, 4500] : [300, 2200],
    safety_notes:
      severity === 'high'
        ? ['若故障灯持续闪烁或伴随明显抖动，请尽快停驶处理。']
        : ['可短距离低速行驶至维修点复检。'],
    confidence: code ? 0.74 : 0.4,
    source: 'dtc_rule_v1',
  });
}

function buildPartsEvidence(input) {
  const receipts = normalizeReceiptItems(input.user_receipts);
  const images = normalizeImageUrls(input.image_urls);
  const signState = verifyCallbackSignature(input);
  const evidence = [];
  if (normalizeText(input.part_code)) evidence.push({ type: 'part_code', matched: true, detail: '已提供配件编号' });
  if (normalizeText(input.brand)) evidence.push({ type: 'brand', matched: true, detail: '已识别品牌信息' });
  if (images.length) evidence.push({ type: 'image_urls', matched: true, detail: `已提供 ${images.length} 张图片链接` });
  if (normalizeText(input.official_channel_url)) {
    evidence.push({ type: 'official_channel', matched: true, detail: '存在官方验真渠道' });
  } else {
    evidence.push({ type: 'official_channel', matched: false, detail: '未配置官方验真渠道，建议人工复核' });
  }
  if (normalizeText(input.vin)) evidence.push({ type: 'vin', matched: true, detail: '已提供VIN用于适配校验' });
  if (receipts.length) {
    evidence.push({ type: 'user_receipts', matched: true, detail: `已回填 ${receipts.length} 条用户验真凭证` });
  }
  if (input.official_verified === true || hasVerifiedReceipt(receipts)) {
    evidence.push({ type: 'official_receipt', matched: true, detail: '已提供官方回执，可信度显著提升' });
  }
  if (signState.provided) {
    evidence.push({
      type: 'callback_signature',
      matched: signState.valid === true,
      detail:
        signState.valid === true
          ? '回填签名校验通过'
          : signState.valid === false
            ? '回填签名校验失败'
            : '已提供签名但服务端未启用校验密钥',
    });
  }
  return evidence;
}

function buildVerificationChannels(input) {
  const brand = resolveBrandKey(input.brand);
  const partCode = encodeURIComponent(normalizeText(input.part_code));
  const fallback = normalizeText(input.official_channel_url);
  const selected = BRAND_CHANNEL_TEMPLATES[brand];
  const channels = [];
  if (selected) {
    channels.push({
      channel_name: selected.name,
      channel_type: 'official_h5',
      launch_url: selected.url_template.replace('{part_code}', partCode),
      status: 'pending_user_verify',
      prefill: { part_code: normalizeText(input.part_code), brand: normalizeText(input.brand) },
    });
  }
  if (fallback) {
    channels.push({
      channel_name: '品牌方/渠道方自定义入口',
      channel_type: 'external_h5',
      launch_url: fallback,
      status: 'pending_user_verify',
      prefill: { part_code: normalizeText(input.part_code), brand: normalizeText(input.brand) },
    });
  }
  return channels;
}

async function callOfficialBrandApi(url, body, apiKey) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body || {}),
      signal: controller.signal,
    });
    const text = await resp.text();
    let parsed = {};
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch (_) {
      parsed = {};
    }
    if (!resp.ok) {
      return { ok: false, status: 'upstream_http_error', detail: `HTTP ${resp.status}` };
    }
    return { ok: true, status: 'ok', data: parsed };
  } catch (err) {
    const msg = normalizeText(err && err.message);
    return { ok: false, status: 'upstream_exception', detail: msg || 'request_failed' };
  } finally {
    clearTimeout(timer);
  }
}

async function runOfficialBrandAutoCheck(input) {
  const brandKey = resolveBrandKey(input.brand);
  const partCode = normalizeText(input.part_code);
  const imageUrls = normalizeImageUrls(input.image_urls);
  const vin = normalizeText(input.vin);

  if (!AUTO_OFFICIAL_BRANDS.has(brandKey)) {
    return {
      brand: brandKey || '',
      auto_check_supported: false,
      auto_check_status: 'brand_not_supported',
      manual_check_required: true,
      verified: null,
      detail: '当前品牌暂未接入自动核验，建议按推荐官方渠道手动核验。',
    };
  }

  if (!partCode && imageUrls.length === 0) {
    return {
      brand: brandKey,
      auto_check_supported: true,
      auto_check_status: 'insufficient_input',
      manual_check_required: true,
      verified: null,
      detail: '缺少可核验输入（配件编号或图片），请补充后再试。',
    };
  }

  const endpoint =
    brandKey === 'toyota'
      ? normalizeText(process.env.TOYOTA_PARTS_AUTH_API_URL)
      : normalizeText(process.env.BMW_PARTS_AUTH_API_URL);
  const apiKey =
    brandKey === 'toyota'
      ? normalizeText(process.env.TOYOTA_PARTS_AUTH_API_KEY)
      : normalizeText(process.env.BMW_PARTS_AUTH_API_KEY);

  if (!endpoint) {
    return {
      brand: brandKey,
      auto_check_supported: true,
      auto_check_status: 'api_not_configured',
      manual_check_required: true,
      verified: null,
      detail: '已匹配重点品牌，但未配置自动核验API，建议按官方页面手动核验。',
    };
  }

  const upstream = await callOfficialBrandApi(endpoint, {
    brand: brandKey,
    part_code: partCode,
    image_urls: imageUrls,
    vin,
  }, apiKey);
  if (!upstream.ok) {
    return {
      brand: brandKey,
      auto_check_supported: true,
      auto_check_status: upstream.status,
      manual_check_required: true,
      verified: null,
      detail: `自动核验未完成：${upstream.detail || upstream.status}`,
    };
  }

  const data = upstream.data && typeof upstream.data === 'object' ? upstream.data : {};
  const verified = data.verified === true ? true : data.verified === false ? false : null;
  return {
    brand: brandKey,
    auto_check_supported: true,
    auto_check_status: verified === true ? 'verified' : verified === false ? 'unverified' : 'unknown',
    manual_check_required: verified !== true,
    verified,
    confidence: Number.isFinite(Number(data.confidence)) ? Number(data.confidence) : null,
    reference_id: normalizeText(data.reference_id),
    detail: normalizeText(data.message || data.detail || ''),
  };
}

function calcPartsRiskScore(input, evidence) {
  const receipts = normalizeReceiptItems(input.user_receipts);
  const verifiedByReceipt = hasVerifiedReceipt(receipts);
  const signState = verifyCallbackSignature(input);
  let score = 40;
  if (evidence.some((x) => x.type === 'official_channel' && x.matched)) score += 30;
  if (evidence.some((x) => x.type === 'vin' && x.matched)) score += 20;
  if (evidence.some((x) => x.type === 'part_code' && x.matched)) score += 10;
  if (evidence.some((x) => x.type === 'image_urls' && x.matched)) score += 5;
  if (input.official_verified === true || verifiedByReceipt) score += 25;
  score += Math.min(10, receipts.length * 2);
  score += Math.max(-10, Math.min(10, Math.round(toNumber(input.channel_reliability_delta, 0))));
  if (signState.valid === false) score -= 20;
  if (signState.valid === true) score += 5;
  return Math.max(0, Math.min(100, score));
}

function buildPartsAuthResult(input) {
  const receipts = normalizeReceiptItems(input.user_receipts);
  const verifiedByReceipt = hasVerifiedReceipt(receipts);
  const signState = verifyCallbackSignature(input);
  const evidence = buildPartsEvidence(input);
  const channels = buildVerificationChannels(input);
  const score = calcPartsRiskScore(input, evidence);
  const autoCheckSupported = channels.length > 0;

  const authLevel =
    input.official_verified === true || verifiedByReceipt ? 'official_verified' :
      score >= 90 ? 'high' :
      score >= 70 ? 'medium' :
        score >= 50 ? 'low' :
          'unknown';

  return {
    auth_level: authLevel,
    confidence_score: Math.min(0.95, Math.max(0.2, score / 100)),
    evidence,
    aggregation_mode: 'hybrid',
    verification_channels: channels,
    verification_summary: {
      auto_check_supported: autoCheckSupported,
      auto_check_status: autoCheckSupported ? 'matched_official_channel' : 'manual_check_required',
      manual_check_required: !autoCheckSupported,
    },
    callback_signature_valid: signState.valid,
    callback_fields: [
      'official_verified',
      'image_urls[]',
      'user_receipts[].channel_name',
      'user_receipts[].receipt_url',
      'user_receipts[].queried_at',
      'user_receipts[].result_code',
      'user_receipts[].result_text',
      'callback_signature',
      'channel_reliability_delta',
    ],
    risk_notes:
      authLevel === 'official_verified' || authLevel === 'high'
        ? ['建议保留购买凭证与安装工单，便于后续质保。']
        : ['当前证据不足，建议通过官方渠道二次核验并保留截图凭证。'],
    next_actions: [
      '补充官方验真回执截图或查询编号',
      '到店安装前再次核对包装标签与配件编码一致性',
      '若接入回调签名，建议传 callback_signature 防止伪造回执',
    ],
    disclaimer: '在无官方回执时，本结果仅为风险评估，不构成“100%正品”结论。',
  };
}

async function buildPartsAuthResultWithOfficialCheck(input) {
  const out = buildPartsAuthResult(input);
  const autoCheck = await runOfficialBrandAutoCheck(input || {});
  out.verification_summary = {
    ...(out.verification_summary || {}),
    auto_check_supported: autoCheck.auto_check_supported,
    auto_check_status: autoCheck.auto_check_status,
    manual_check_required: autoCheck.manual_check_required,
    auto_check_brand: autoCheck.brand || '',
    auto_check_detail: autoCheck.detail || '',
    auto_check_reference_id: autoCheck.reference_id || '',
  };

  if (autoCheck.verified === true) {
    out.auth_level = 'official_verified';
    out.confidence_score = Math.max(out.confidence_score || 0.5, 0.96);
    out.evidence = (out.evidence || []).concat([
      { type: 'official_auto_check', matched: true, detail: `${autoCheck.brand || '重点品牌'}自动核验通过` },
    ]);
    out.risk_notes = ['已完成官方自动核验，建议保留购买凭证与安装工单。'];
    out.next_actions = ['可直接进入维修报价流程，安装前再做一次编码一致性核对。'];
  } else if (autoCheck.verified === false) {
    out.evidence = (out.evidence || []).concat([
      { type: 'official_auto_check', matched: false, detail: `${autoCheck.brand || '重点品牌'}自动核验未通过` },
    ]);
    out.risk_notes = ['自动核验未通过，建议停止安装并联系销售方复核来源。'];
    out.next_actions = ['携带购买凭证与配件编码，到品牌官方渠道二次确认。'];
  } else if (autoCheck.auto_check_supported && autoCheck.manual_check_required) {
    out.next_actions = ['请按上方官方入口手动核验，并保留截图凭证后再安装。'].concat(out.next_actions || []);
  }
  return out;
}

function scorePartsAuthRisk(input) {
  const normalized = input && typeof input === 'object' ? input : {};
  return buildPartsAuthResult(normalized);
}

function buildManualCheckRecord(input) {
  const payload = input && typeof input === 'object' ? input : {};
  const now = new Date().toISOString();
  const brand = normalizeText(payload.brand);
  const partCode = normalizeText(payload.part_code);
  const vin = normalizeText(payload.vin);
  const channelName = normalizeText(payload.channel_name);
  const channelUrl = normalizeText(payload.channel_url);
  const resultCode = normalizeText(payload.result_code).toLowerCase();
  const resultText = normalizeText(payload.result_text);
  const receiptUrl = normalizeText(payload.receipt_url);
  const notes = normalizeText(payload.notes);
  const canonical = stableStringify({
    brand,
    part_code: partCode,
    vin,
    channel_name: channelName,
    channel_url: channelUrl,
    result_code: resultCode,
    result_text: resultText,
    receipt_url: receiptUrl,
    notes,
    created_at: now,
  });
  const digest = crypto.createHash('sha256').update(canonical).digest('hex');
  return {
    record_id: `mcr_${digest.slice(0, 16)}`,
    created_at: now,
    brand,
    part_code: partCode,
    vin,
    channel_name: channelName,
    channel_url: channelUrl,
    result_code: resultCode,
    result_text: resultText,
    receipt_url: receiptUrl,
    notes,
    canonical_payload: canonical,
  };
}

module.exports = {
  fromDamageAnalysis,
  analyzeSymptom,
  interpretDtc,
  buildPartsAuthResult,
  buildPartsAuthResultWithOfficialCheck,
  scorePartsAuthRisk,
  buildManualCheckRecord,
  buildCallbackSigningPayload,
};

