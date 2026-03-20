/**
 * 腾讯云 SCF：正式环境域名 **apis.speedaf.com**（见官方文档 track_query）
 *
 * 部署后：推荐「函数 URL」触发器（API 网关触发器已停售新建）。
 * 前端 TRACK_PROXY = 控制台给出的完整 HTTPS 地址（通常无 /api/track 路径）。
 *
 * 环境变量（函数配置 → 环境变量）：
 * SPEEDAF_APP_CODE, SPEEDAF_SECRET_KEY, SPEEDAF_CUSTOMER_CODE, SPEEDAF_PLATFORM_SOURCE
 */
const crypto = require('crypto');
const CryptoJS = require('crypto-js');

const DES_IV_HEX = '1234567890abcdef';
const APP_CODE = process.env.SPEEDAF_APP_CODE || 'CN000796';
const SECRET_KEY = process.env.SPEEDAF_SECRET_KEY || 'Ty2pi72K';
const CUSTOMER_CODE = process.env.SPEEDAF_CUSTOMER_CODE || 'CN000796';
const PLATFORM_SOURCE = process.env.SPEEDAF_PLATFORM_SOURCE || 'HKXH';
const SPEEDAF_URL = 'https://apis.speedaf.com/open-api/express/track/query';

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
  } catch (_) {
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
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function parseEventBody(event) {
  let raw = event.body;
  if (raw == null) return {};
  if (event.isBase64Encoded && typeof raw === 'string') {
    raw = Buffer.from(raw, 'base64').toString('utf8');
  }
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw || '{}');
    } catch (_) {
      return {};
    }
  }
  return raw && typeof raw === 'object' ? raw : {};
}

function getMethod(event) {
  return (
    event.httpMethod ||
    event.requestContext?.http?.method ||
    event.requestContext?.httpMethod ||
    'GET'
  );
}

function jsonResponse(statusCode, obj) {
  return {
    statusCode,
    headers: corsHeaders(),
    body: JSON.stringify(obj),
  };
}

exports.main_handler = async (event) => {
  const method = getMethod(event).toUpperCase();
  const headers = corsHeaders();

  if (method === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  // 与 Vercel /api/track GET 一致，便于浏览器探活
  if (method === 'GET' || method === 'HEAD') {
    return jsonResponse(200, {
      ok: true,
      service: 'hkxh-track / Tencent SCF → Speedaf',
      note: '请使用 POST，Content-Type: application/json，body: { "mailNoList": ["单号"] } 或 { "trackingNumber": "单号" }',
    });
  }

  if (method !== 'POST') {
    return jsonResponse(405, { success: false, error: { message: 'Method not allowed' } });
  }

  const body = parseEventBody(event);
  let mailNoList = [];
  if (Array.isArray(body.mailNoList)) {
    mailNoList = body.mailNoList.filter(Boolean);
  } else if (body.trackingNumber) {
    mailNoList = [String(body.trackingNumber).trim()];
  }

  if (mailNoList.length === 0) {
    return jsonResponse(400, {
      success: false,
      error: { message: 'mailNoList or trackingNumber required' },
    });
  }

  try {
    const data = await callSpeedaf(mailNoList);
    return jsonResponse(200, data);
  } catch (e) {
    const detail = serializeErrorChain(e);
    console.error('[scf/track] error:', detail || e);
    return jsonResponse(500, {
      success: false,
      error: {
        code: '500',
        message: e.message || 'Proxy error',
        detail: detail || undefined,
      },
    });
  }
};
