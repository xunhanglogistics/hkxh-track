/**
 * 腾讯云 SCF（云函数）+ API 网关：国内访问 Speedaf 轨迹代理
 * 部署后把 index.html 里 TRACK_PROXY 改为：https://api.你的域名.com/track
 *
 * 环境变量（函数配置里添加，勿写死在代码）：
 * SPEEDAF_APP_CODE, SPEEDAF_SECRET_KEY, SPEEDAF_CUSTOMER_CODE, SPEEDAF_PLATFORM_SOURCE
 */
const crypto = require('crypto');

const DES_IV = Buffer.from([0x12, 0x34, 0x56, 0x78, 0x90, 0xab, 0xcd, 0xef]);
const APP_CODE = process.env.SPEEDAF_APP_CODE || 'CN000796';
const SECRET_KEY = process.env.SPEEDAF_SECRET_KEY || 'Ty2pi72K';
const CUSTOMER_CODE = process.env.SPEEDAF_CUSTOMER_CODE || 'CN000796';
const PLATFORM_SOURCE = process.env.SPEEDAF_PLATFORM_SOURCE || 'HKXH';
const SPEEDAF_URL = 'https://api.speedaf.com/open-api/express/track/query';

function md5(str) {
  return crypto.createHash('md5').update(str, 'utf8').digest('hex').toLowerCase();
}

function desEncrypt(plainText, secretKey) {
  const key = Buffer.from(secretKey, 'utf8').slice(0, 8);
  const cipher = crypto.createCipheriv('des-cbc', key, DES_IV);
  cipher.setAutoPadding(true);
  const enc = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  return enc.toString('base64');
}

function desDecrypt(base64Cipher, secretKey) {
  const key = Buffer.from(secretKey, 'utf8').slice(0, 8);
  const buf = Buffer.from(base64Cipher, 'base64');
  const decipher = crypto.createDecipheriv('des-cbc', key, DES_IV);
  decipher.setAutoPadding(true);
  return Buffer.concat([decipher.update(buf), decipher.final()]).toString('utf8');
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

async function callSpeedaf(mailNoList) {
  const { encrypted, timestampMs } = buildBody(mailNoList);
  const url = `${SPEEDAF_URL}?appCode=${encodeURIComponent(APP_CODE)}&timestamp=${timestampMs}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: encrypted,
  });
  const raw = await res.json();
  if (raw && raw.success === true && typeof raw.data === 'string') {
    const decrypted = desDecrypt(raw.data, SECRET_KEY);
    return JSON.parse(decrypted);
  }
  return raw;
}

function corsHeaders() {
  return {
    'Content-Type': 'application/json',
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
  return raw || {};
}

function getMethod(event) {
  return (
    event.httpMethod ||
    event.requestContext?.http?.method ||
    event.requestContext?.httpMethod ||
    'GET'
  );
}

exports.main_handler = async (event) => {
  const method = getMethod(event).toUpperCase();
  const headers = corsHeaders();

  if (method === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (method !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ success: false, error: { message: 'Method not allowed' } }),
    };
  }

  const body = parseEventBody(event);
  let mailNoList = [];
  if (Array.isArray(body.mailNoList)) {
    mailNoList = body.mailNoList.filter(Boolean);
  } else if (body.trackingNumber) {
    mailNoList = [String(body.trackingNumber).trim()];
  }

  if (mailNoList.length === 0) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({
        success: false,
        error: { message: 'mailNoList or trackingNumber required' },
      }),
    };
  }

  try {
    const data = await callSpeedaf(mailNoList);
    return { statusCode: 200, headers, body: JSON.stringify(data) };
  } catch (e) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        success: false,
        error: { code: '500', message: e.message || 'Proxy error' },
      }),
    };
  }
};
