/**
 * Vercel Serverless 代理：Speedaf / 燕文 / Kingtrans(K5)，避免浏览器 CORS 与密钥外露
 * 前端 POST /api/track
 *   合并: { provider: "auto", trackingNumber } — 依次：速达非 → 燕文(若已配) → Kingtrans(若已配)
 *   Kingtrans 文档: https://api.kingtrans.net/doc-2704479 ，查询轨迹 method=searchTrack
 *   https://api.kingtrans.net/api-106210993
 *
 * 环境变量:
 *   YW56_AUTHORIZATION — 燕文轨迹 Authorization
 *   KINGTRANS_API_BASE — 可选覆盖；默认 https://fhex.kingtrans.cn（接口仅支持 POST，地址栏 GET 会 405）
 *   KINGTRANS_CLIENT_ID、KINGTRANS_TOKEN — K5 客户编码与秘钥（勿暴露到前端）
 *   SZ56T_API_BASE — 华磊/sz56t 的 URL1 根地址；轨迹为 POST .../selectTrack.htm?documentCode=
 *       （依赖 iconv-lite：响应体多为 GB18030/GBK，代理内自动择码再 JSON.parse，避免中文乱码）
 *   WMS_SERVICE_URL — WMS「获取订单跟踪记录」完整 POST 地址（…/PublicService.asmx/ServiceInterfaceUTF8）
 *   WMS_APP_TOKEN、WMS_APP_KEY — 货代 API 账号与密码（见文档 gettrack）
 *     文档：http://183.56.242.72:6007/usercenter/manager/api_document.aspx#gettrack
 */
const crypto = require('crypto');
const dns = require('dns');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const querystring = require('querystring');
const CryptoJS = require('crypto-js');
const iconv = require('iconv-lite');

/**
 * ENOTFOUND 时检查域名是否为官方 **apis.speedaf.com**（带 s），勿用 api.speedaf.com。
 * 1) 可选 TRACK_DNS_SERVERS=223.5.5.5,114.114.114.114（逗号分隔）
 * 2) 先 dns.lookup；仍失败则走 DoH（1.1.1.1 / 8.8.8.8 直连 IP + SNI），绕过 Vercel 本地解析器
 * 3) 若 DoH 也无 A 记录，说明公网可能没有该域名 → 问速达非要正式地址或改用腾讯云 SCF
 */
if (process.env.TRACK_DNS_SERVERS) {
  const list = process.env.TRACK_DNS_SERVERS.split(',').map((s) => s.trim()).filter(Boolean);
  if (list.length) dns.setServers(list);
}

/** 与 Speedaf 文档一致；勿用 Node crypto DES（Node 18+/OpenSSL 3 默认不支持 des-cbc） */
const DES_IV_HEX = '1234567890abcdef';
const APP_CODE = process.env.SPEEDAF_APP_CODE || 'CN000796';
const SECRET_KEY = process.env.SPEEDAF_SECRET_KEY || 'Ty2pi72K';
/** 正式环境见文档：https://apis.speedaf.com/doc/zh-cn/track_query.html */
const SPEEDAF_URL = 'https://apis.speedaf.com/open-api/express/track/query';

/**
 * 燕文轨迹接口：官方文档正式环境为 http://（非 https）。用 https 时常见证书与主机名不匹配
 * （解析到 CDN 通配证书）。需 https 时可设环境变量 YW56_TRACK_BASE。
 */
const YW56_TRACK_BASE =
  process.env.YW56_TRACK_BASE || 'http://api.track.yw56.com.cn/api/tracking';
const YW56_AUTHORIZATION = process.env.YW56_AUTHORIZATION || '';

const KINGTRANS_API_BASE = (
  process.env.KINGTRANS_API_BASE || 'https://fhex.kingtrans.cn'
).trim().replace(/\/$/, '');
const KINGTRANS_CLIENT_ID = (process.env.KINGTRANS_CLIENT_ID || '').trim();
const KINGTRANS_TOKEN = (process.env.KINGTRANS_TOKEN || '').trim();

/** 华磊物流通 URL1（轨迹等），当前：http://hx.hailei2018.com:8082；仍以环境变量 SZ56T_API_BASE 为准 */
const SZ56T_API_BASE = (process.env.SZ56T_API_BASE || '').trim().replace(/\/$/, '');

