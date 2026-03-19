/**
 * Vercel Serverless 代理：转发轨迹查询到 Speedaf，解决浏览器 CORS 限制
 * 前端 POST /api/track，body: { mailNoList: ["单号"] } 或 { trackingNumber: "单号" }
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
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

module.exports = async (req, res) => {
  Object.entries(corsHeaders()).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ success: false, error: { message: 'Method not allowed' } });
    return;
  }
  let mailNoList = [];
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
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
    res.status(500).json({
      success: false,
      error: { code: '500', message: e.message || 'Proxy error' },
    });
  }
};
