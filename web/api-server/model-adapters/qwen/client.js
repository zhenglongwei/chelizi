const axios = require('axios');

function base64UrlEncode(buf) {
  return Buffer.from(buf).toString('base64');
}

function formatDashscopeAxiosError(err) {
  const status = err.response?.status;
  const data = err.response?.data;
  if (data && typeof data === 'object') {
    const inner = data.error || data;
    const msg = inner.message || inner.msg || inner.code || JSON.stringify(data);
    return `千问API ${status || ''}: ${msg}`;
  }
  if (typeof data === 'string' && data.trim()) {
    return `千问API ${status || ''}: ${data.trim().slice(0, 500)}`;
  }
  return err.message || '千问请求失败';
}

function trimVisionImageUrl(raw) {
  let s = String(raw || '').trim();
  if (!s) return s;
  if (process.env.QWEN_IMAGE_FORCE_HTTPS !== '0' && s.startsWith('http://')) {
    s = 'https://' + s.slice('http://'.length);
  }
  return s;
}

const DASHSCOPE_BASE_URL = String(
  process.env.DASHSCOPE_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1'
).replace(/\/$/, '');
const QWEN_MODEL = String(process.env.DASHSCOPE_MODEL || 'qwen-vl-plus').trim();

async function callQwenText(systemPrompt, userText, apiKey) {
  if (!apiKey || !String(apiKey).trim()) {
    throw new Error('未配置千问 API Key');
  }
  const messages = [];
  if (systemPrompt && String(systemPrompt).trim()) {
    messages.push({ role: 'system', content: systemPrompt });
  }
  messages.push({ role: 'user', content: String(userText || '') });
  let res;
  try {
    res = await axios.post(
      DASHSCOPE_BASE_URL + '/chat/completions',
      { model: QWEN_MODEL, messages, max_tokens: 4096 },
      {
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
        timeout: 180000,
      }
    );
  } catch (err) {
    console.error('[qwen-client] text failed:', formatDashscopeAxiosError(err));
    throw new Error(formatDashscopeAxiosError(err));
  }
  const choice = res.data?.choices?.[0];
  if (!choice) throw new Error(res.data?.error?.message || '千问 API 返回异常');
  return (choice.message?.content || '').trim();
}

async function callQwenVision(content, apiKey, systemPrompt) {
  if (!apiKey || !String(apiKey).trim()) {
    throw new Error('未配置千问 API Key');
  }
  const messages = [];
  if (systemPrompt && String(systemPrompt).trim()) {
    messages.push({ role: 'system', content: systemPrompt });
  }
  const normalizedContent = Array.isArray(content)
    ? content.map((part) => {
        if (part && part.type === 'image_url' && part.image_url && part.image_url.url) {
          return { ...part, image_url: { url: trimVisionImageUrl(part.image_url.url) } };
        }
        return part;
      })
    : content;
  messages.push({ role: 'user', content: normalizedContent });
  let res;
  try {
    res = await axios.post(
      DASHSCOPE_BASE_URL + '/chat/completions',
      { model: QWEN_MODEL, messages, max_tokens: 2048 },
      {
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
        timeout: 180000,
      }
    );
  } catch (err) {
    console.error('[qwen-client] vision failed:', formatDashscopeAxiosError(err));
    throw new Error(formatDashscopeAxiosError(err));
  }
  const choice = res.data?.choices?.[0];
  if (!choice) throw new Error(res.data?.error?.message || '千问 API 返回异常');
  return (choice.message?.content || '').trim();
}

module.exports = {
  callQwenText,
  callQwenVision,
  trimVisionImageUrl,
  QWEN_MODEL,
};