const WMS_SERVICE_URL = (process.env.WMS_SERVICE_URL || '').trim();
const WMS_APP_TOKEN = (process.env.WMS_APP_TOKEN || '').trim();
const WMS_APP_KEY = (process.env.WMS_APP_KEY || '').trim();

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

/** 轨迹查询 data 仅含 mailNoList，见 https://apis.speedaf.com/doc/zh-cn/ 加签示例，否则 signature error 60004 */
function buildBody(mailNoList) {
  const timestampMs = Date.now();
  const businessData = { mailNoList };
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

/** 通过固定 IP 访问 DoH，避免再依赖「解析 DoH 域名」 */
function dohQueryJson(ip, servername, pathWithQuery) {
  return new Promise((resolve, reject) => {
    const opts = {
      host: ip,
      port: 443,
      path: pathWithQuery,
      method: 'GET',
      servername,
      headers: {
        Host: servername,
        accept: 'application/dns-json',
      },
    };
    https
      .get(opts, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            const text = Buffer.concat(chunks).toString('utf8');
            resolve(text ? JSON.parse(text) : {});
          } catch (e) {
            reject(e);
          }
        });
      })
      .on('error', reject);
  });
}

function pickAFromDohAnswer(json) {
  if (!json || json.Status !== 0) return null;
  const answers = json.Answer || [];
  const aRecords = answers.filter((x) => x.type === 1 && x.data);
  if (!aRecords.length) return null;
  return aRecords[aRecords.length - 1].data;
}

/**
 * 先系统/自定义 DNS；ENOTFOUND 时用 Cloudflare/Google DoH 取 A 记录
 */
async function resolveHostToIPv4(hostname) {
  try {
    const { address } = await dns.promises.lookup(hostname, { family: 4 });
    return address;
  } catch (err) {
    if (err.code !== 'ENOTFOUND') throw err;
    if (process.env.TRACK_DISABLE_DOH === '1' || process.env.TRACK_DISABLE_DOH === 'true') {
      throw err;
    }
    let last = err.message;
    try {
      const j1 = await dohQueryJson(
        '1.1.1.1',
        'cloudflare-dns.com',
        `/dns-query?name=${encodeURIComponent(hostname)}&type=A`
      );
      const ip1 = pickAFromDohAnswer(j1);
      if (ip1) return ip1;
      last = `Cloudflare DoH Status=${j1.Status}`;
    } catch (e) {
      last = e.message || String(e);
    }
    try {
      const j2 = await dohQueryJson(
        '8.8.8.8',
        'dns.google',
        `/resolve?name=${encodeURIComponent(hostname)}&type=A`
      );
      const ip2 = pickAFromDohAnswer(j2);
      if (ip2) return ip2;
      last = `Google DoH Status=${j2.Status}`;
    } catch (e) {
      last = e.message || String(e);
    }
    throw new Error(
      `ENOTFOUND ${hostname}（本地 DNS 与 DoH 均未得到 A 记录）。${last}。请向速达非确认正式 API 域名，或使用国内云函数代理。`
    );
  }
}

