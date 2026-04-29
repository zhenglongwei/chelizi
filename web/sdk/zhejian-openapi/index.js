class ZhejianOpenApiClient {
  /**
   * @param {object} opts
   * @param {string} opts.baseUrl e.g. https://simplewin.cn
   * @param {string} opts.apiKey OpenAPI Key
   * @param {number} [opts.timeoutMs=15000]
   */
  constructor(opts) {
    this.baseUrl = String(opts && opts.baseUrl ? opts.baseUrl : '').replace(/\/+$/, '');
    this.apiKey = String(opts && opts.apiKey ? opts.apiKey : '').trim();
    this.timeoutMs = (opts && opts.timeoutMs) || 15000;
    if (!this.baseUrl) throw new Error('baseUrl required');
    if (!this.apiKey) throw new Error('apiKey required');
  }

  async _request(path, method, body) {
    const url = this.baseUrl + path;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': this.apiKey,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      const text = await res.text();
      let json;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      if (!res.ok) {
        const msg = (json && json.message) || text || `HTTP ${res.status}`;
        const err = new Error(msg);
        err.status = res.status;
        err.response = json;
        throw err;
      }
      return json && json.data !== undefined ? json.data : json;
    } finally {
      clearTimeout(t);
    }
  }

  /** 获取该 key 已开通能力（受全局开关与 entitlement 影响） */
  async getOpenCapabilities() {
    return await this._request('/api/v1/open/capabilities', 'GET');
  }

  /** 证据补拍清单 */
  async accidentEvidenceChecklist(input) {
    return await this._request('/api/v1/open/accident/evidence-checklist', 'POST', input || {});
  }

  /** 理赔/自费流程提示 */
  async accidentClaimGuide(input) {
    return await this._request('/api/v1/open/accident/claim-guide', 'POST', input || {});
  }

  /** 价格区间估算（可解释） */
  async accidentPriceEstimate(input) {
    return await this._request('/api/v1/open/accident/price-estimate', 'POST', input || {});
  }
}

module.exports = {
  ZhejianOpenApiClient,
};

