/**
 * Vercel Serverless 代理：转发轨迹查询到 Speedaf，解决浏览器 CORS 限制
 * 前端 POST /api/track，body: { mailNoList: ["单号"] } 或 { trackingNumber: "单号" }
 */
const crypto = require('crypto');
const dns = require('dns');
const CryptoJS = require('crypto-js');

/**
 * 若 Vercel 日志出现：fetch failed | cause: getaddrinfo ENOTFOUND api.speedaf.com
 * 说明美国机房 DNS 解析不到该域名。可在 Vercel 环境变量设置（逗号分隔）：
 * TRACK_DNS_SERVERS=223.5.5.5,114.114.114.114,8.8.8.8
 * 仍不行则改用腾讯云 SCF（国内解析通常正常）。
 */
if (process.env.TRACK_DNS_SERVERS) {
  const list = process.env.TRACK_DNS_SERVERS.split(',').map((s) => s.trim()).filter(Boolean);
  if (list.length) dns.setServers(list);
}

/** 与 Speedaf 文档一致；勿用 Node crypto DES（Node 18+/OpenSSL 3 默认不支持 des-cbc） */
const DES_IV_HEX = '1234567890abcdef';
const APP_CODE = process.env.SPEEDAF_APP_CODE || 'CN000796';
const SECRET_KEY = process.env.SPEEDAF_SECRET_KEY || 'Ty2pi72K';
const CUSTOMER_CODE = process.env.SPEEDAF_CUSTOMER_CODE || 'CN000796';
const PLATFORM_SOURCE = process.env.SPEEDAF_PLATFORM_SOURCE || 'HKXH';
const SPEEDAF_URL = 'https://api.speedaf.com/open-api/express/track/query';

function md5(str) {
  return crypto.createHash('md5').update(str, 'utf8').digest('hex').toLowerCase();
}

function desEncrypt(plainText, secretKey) {
  const key = CryptoJS.enc.Utf8.parse(String(secretKey).slice(0, 8));
  const iv = CryptoJS.enc.Hex.parse(DES_IV_HEX);
  const encrypted = CryptoJS.DES.encrypt(plainText, key, {
    iv,
    mode: CryptoJS.mode.CBC,
    padding: CryptoJS.pad.Pkcs7,
  });
  return encrypted.ciphertext.toString(CryptoJS.enc.Base64);
}

function desDecrypt(base64Cipher, secretKey) {
  const key = CryptoJS.enc.Utf8.parse(String(secretKey).slice(0, 8));
  const iv = CryptoJS.enc.Hex.parse(DES_IV_HEX);
  const decrypted = CryptoJS.DES.decrypt(
    { ciphertext: CryptoJS.enc.Base64.parse(base64Cipher) },
    key,
    { iv, mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 }
  );
  return decrypted.toString(CryptoJS.enc.Utf8);
}

function buildBody(mailNoList) {
  const timestampMs = Date.now();
  const businessData = {
    mailNoList,
    customerCode: CUSTOMER_CODE,
    platformSource: PLATFORM_SOURCE,
  };
  const dataStr = JSON.stringify(businessData);
  const sign = md5(String(timestampMs) + SECRET_KEY + dataStr);
  const bodyObj = { data: businessData, sign };
  const bodyStr = JSON.stringify(bodyObj);
  const encrypted = desEncrypt(bodyStr, SECRET_KEY);
  return { encrypted, timestampMs };
}

/** 把 fetch / 底层 TLS 错误链打平，便于 Vercel Logs → Messages 里看到 ETIMEDOUT 等 */
function serializeErrorChain(err) {
  if (!err) return '';
  const parts = [err.message || String(err)];
  let c = err.cause;
  for (let i = 0; c && i < 6; i += 1) {
    const code = c.code ? ` [${c.code}]` : '';
    parts.push(`cause: ${c.message || String(c)}${code}`);
    c = c.cause;
  }
  return parts.join(' | ');
}

async function callSpeedaf(mailNoList) {
  const { encrypted, timestampMs } = buildBody(mailNoList);
  const url = `${SPEEDAF_URL}?appCode=${encodeURIComponent(APP_CODE)}&timestamp=${timestampMs}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: encrypted,
  });
  const text = await res.text();
  let raw;
  try {
    raw = text ? JSON.parse(text) : {};
  } catch (parseErr) {
    throw new Error(`Speedaf non-JSON (${res.status}): ${text.slice(0, 200)}`);
  }
  if (raw && raw.success === true && typeof raw.data === 'string') {
    const decrypted = desDecrypt(raw.data, SECRET_KEY);
    return JSON.parse(decrypted);
  }
  return raw;
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

/** Vercel 上 body 可能是 object / string / Buffer，统一解析为对象 */
function parseJsonBody(req) {
  const b = req.body;
  if (b == null || b === '') return {};
  if (Buffer.isBuffer(b)) {
    try {
      return JSON.parse(b.toString('utf8'));
    } catch (_) {
      return {};
    }
  }
  if (typeof b === 'string') {
    try {
      return JSON.parse(b);
    } catch (_) {
      return {};
    }
  }
  if (typeof b === 'object') return b;
  return {};
}

module.exports = async (req, res) => {
  Object.entries(corsHeaders()).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  // 浏览器地址栏打开是 GET，并非故障；仅 POST 才会查单号
  if (req.method === 'GET' || req.method === 'HEAD') {
    res.status(200).json({
      ok: true,
      service: 'hkxh-track / Speedaf proxy',
      note:
        '地址栏访问为 GET，本接口只接受 POST。请在官网页面输入单号点击查询；或用 curl/Postman POST JSON。',
      noteEn:
        'Browser URL bar sends GET; this API only accepts POST. Use the site’s query button, or POST JSON via curl/Postman.',
      post: {
        method: 'POST',
        'Content-Type': 'application/json',
        bodyExample: { trackingNumber: 'YOUR_MAIL_NO' },
        bodyExampleAlt: { mailNoList: ['YOUR_MAIL_NO'] },
      },
    });
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ success: false, error: { message: 'Method not allowed' } });
    return;
  }
  let mailNoList = [];
  try {
    const body = parseJsonBody(req);
    if (Array.isArray(body.mailNoList)) {
      mailNoList = body.mailNoList.filter(Boolean);
    } else if (body.trackingNumber) {
      mailNoList = [String(body.trackingNumber).trim()];
    }
  } catch (_) {
    res.status(400).json({ success: false, error: { message: 'Invalid JSON body' } });
    return;
  }
  if (mailNoList.length === 0) {
    res.status(400).json({ success: false, error: { message: 'mailNoList or trackingNumber required' } });
    return;
  }
  try {
    const data = await callSpeedaf(mailNoList);
    res.status(200).json(data);
  } catch (e) {
    const chain = serializeErrorChain(e);
    console.error('[api/track] Speedaf proxy error:', chain || e);
    res.status(500).json({
      success: false,
      error: {
        code: '500',
        message: e.message || 'Proxy error',
        // 便于远程排查；不含密钥。部署稳定后可删 detail
        detail: chain || undefined,
      },
    });
  }
};