function httpsPostToIp(urlString, plainBody, targetIp) {
  const u = new URL(urlString);
  const bodyBuf = Buffer.from(plainBody, 'utf8');
  return new Promise((resolve, reject) => {
    const opts = {
      host: targetIp,
      port: 443,
      path: `${u.pathname}${u.search}`,
      method: 'POST',
      servername: u.hostname,
      headers: {
        Host: u.hostname,
        'Content-Type': 'text/plain',
        'Content-Length': String(bodyBuf.length),
      },
    };
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({
          status: res.statusCode || 0,
          text: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.on('error', reject);
    req.write(bodyBuf);
    req.end();
  });
}

async function httpsPostSpeedaf(urlString, plainBody) {
  const u = new URL(urlString);
  const address = await resolveHostToIPv4(u.hostname);
  return httpsPostToIp(urlString, plainBody, address);
}

function httpOrHttpsGetText(urlString, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlString);
    const isHttps = u.protocol === 'https:';
    const defaultPort = isHttps ? 443 : 80;
    const port = u.port ? Number(u.port) : defaultPort;
    const lib = isHttps ? https : http;
    const hostHeader = u.port ? `${u.hostname}:${u.port}` : u.hostname;
    const opts = {
      hostname: u.hostname,
      port,
      path: `${u.pathname}${u.search}`,
      method: 'GET',
      headers: { Host: hostHeader, ...(headers || {}) },
    };
    const req = lib.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({
          status: res.statusCode || 0,
          text: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

/** Kingtrans K5：POST JSON 至 .../PostInterfaceService?method=searchTrack */
function httpPostJson(urlString, bodyObj) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlString);
    const isHttps = u.protocol === 'https:';
    const bodyBuf = Buffer.from(JSON.stringify(bodyObj), 'utf8');
    const lib = isHttps ? https : http;
    const defaultPort = isHttps ? 443 : 80;
    const port = u.port ? Number(u.port) : defaultPort;
    const pathQuery = `${u.pathname}${u.search}`;
    const hostHeader = u.port ? `${u.hostname}:${u.port}` : u.hostname;
    const opts = {
      hostname: u.hostname,
      port,
      path: pathQuery,
      method: 'POST',
      headers: {
        Host: hostHeader,
        'Content-Type': 'application/json;charset=UTF-8',
        'Content-Length': String(bodyBuf.length),
        Accept: 'application/json',
      },
    };
    const req = lib.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({
          status: res.statusCode || 0,
          text: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.on('error', reject);
    req.write(bodyBuf);
    req.end();
  });
}

/** WMS：POST application/x-www-form-urlencoded */
function httpPostFormUrlEncoded(urlString, bodyUtf8String) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlString);
    const isHttps = u.protocol === 'https:';
    const bodyBuf = Buffer.from(bodyUtf8String, 'utf8');
    const lib = isHttps ? https : http;
    const defaultPort = isHttps ? 443 : 80;
    const port = u.port ? Number(u.port) : defaultPort;
    const pathQuery = `${u.pathname}${u.search}`;
    const hostHeader = u.port ? `${u.hostname}:${u.port}` : u.hostname;
    const opts = {
      hostname: u.hostname,
      port,
      path: pathQuery,
      method: 'POST',
      headers: {
        Host: hostHeader,
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'Content-Length': String(bodyBuf.length),
        Accept: 'application/json, text/plain, */*',
      },
    };
    const req = lib.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({
          status: res.statusCode || 0,
          text: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.on('error', reject);
    req.write(bodyBuf);
    req.end();
  });
}

/** 华磊 selectTrack.htm：文档要求 POST，参数在 query */
function httpPostEmpty(urlString) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlString);
    const isHttps = u.protocol === 'https:';
    const lib = isHttps ? https : http;
    const defaultPort = isHttps ? 443 : 80;
    const port = u.port ? Number(u.port) : defaultPort;
    const pathQuery = `${u.pathname}${u.search}`;
    const hostHeader = u.port ? `${u.hostname}:${u.port}` : u.hostname;
    const opts = {
      hostname: u.hostname,
      port,
      path: pathQuery,
      method: 'POST',
      headers: {
        Host: hostHeader,
        'Content-Length': '0',
        Accept: '*/*',
      },
    };
    const req = lib.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({
          status: res.statusCode || 0,
          buffer: Buffer.concat(chunks),
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

/** 华磊 JSON 常为 GB18030/GBK 字节，按 UTF-8 解会中文乱码；在可解析前提下选 CJK 更多的解码 */
function scoreCjkCharsInJsonTree(obj) {
  let n = 0;
  const visit = (v) => {
    if (typeof v === 'string') {
      for (let i = 0; i < v.length; i++) {
        const c = v.charCodeAt(i);
        if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf)) n += 1;
      }
    } else if (Array.isArray(v)) {
      for (let k = 0; k < v.length; k++) visit(v[k]);
    } else if (v && typeof v === 'object') {
      const keys = Object.keys(v);
      for (let k = 0; k < keys.length; k++) visit(v[keys[k]]);
    }
  };
  visit(obj);
  return n;
}

function decodeSz56tJsonBuffer(buf) {
  if (!buf || buf.length === 0) return '';
  const utf8 = buf.toString('utf8');
  const gbStr = iconv.decode(buf, 'gb18030');
  let utfParsed = null;
  let gbParsed = null;
  try {
    utfParsed = JSON.parse(utf8);
  } catch (_) {
    utfParsed = null;
  }
  try {
    gbParsed = JSON.parse(gbStr);
  } catch (_) {
    gbParsed = null;
  }
  if (gbParsed && !utfParsed) return gbStr;
  if (utfParsed && !gbParsed) return utf8;
  if (!utfParsed && !gbParsed) return utf8;
  if (utfParsed && gbParsed) {
    const su = scoreCjkCharsInJsonTree(utfParsed);
    const sg = scoreCjkCharsInJsonTree(gbParsed);
    if (sg > su) return gbStr;
  }
  return utf8;
}

