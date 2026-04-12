/**
 * 定损结果「人性化展示」：明显损伤 / 可能损伤 / 维修建议（不标注照片或陈述来源）
 */

const SOURCE_PHRASE_RE =
  /依据用户陈述|用户陈述|用户补充|用户描述|照片(可见|显示|未见)?|从照片|AI分析|智能分析/gi;

function stripSourcePhrases(text) {
  let s = String(text || '').trim();
  if (!s) return '';
  s = s.replace(SOURCE_PHRASE_RE, '');
  s = s.replace(/^[：:、，,\-\s—–]+/, '').replace(/[：:、，,\-\s—–]+$/g, '').trim();
  return s;
}

function lineFromEntry(entry) {
  if (entry == null) return '';
  if (typeof entry === 'string') return stripSourcePhrases(entry);
  if (typeof entry === 'object') {
    const title = stripSourcePhrases(entry.title || entry.part || entry.label || '');
    const text = stripSourcePhrases(entry.text || entry.detail || entry.desc || entry.type || '');
    if (title && text) return `${title}：${text}`;
    return stripSourcePhrases(title || text);
  }
  return stripSourcePhrases(String(entry));
}

function stringsFromField(field) {
  if (field == null) return [];
  if (typeof field === 'string') {
    const s = stripSourcePhrases(field);
    return s ? [s] : [];
  }
  if (!Array.isArray(field)) return [];
  const out = [];
  for (const x of field) {
    const line = lineFromEntry(x);
    if (line) out.push(line);
  }
  return out;
}

/**
 * @param {object} [raw] - 模型返回的 human_display
 * @returns {{ obvious_damage: string[], possible_damage: string[], repair_advice: string[] }}
 */
function normalizeHumanDisplay(raw) {
  if (!raw || typeof raw !== 'object') {
    return { obvious_damage: [], possible_damage: [], repair_advice: [] };
  }
  const o =
    raw.obvious_damage ??
    raw.obvious ??
    raw.明显损伤 ??
    raw.obvious_injuries;
  const p =
    raw.possible_damage ??
    raw.possible ??
    raw.可能损伤 ??
    raw.possible_injuries;
  const r =
    raw.repair_advice ??
    raw.repair_suggestions_human ??
    raw.维修建议 ??
    raw.repair_recommendations;
  return {
    obvious_damage: stringsFromField(o),
    possible_damage: stringsFromField(p),
    repair_advice: stringsFromField(r)
  };
}

function stripVehiclePrefix(item, vehicleId) {
  const vid = String(vehicleId || '').trim();
  let s = String(item || '').trim();
  if (!s) return '';
  if (vid) {
    const p1 = vid + '-';
    const p2 = vid + '：';
    if (s.startsWith(p1)) s = s.slice(p1.length).trim();
    else if (s.startsWith(p2)) s = s.slice(p2.length).trim();
  }
  return stripSourcePhrases(s);
}

function repairLinesForVehicle(repairSuggestions, vehicleId) {
  const vid = String(vehicleId || '').trim();
  const list = Array.isArray(repairSuggestions) ? repairSuggestions : [];
  const out = [];
  for (const row of list) {
    const item = row && row.item != null ? String(row.item) : '';
    if (!item.trim()) continue;
    if (vid && !item.startsWith(vid + '-') && !item.startsWith(vid + '：')) continue;
    const line = stripVehiclePrefix(item, vid);
    if (line) out.push(line);
  }
  return out;
}

const POSSIBLE_HINT_RE =
  /待查|待确认|待实车|待拆解|风险|推断|不可见|可能|水淹|进水|泡水|熄火|功能异常|线束|模块|电控|地毯|内饰进水|依据用户|陈述|补充|照片不可见|待诊断/i;

function isPossibleStyleDamage(d) {
  const blob = `${d.part || ''} ${d.type || ''} ${d.severity || ''}`;
  return POSSIBLE_HINT_RE.test(blob);
}

function formatDamageLine(d) {
  const part = stripSourcePhrases(d.part || '');
  const type = stripSourcePhrases(d.type || '');
  const sev = stripSourcePhrases(d.severity || '');
  if (!part && !type) return '';
  if (part && type && sev) return `${part}：${type}（${sev}）`;
  if (part && type) return `${part}：${type}`;
  return part || type;
}

/**
 * 无模型 human_display 时，由 damages + repair_suggestions 推导
 */
function deriveHumanDisplayFromLegacy(vehicleDamages, repairSuggestions, vehicleId) {
  const damages = Array.isArray(vehicleDamages) ? vehicleDamages : [];
  const obvious = [];
  const possible = [];
  for (const d of damages) {
    const line = formatDamageLine(d);
    if (!line) continue;
    if (isPossibleStyleDamage(d)) possible.push(line);
    else obvious.push(line);
  }
  let repair_advice = repairLinesForVehicle(repairSuggestions, vehicleId);
  repair_advice = repair_advice.map((x) => stripSourcePhrases(x)).filter(Boolean);
  return { obvious_damage: obvious, possible_damage: possible, repair_advice };
}

/**
 * 优先使用模型输出；若三段全空则走 legacy；维修建议可仅用 repair_suggestions 补全
 */
function normalizeOrDeriveHumanDisplay(rawHumanDisplay, vehicleDamages, repairSuggestions, vehicleId) {
  const norm = normalizeHumanDisplay(rawHumanDisplay);
  const n =
    norm.obvious_damage.length + norm.possible_damage.length + norm.repair_advice.length;
  if (n === 0) {
    return deriveHumanDisplayFromLegacy(vehicleDamages, repairSuggestions, vehicleId);
  }
  if (norm.repair_advice.length === 0) {
    const extra = repairLinesForVehicle(repairSuggestions, vehicleId)
      .map((x) => stripSourcePhrases(x))
      .filter(Boolean);
    norm.repair_advice = extra;
  }
  return norm;
}

/**
 * 为 analysis_result 各车补齐 human_display（读库/写库后均可调用）
 * @param {object} ar
 */
function enrichAnalysisResultHumanDisplay(ar) {
  if (!ar || typeof ar !== 'object') return;
  const damages = ar.damages || [];
  const repair = ar.repair_suggestions || [];
  const vi = ar.vehicle_info;
  if (Array.isArray(vi) && vi.length > 0) {
    for (let i = 0; i < vi.length; i++) {
      const v = vi[i];
      const vid = String(v.vehicleId || `车辆${i + 1}`).trim();
      const vDamages = damages.filter((d) => String(d.vehicleId || '车辆1').trim() === vid);
      const hd = normalizeOrDeriveHumanDisplay(v.human_display, vDamages, repair, vid);
      vi[i] = { ...v, human_display: hd };
    }
    return;
  }
  ar.human_display = normalizeOrDeriveHumanDisplay(ar.human_display, damages, repair, '车辆1');
}

module.exports = {
  normalizeHumanDisplay,
  normalizeOrDeriveHumanDisplay,
  deriveHumanDisplayFromLegacy,
  stripSourcePhrases,
  enrichAnalysisResultHumanDisplay
};
