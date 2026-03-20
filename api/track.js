/**
 * Vercel Serverless 代理：转发轨迹查询到 Speedaf，解决浏览器 CORS 限制
 * 前端 POST /api/track，body: { mailNoList: ["单号"] } 或 { trackingNumber: "单号" }
 */
const crypto = require('crypto');
const dns = require('dns');
const https = require('https');
const CryptoJS = require('crypto-js');

/**
 * Vercel 部分区域对 api.speedaf.com 会 getaddrinfo ENOTFOUND（本地解析器无记录）。
 * 可选：TRACK_DNS_SERVERS=223.5.5.5,114.114.114.114（对 undici fetch 不一定生效）
 * 代码会在 ENOTFOUND 时改用公共 DNS(JSON) 查 A 记录，再 https 直连并保留 SNI Host。
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

function chainHasEnotfound(err) {
  return serializeErrorChain(err).includes('ENOTFOUND');
}

/** 用 Google / Cloudflare 的 DNS JSON API 取 A 记录，不依赖本机解析 api.speedaf.com */
async function resolveARecordViaDoh(hostname) {
  const pickA = (j) => {
    const answers = j.Answer || [];
    const rec = answers.find((x) => x.type === 1 && x.data);
    if (!rec) return null;
    return String(rec.data).replace(/\.$/, '').trim();
  };
  const google = async () => {
    const r = await fetch(
      `https://dns.google/resolve?name=${encodeURIComponent(hostname)}&type=A`,
      { headers: { accept: 'application/dns-json' } }
    );
    if (!r.ok) throw new Error(`DoH Google HTTP ${r.status}`);
    const j = await r.json();
    const ip = pickA(j);
    if (!ip) throw new Error('DoH Google: no A record');
    return ip;
  };
  const cloudflare = async () => {
    const r = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=A`,
      { headers: { accept: 'application/dns-json' } }
    );
    if (!r.ok) throw new Error(`DoH Cloudflare HTTP ${r.status}`);
    const j = await r.json();
    const ip = pickA(j);
    if (!ip) throw new Error('DoH Cloudflare: no A record');
    return ip;
  };
  try {
    return await google();
  } catch (e1) {
    console.error('[api/track] DoH Google:', e1.message || e1);
    return await cloudflare();
  }
}

/** 连到解析出的 IP，TLS SNI/Host 仍为域名，证书校验通过 */
function httpsPostToIp(fullUrlString, bodyStr) {
  const u = new URL(fullUrlString);
  return resolveARecordViaDoh(u.hostname).then(
    (ip) =>
      new Promise((resolve, reject) => {
        const pathAndQuery = u.pathname + u.search;
        const opts = {
          hostname: ip,
          port: 443,
          path: pathAndQuery,
          method: 'POST',
          servername: u.hostname,
          headers: {
            Host: u.hostname,
            'Content-Type': 'text/plain',
            'Content-Length': Buffer.byteLength(bodyStr, 'utf8'),
          },
          rejectUnauthorized: true,
        };
        const req = https.request(opts, (incoming) => {
          const chunks = [];
          incoming.on('data', (c) => chunks.push(c));
          incoming.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            const status = incoming.statusCode || 0;
            resolve({
              ok: status >= 200 && status < 300,
              status,
              text: () => Promise.resolve(text),
            });
          });
        });
        req.on('error', reject);
        req.setTimeout(90000, () => {
          req.destroy(new Error('Speedaf https timeout'));
        });
        req.write(bodyStr);
        req.end();
      })
  );
}

async function postSpeedaf(fullUrl, encryptedBody) {
  try {
    return await fetch(fullUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: encryptedBody,
    });
  } catch (e) {
    if (!chainHasEnotfound(e)) throw e;
    console.error('[api/track] fetch ENOTFOUND, retry via DoH + https:', new URL(fullUrl).hostname);
    return httpsPostToIp(fullUrl, encryptedBody);
  }
}

async function callSpeedaf(mailNoList) {
  const { encrypted, timestampMs } = buildBody(mailNoList);
  const url = `${SPEEDAF_URL}?appCode=${encodeURIComponent(APP_CODE)}&timestamp=${timestampMs}`;
  const res = await postSpeedaf(url, encrypted);
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