function isSpeedafEffectivelyEmpty(raw) {
  if (raw == null) return true;
  if (typeof raw.success === 'boolean' && !raw.success) return true;
  let data = raw;
  if (raw.data !== undefined) data = raw.data;
  if (!Array.isArray(data) || data.length === 0) return true;
  const tracks = data[0] && data[0].tracks;
  return !Array.isArray(tracks) || tracks.length === 0;
}

/** 仅 result 非空不够：燕文可能对非本渠道单号返回壳数据但 checkpoints 为空，需让后续 Kingtrans 有机会查询 */
function isYanwenHasUsableResult(yw) {
  if (!yw || (yw.code !== 0 && yw.code !== '0')) return false;
  if (!Array.isArray(yw.result) || yw.result.length === 0) return false;
  return yw.result.some((r) => {
    if (!r) return false;
    const cps = r.checkpoints;
    return Array.isArray(cps) && cps.length > 0;
  });
}

function kingtransEnvReady() {
  return !!(KINGTRANS_API_BASE && KINGTRANS_CLIENT_ID && KINGTRANS_TOKEN);
}

function sz56tEnvReady() {
  return !!SZ56T_API_BASE;
}

/** 接口可能返回顶层 [{ ack, data }]，也可能返回 { data: [...] }（无 ack） */
function normalizeSz56tResponse(raw) {
  if (raw == null) return raw;
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'object' && Array.isArray(raw.data)) {
    return [{ ack: 'true', data: raw.data }];
  }
  return raw;
}

function isSz56tHasUsableResult(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return false;
  const h = arr[0];
  if (!h || String(h.ack).toLowerCase() !== 'true') return false;
  const d = h.data;
  if (!Array.isArray(d) || d.length === 0) return false;
  const row = d[0];
  if (Array.isArray(row.trackDetails) && row.trackDetails.length > 0) return true;
  if (Array.isArray(row.childrenTrackDetails) && row.childrenTrackDetails.length > 0) {
    return true;
  }
  if (row.trackContent || row.trackDate) return true;
  return false;
}

function isKingtransHasUsableResult(raw) {
  if (!raw) return false;
  const sc = String(raw.statusCode || '').toLowerCase();
  if (sc && sc !== 'success') return false;
  const rd = raw.returnDatas;
  if (!Array.isArray(rd) || rd.length === 0) return false;
  const first = rd[0];
  const isc = String(first.statusCode || '').toLowerCase();
  if (isc && isc !== 'success') return false;
  const items = first.items;
  if (Array.isArray(items) && items.length > 0) return true;
  if (first.track && (first.track.status || first.track.dateTime)) return true;
  return false;
}

async function callKingtransTrack(mailNoList) {
  if (!kingtransEnvReady()) {
    throw new Error(
      'Kingtrans(K5) 未配置：请在环境中设置 KINGTRANS_CLIENT_ID、KINGTRANS_TOKEN（可选 KINGTRANS_API_BASE 覆盖默认地址）'
    );
  }
  const url = `${KINGTRANS_API_BASE}/PostInterfaceService?method=searchTrack`;
  const Datas = mailNoList
    .slice(0, 30)
    .map((s) => String(s).trim())
    .filter(Boolean)
    .map((TrackNumber) => ({ TrackNumber }));
  if (!Datas.length) throw new Error('Empty tracking numbers');
  const payload = {
    Verify: { Clientid: KINGTRANS_CLIENT_ID, Token: KINGTRANS_TOKEN },
    Datas,
  };
  const { status, text } = await httpPostJson(url, payload);
  let raw;
  try {
    raw = text ? JSON.parse(text) : {};
  } catch (_) {
    throw new Error(`Kingtrans non-JSON (HTTP ${status}): ${text.slice(0, 200)}`);
  }
  if (status < 200 || status >= 300) {
    throw new Error(
      `Kingtrans HTTP ${status}: ${(raw && raw.message) || text.slice(0, 200)}`
    );
  }
  return raw;
}

async function callSz56tTrack(mailNoList) {
  if (!sz56tEnvReady()) {
    throw new Error(
      '华磊/sz56t 轨迹未配置：请在环境中设置 SZ56T_API_BASE（文档 URL1 根地址，无末尾斜杠）'
    );
  }
  const code = mailNoList.map((s) => String(s).trim()).filter(Boolean)[0];
  if (!code) throw new Error('Empty tracking number');
  const url = `${SZ56T_API_BASE}/selectTrack.htm?documentCode=${encodeURIComponent(code)}`;
  const { status, buffer } = await httpPostEmpty(url);
  const text = decodeSz56tJsonBuffer(buffer);
  let raw;
  try {
    raw = text ? JSON.parse(text) : [];
  } catch (_) {
    throw new Error(`sz56t non-JSON (HTTP ${status}): ${text.slice(0, 200)}`);
  }
  if (status < 200 || status >= 300) {
    throw new Error(`sz56t HTTP ${status}: ${text.slice(0, 200)}`);
  }
  raw = normalizeSz56tResponse(raw);
  if (!Array.isArray(raw)) {
    throw new Error('sz56t: 无法解析为轨迹数组（需顶层数组或含 data 数组的对象）');
  }
  return raw;
}

function wmsEnvReady() {
  return !!(WMS_SERVICE_URL && WMS_APP_TOKEN && WMS_APP_KEY);
}

function isWmsGetTrackUsable(raw) {
  if (!raw || Number(raw.success) !== 1) return false;
  const data = raw.data;
  if (!Array.isArray(data) || data.length === 0) return false;
  const first = data[0];
  if (!first || typeof first !== 'object') return false;
  const dets = first.details;
  if (Array.isArray(dets) && dets.length > 0) return true;
  if (first.track_status_name || first.server_hawbcode) return true;
  return false;
}

async function callWmsGetTrack(mailNoList) {
  if (!wmsEnvReady()) {
    throw new Error(
      'WMS gettrack 未配置：请在环境中设置 WMS_SERVICE_URL、WMS_APP_TOKEN、WMS_APP_KEY'
    );
  }
  const code = mailNoList.map((s) => String(s).trim()).filter(Boolean)[0];
  if (!code) throw new Error('Empty tracking number');
  const paramsJson = JSON.stringify({ tracking_number: code });
  const formBody = querystring.stringify({
    appToken: WMS_APP_TOKEN,
    appKey: WMS_APP_KEY,
    serviceMethod: 'gettrack',
    paramsJson,
  });
  const { status, text } = await httpPostFormUrlEncoded(WMS_SERVICE_URL, formBody);
  let raw;
  try {
    raw = text ? JSON.parse(text) : {};
  } catch (_) {
    throw new Error(`WMS gettrack non-JSON (HTTP ${status}): ${text.slice(0, 200)}`);
  }
  if (status < 200 || status >= 300) {
    throw new Error(`WMS gettrack HTTP ${status}: ${(raw && raw.cnmessage) || text.slice(0, 200)}`);
  }
  return raw;
}

async function resolveAutoTrack(mailNoList) {
  const speedafRaw = await callSpeedaf(mailNoList);
  if (!isSpeedafEffectivelyEmpty(speedafRaw)) return speedafRaw;

  if (YW56_AUTHORIZATION) {
    try {
      const yw = await callYanwenTracking(mailNoList);
      if (isYanwenHasUsableResult(yw)) {
        return { __autoProvider: 'yanwen', ...yw };
      }
    } catch (err) {
      console.error('[api/track] auto fallback yanwen:', err.message || err);
    }
  }

  if (kingtransEnvReady()) {
    try {
      const kt = await callKingtransTrack(mailNoList);
      if (isKingtransHasUsableResult(kt)) {
        return { __autoProvider: 'kingtrans', ...kt };
      }
    } catch (err) {
      console.error('[api/track] auto fallback kingtrans:', err.message || err);
    }
  }

  if (sz56tEnvReady()) {
    try {
      const sz = await callSz56tTrack(mailNoList);
      if (isSz56tHasUsableResult(sz)) {
        return { __autoProvider: 'sz56t', sz56t: sz };
      }
    } catch (err) {
      console.error('[api/track] auto fallback sz56t:', err.message || err);
    }
  }

  if (wmsEnvReady()) {
    try {
      const wms = await callWmsGetTrack(mailNoList);
      if (isWmsGetTrackUsable(wms)) {
        return { __autoProvider: 'wms', wms };
      }
    } catch (err) {
      console.error('[api/track] auto fallback wms gettrack:', err.message || err);
    }
  }

  return speedafRaw;
}

async function callYanwenTracking(mailNoList) {
  if (!YW56_AUTHORIZATION) {
    throw new Error(
      '服务端未配置燕文轨迹授权：请在 Vercel / 部署环境中设置环境变量 YW56_AUTHORIZATION（商户号或制单账号）'
    );
  }
  const list = mailNoList.slice(0, 30).map((s) => String(s).trim()).filter(Boolean);
  if (!list.length) throw new Error('Empty tracking numbers');
  const nums = list.join(',');
  const url = `${YW56_TRACK_BASE.replace(/\/$/, '')}?nums=${encodeURIComponent(nums)}`;
  const { status, text } = await httpOrHttpsGetText(url, {
    Authorization: YW56_AUTHORIZATION,
    Accept: 'application/json',
  });
  let raw;
  try {
    raw = text ? JSON.parse(text) : {};
  } catch (_) {
    throw new Error(`Yanwen non-JSON (HTTP ${status}): ${text.slice(0, 200)}`);
  }
  if (status < 200 || status >= 300) {
    throw new Error(
      `Yanwen HTTP ${status}: ${(raw && raw.message) || text.slice(0, 200)}`
    );
  }
  return raw;
}

async function callSpeedaf(mailNoList) {
  const { encrypted, timestampMs } = buildBody(mailNoList);
  const url = `${SPEEDAF_URL}?appCode=${encodeURIComponent(APP_CODE)}&timestamp=${timestampMs}`;
  const { status, text } = await httpsPostSpeedaf(url, encrypted);
  let raw;
  try {
    raw = text ? JSON.parse(text) : {};
  } catch (parseErr) {
    throw new Error(`Speedaf non-JSON (${status}): ${text.slice(0, 200)}`);
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
      service: 'hkxh-track / Speedaf + Yanwen + Kingtrans + sz56t + WMS gettrack proxy',
      note:
        '地址栏访问为 GET，本接口只接受 POST。请在官网页面输入单号点击查询；或用 curl/Postman POST JSON。',
      noteEn:
        'Browser URL bar sends GET; this API only accepts POST. Use the site’s query button, or POST JSON via curl/Postman.',
      post: {
        method: 'POST',
        'Content-Type': 'application/json',
        bodyExample: { trackingNumber: 'YOUR_MAIL_NO' },
        bodyExampleAlt: { mailNoList: ['YOUR_MAIL_NO'] },
        bodyYanwen: { provider: 'yanwen', trackingNumber: 'YOUR_YW_NO' },
        bodyAuto: {
          provider: 'auto',
          trackingNumber: ' TRY_ORDER_SPEEDAF_YANWEN_KINGTRANS',
        },
        bodyKingtrans: { provider: 'kingtrans', trackingNumber: 'YOUR_NO' },
        bodySz56t: {
          provider: 'sz56t',
          trackingNumber: 'YOUR_NO',
          env: 'SZ56T_API_BASE required',
        },
        bodyWms: {
          provider: 'wms',
          trackingNumber: '服务商单号',
          env: 'WMS_SERVICE_URL + WMS_APP_TOKEN + WMS_APP_KEY',
        },
      },
    });
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ success: false, error: { message: 'Method not allowed' } });
    return;
  }
  let mailNoList = [];
  let body = {};
  try {
    body = parseJsonBody(req);
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
  const provider = String(body.provider || 'speedaf')
    .toLowerCase()
    .trim();
  try {
    let data;
    if (provider === 'auto' || provider === 'merge') {
      data = await resolveAutoTrack(mailNoList);
    } else if (provider === 'yanwen' || provider === 'yw56' || provider === 'yw') {
      data = await callYanwenTracking(mailNoList);
    } else if (provider === 'kingtrans' || provider === 'k5') {
      data = await callKingtransTrack(mailNoList);
    } else if (provider === 'sz56t' || provider === 'hualei') {
      data = await callSz56tTrack(mailNoList);
    } else if (provider === 'wms' || provider === 'gettrack') {
      data = await callWmsGetTrack(mailNoList);
    } else {
      data = await callSpeedaf(mailNoList);
    }
    res.status(200).json(data);
  } catch (e) {
    const chain = serializeErrorChain(e);
    console.error('[api/track] proxy error:', chain || e);
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
