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
 *   越航 OIS 运单轨迹 queryTraceoutList（表单+签名 header）；auto 模式下在速达非无结果后优先尝试 OIS，再试燕文等（减少境外节点对国内接口逐个超时）
 *     OIS_PROJECT_URL、OIS_APP_KEY、OIS_APP_SECRET、OIS_COMPANY_NO
 *     可选 OIS_IS_TRANSLATE_EN；POST 带 lang（zh/en）时优先按界面语言映射 isTranslateEn（中文 0 / 英文 1）
 *     OIS_DEBUG=1 — 临时在 Vercel Logs 打印发往越航的 getAuth / queryTraceoutList 报文结构（含 token/sign，排查完请关闭）
 *     可选 OIS_TOKEN_NONCE — 写入 token 头内 JSON 的 nonce（默认 slnkda；若货代/SDK 用 request 等需与此一致）
 *     可选 OIS_TOKEN_INNER_ORDER=pdf|sorted — token 内 JSON 键顺序（默认 pdf 与文档 2.3.2 一致）
 *     可选 OIS_TOKEN_TIMESTAMP_STRING=1 — token 内 JSON 的 timestamp 序列化为字符串（与部分 FastJSON 行为一致）
 *     签名（Utils.java sign）：参与 MD5 的键为 body1、nonce、timestamp、token(明文 access token)、version（排序后拼接再 Base64+MD5）；与 HTTP 头里伪装后的 token 无关
 *     可选 OIS_TRACE_OMIT_IS_TRANSLATE=1 — 轨迹 body1 不传 isTranslateEn（仍 1005 时可试）
 *     可选 OIS_TRACE_BODY1_MINIMAL=1 — body1 仅 isTranslateEn+noList+queryType（不含 companyNo，与货代成功日志一致）；请配 OIS_QUERY_TYPE（如运单号用 1）
 *   华唯 / Waway：官网 GET 轨迹接口 URL 与 Referer 已写死在代码中（/pro/V1/Home/Track/{no}），无需环境变量；auto 链是否尝试由常量 WAWAY_IN_AUTO 控制
 *   货代轨迹门户 218.244.139.186:9999：先 GET /track 取 JSESSIONID，再 POST /trackList、/trackItem，带 Origin/Referer/Cookie（与浏览器 F12 一致）
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

/** 越航 OIS：默认生产 projectUrl，勿混用测试页 demo 地址 */
const OIS_PROJECT_URL = (process.env.OIS_PROJECT_URL || 'https://ois.yha56.com/').trim();
const OIS_APP_KEY = (process.env.OIS_APP_KEY || '').trim();
const OIS_APP_SECRET = (process.env.OIS_APP_SECRET || '').trim();
const OIS_COMPANY_NO = (process.env.OIS_COMPANY_NO || '').trim();
const OIS_QUERY_TYPE = (process.env.OIS_QUERY_TYPE || '99').trim();
/** 默认 1.0，与越航 Java Utils 示例签名字符串中 version= 一致 */
const OIS_HEADER_VERSION = (process.env.OIS_HEADER_VERSION || '1.0').trim();
/** token 头内 JSON 的 nonce；PDF 示例为 slnkda，部分货代环境为 request */
const OIS_TOKEN_NONCE = (process.env.OIS_TOKEN_NONCE || 'slnkda').trim();
/** pdf=文档 2.3.2 顺序；sorted=nonce,timestamp,token 字典序（仍 1005 时可试 OIS_TOKEN_INNER_ORDER=sorted） */
const OIS_TOKEN_INNER_ORDER = (process.env.OIS_TOKEN_INNER_ORDER || 'pdf').trim().toLowerCase();
const OIS_TOKEN_TIMESTAMP_STRING = /^1|true|yes$/i.test(
  String(process.env.OIS_TOKEN_TIMESTAMP_STRING || '').trim()
);
const OIS_TRACE_OMIT_IS_TRANSLATE = /^1|true|yes$/i.test(
  String(process.env.OIS_TRACE_OMIT_IS_TRANSLATE || '').trim()
);
/** 与货代成功样例一致：body1 不含 companyNo，仅 isTranslateEn、noList、queryType */
const OIS_TRACE_BODY1_MINIMAL = /^1|true|yes$/i.test(
  String(process.env.OIS_TRACE_BODY1_MINIMAL || '').trim()
);
const OIS_IS_TRANSLATE_EN = process.env.OIS_IS_TRANSLATE_EN;

/** 华唯官网货件追踪（与 F12 抓包一致，写死无需 env）；{no}/{noEnc} 在请求时替换为用户输入单号 */
const WAWAY_TRACK_URL_TEMPLATE = 'http://www.uhuawei.com/pro/V1/Home/Track/{no}';
const WAWAY_TRACK_REFERER = 'http://www.uhuawei.com/home/track';
const WAWAY_BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
/** 设为 false 可关闭 auto 链中的华唯回退（仅此一处开关，不读环境变量） */
const WAWAY_IN_AUTO = true;

/** http://218.244.139.186:9999/track — POST /trackList、/trackItem（与浏览器页面一致） */
const PORTAL218_BASE = 'http://218.244.139.186:9999';
const PORTAL218_REFERER = 'http://218.244.139.186:9999/track';
const PORTAL218_ORIGIN = 'http://218.244.139.186:9999';
const PORTAL218_SEARCH_FIELD =
  'border.systemnumber,border.customernumber1,border.waybillnumber,border.tracknumber,border.newtracknumber,border.fbanumber';
const PORTAL218_BROWSER_UA = WAWAY_BROWSER_UA;
/** 设为 false 可关闭 auto 链中对该门户的查询 */
const PORTAL218_IN_AUTO = true;

/** 设为 1/true 时打印越航请求详情到服务端日志（含伪装 token 与 sign，勿长期开启） */
const OIS_DEBUG = /^1|true|yes$/i.test(String(process.env.OIS_DEBUG || '').trim());

let oisTokenCache = { token: '', at: 0 };
const OIS_TOKEN_TTL_MS = 25 * 60 * 1000;

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

/** GET：返回 status、body、headers（用于取 Set-Cookie / JSESSIONID） */
function httpGetFullResponse(urlString, headers) {
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
          headers: res.headers,
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

/** 表单 POST，可带自定义 header（越航 OIS：token/sign/version） */
function httpPostFormUrlEncodedWithHeaders(urlString, bodyUtf8String, extraHeaders) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlString);
    const isHttps = u.protocol === 'https:';
    const bodyBuf = Buffer.from(bodyUtf8String, 'utf8');
    const lib = isHttps ? https : http;
    const defaultPort = isHttps ? 443 : 80;
    const port = u.port ? Number(u.port) : defaultPort;
    const pathQuery = `${u.pathname}${u.search}`;
    const hostHeader = u.port ? `${u.hostname}:${u.port}` : u.hostname;
    const baseH = {
      Host: hostHeader,
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      'Content-Length': String(bodyBuf.length),
      Accept: 'application/json, text/plain, */*',
    };
    const opts = {
      hostname: u.hostname,
      port,
      path: pathQuery,
      method: 'POST',
      headers: { ...baseH, ...(extraHeaders || {}) },
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

function oisProjectBase() {
  return OIS_PROJECT_URL.replace(/\/+$/, '');
}

function oisMaskTokenBase64(b64) {
  return String(b64).replace(/a/g, '-').replace(/c/g, '#').replace(/x/g, '^').replace(/M/g, '$');
}

/** @returns {{ masked: string, nonce: string, tsVal: number|string }} */
function oisBuildMaskedTokenHeader(realToken) {
  const ts = Date.now();
  const tsVal = OIS_TOKEN_TIMESTAMP_STRING ? String(ts) : ts;
  const n = OIS_TOKEN_NONCE;
  const inner =
    OIS_TOKEN_INNER_ORDER === 'sorted'
      ? { nonce: n, timestamp: tsVal, token: realToken }
      : { timestamp: tsVal, nonce: n, token: realToken };
  const payload = JSON.stringify(inner);
  const masked = oisMaskTokenBase64(Buffer.from(payload, 'utf8').toString('base64'));
  return { masked, nonce: n, tsVal };
}

function oisSortedSignString(paramMap) {
  const keys = Object.keys(paramMap).filter((k) => paramMap[k] != null && paramMap[k] !== '');
  keys.sort();
  return keys.map((k) => `${k}=${paramMap[k]}`).join('&');
}

function oisComputeSign(paramMap, appSecret) {
  const plain = oisSortedSignString(paramMap);
  const b64 = Buffer.from(plain, 'utf8').toString('base64');
  return crypto.createHash('md5').update(b64 + appSecret, 'utf8').digest('hex').toUpperCase();
}

function oisRedactAuthUrl(url) {
  return String(url).replace(/(appSecret=)([^&]*)/gi, '$1***');
}

function oisEnvReady() {
  if (!OIS_APP_KEY || !OIS_APP_SECRET) return false;
  if (OIS_TRACE_BODY1_MINIMAL) return true;
  return !!OIS_COMPANY_NO;
}

async function oisFetchAccessToken(forceRefresh) {
  const now = Date.now();
  if (
    !forceRefresh &&
    oisTokenCache.token &&
    now - oisTokenCache.at < OIS_TOKEN_TTL_MS
  ) {
    return oisTokenCache.token;
  }
  const base = oisProjectBase();
  const q = querystring.stringify({
    appKey: OIS_APP_KEY,
    appSecret: OIS_APP_SECRET,
  });
  const url = `${base}/ois/order/getAuth?${q}`;
  const { status, text } = await httpOrHttpsGetText(url, { Accept: 'application/json' });
  let raw;
  try {
    raw = text ? JSON.parse(text) : {};
  } catch (_) {
    throw new Error(`OIS getAuth non-JSON (HTTP ${status}): ${text.slice(0, 200)}`);
  }
  if (status < 200 || status >= 300) {
    throw new Error(`OIS getAuth HTTP ${status}: ${text.slice(0, 200)}`);
  }
  if (Number(raw.result_code) !== 0 || !raw.body || String(raw.body.ack).toLowerCase() !== 'true') {
    throw new Error(`OIS getAuth 失败: ${(raw && raw.message) || text.slice(0, 200)}`);
  }
  const tok = raw.body.token;
  if (!tok) throw new Error('OIS getAuth 未返回 token');
  oisTokenCache = { token: tok, at: now };
  return tok;
}

/** 官网语言 zh→0 中文描述，en→1 英文描述；未识别则返回 undefined（走环境变量 OIS_IS_TRANSLATE_EN） */
function oisResolveTranslateEnFromUiLang(lang) {
  if (lang == null || lang === '') return undefined;
  const s = String(lang).toLowerCase();
  if (s === 'zh' || s.startsWith('zh-')) return 0;
  if (s === 'en' || s.startsWith('en-')) return 1;
  return undefined;
}

/**
 * full：companyNo + queryType + noList +（可选）isTranslateEn（PDF 含 companyNo 时）
 * minimal：货代成功日志仅 {"isTranslateEn":0,"noList":"...","queryType":"1"}，无 companyNo
 */
function oisBody1ForTrace(no, isTranslateEnOverride) {
  let en = isTranslateEnOverride;
  if (en === undefined && OIS_IS_TRANSLATE_EN !== undefined && OIS_IS_TRANSLATE_EN !== '') {
    const n = parseInt(OIS_IS_TRANSLATE_EN, 10);
    if (!Number.isNaN(n)) en = n;
  }
  if (OIS_TRACE_BODY1_MINIMAL) {
    const obj = {
      isTranslateEn: en !== undefined && en !== null ? en : 0,
      noList: no,
      queryType: OIS_QUERY_TYPE,
    };
    if (OIS_TRACE_OMIT_IS_TRANSLATE) delete obj.isTranslateEn;
    return JSON.stringify(obj);
  }
  const obj = {
    companyNo: OIS_COMPANY_NO,
    queryType: OIS_QUERY_TYPE,
    noList: no,
  };
  if (!OIS_TRACE_OMIT_IS_TRANSLATE && en !== undefined && en !== null) obj.isTranslateEn = en;
  return JSON.stringify(obj);
}

function oisParseTraceJson(text, httpStatus) {
  let raw;
  try {
    raw = text ? JSON.parse(text) : {};
  } catch (_) {
    throw new Error(`OIS queryTraceoutList non-JSON (HTTP ${httpStatus}): ${text.slice(0, 200)}`);
  }
  return raw;
}

function oisShouldRetryResultCode(rc) {
  return rc === 1002 || rc === 1004 || rc === 1005;
}

function isOisTraceUsable(raw) {
  if (!raw || Number(raw.result_code) !== 0) return false;
  const body = raw.body;
  if (!Array.isArray(body) || body.length === 0) return false;
  return true;
}

async function callOisQueryTrace(mailNoList, attempt, oisOpts) {
  if (!oisEnvReady()) {
    throw new Error(
      '越航 OIS 轨迹未配置：请设置 OIS_APP_KEY、OIS_APP_SECRET（full 模式还需 OIS_COMPANY_NO；minimal 模式设 OIS_TRACE_BODY1_MINIMAL=1）'
    );
  }
  const opts = oisOpts && typeof oisOpts === 'object' ? oisOpts : {};
  const att = typeof attempt === 'number' ? attempt : 0;
  const code = mailNoList.map((s) => String(s).trim()).filter(Boolean)[0];
  if (!code) throw new Error('Empty tracking number');
  const realTok = await oisFetchAccessToken(att > 0);
  const { masked, nonce: oisNonce, tsVal } = oisBuildMaskedTokenHeader(realTok);
  const ver = OIS_HEADER_VERSION;
  const body1 = oisBody1ForTrace(code, opts.isTranslateEn);
  /** 与 com.yha.sdk.util.Utils.sign 一致：body1&nonce&timestamp&token&version（token 为明文 access token，非伪装串） */
  const sign = oisComputeSign(
    {
      body1,
      nonce: oisNonce,
      timestamp: tsVal,
      token: realTok,
      version: ver,
    },
    OIS_APP_SECRET
  );
  const formBody = querystring.stringify({ body1 });
  const url = `${oisProjectBase()}/tms/expose/queryTraceoutList`;
  if (OIS_DEBUG) {
    const sortedPlain = oisSortedSignString({
      body1,
      nonce: oisNonce,
      timestamp: tsVal,
      token: realTok,
      version: ver,
    });
    const b64Payload = Buffer.from(sortedPlain, 'utf8').toString('base64');
    console.log(
      '[OIS_DEBUG] queryTraceoutList',
      JSON.stringify(
        {
          method: 'POST',
          url,
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
            token: masked,
            sign,
            version: ver,
          },
          body: formBody,
          body1Decoded: body1,
          signSortedString: sortedPlain,
          signBase64Payload: b64Payload,
          signMd5HexUpper: sign,
        },
        null,
        2
      )
    );
  }
  const { status, text } = await httpPostFormUrlEncodedWithHeaders(url, formBody, {
    token: masked,
    sign,
    version: ver,
  });
  const raw = oisParseTraceJson(text, status);
  const rc = Number(raw.result_code);
  if (status >= 200 && status < 300 && oisShouldRetryResultCode(rc) && att < 1) {
    return callOisQueryTrace(mailNoList, att + 1, opts);
  }
  if (status < 200 || status >= 300) {
    throw new Error(`OIS queryTraceoutList HTTP ${status}: ${text.slice(0, 200)}`);
  }
  if (rc !== 0) {
    throw new Error(
      `OIS queryTraceoutList result_code=${rc}: ${(raw && raw.message) || text.slice(0, 200)}`
    );
  }
  return raw;
}

function expandWawayTemplate(s, code) {
  return String(s || '')
    .replace(/\{noEnc\}/gi, encodeURIComponent(code))
    .replace(/\{no\}/gi, code);
}

/** 从整段或 HTML 嵌入片段中解析出 JSON */
function wawayTryParseJsonFromResponse(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  if (t.startsWith('{') || t.startsWith('[')) {
    try {
      return JSON.parse(t);
    } catch (_) {
      /* 继续尝试嵌入 */
    }
  }
  const near = (key) => {
    const pos = t.indexOf(key);
    if (pos < 0) return null;
    for (let start = pos; start >= 0; start -= 1) {
      if (t[start] !== '{') continue;
      let depth = 0;
      for (let j = start; j < t.length; j += 1) {
        const ch = t[j];
        if (ch === '{') depth += 1;
        else if (ch === '}') {
          depth -= 1;
          if (depth === 0) {
            try {
              return JSON.parse(t.slice(start, j + 1));
            } catch (_) {
              break;
            }
          }
        }
      }
    }
    return null;
  };
  return near('"Datas"') || near('"datas"') || near('"Code"') || near('"createDate"');
}

/** 官网 GET /pro/V1/Home/Track/{no}：{ code, msg, data[{ createDate, description, location }] } */
function wawayFromProHomeTrackJson(raw, fallbackOrderNum) {
  const c = raw.code;
  if (c != null && Number(c) !== 0) {
    throw new Error(raw.msg || `华唯查询失败 code=${c}`);
  }
  const rows = Array.isArray(raw.data) ? raw.data : [];
  const tracks = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (!row || typeof row !== 'object') continue;
    let time = '';
    if (row.createDate != null) {
      time = String(row.createDate).replace('T', ' ');
      const dot = time.indexOf('.');
      if (dot > 0) time = time.slice(0, dot);
    }
    const parts = [];
    if (row.description != null) parts.push(String(row.description));
    if (row.location != null && String(row.location) !== '') parts.push(String(row.location));
    tracks.push({
      time,
      desc: parts.join(' · '),
    });
  }
  return {
    __autoProvider: 'waway',
    waway: { orderNum: fallbackOrderNum, tracks },
  };
}

function wawayPayloadFromParsedJson(raw, fallbackOrderNum) {
  if (!raw || typeof raw !== 'object') {
    throw new Error('华唯：无法解析为 JSON 对象');
  }
  const isProHomeJson =
    Object.prototype.hasOwnProperty.call(raw, 'code') &&
    !Object.prototype.hasOwnProperty.call(raw, 'Code');
  if (isProHomeJson) {
    return wawayFromProHomeTrackJson(raw, fallbackOrderNum);
  }
  if (raw.Code != null && String(raw.Code) !== '200') {
    throw new Error(raw.Message || `华唯查单失败 Code=${raw.Code}`);
  }
  const datas = raw.Datas;
  const tracks = [];
  let orderNum = fallbackOrderNum;
  if (Array.isArray(datas) && datas.length > 0) {
    const first = datas[0];
    if (first && first.OrderNum != null) orderNum = String(first.OrderNum);
    const inner = first && first.Datas;
    if (Array.isArray(inner)) {
      for (let i = 0; i < inner.length; i += 1) {
        const row = inner[i];
        if (!row || typeof row !== 'object') continue;
        tracks.push({
          time: row.Time != null ? String(row.Time) : '',
          desc: row.Desc != null ? String(row.Desc) : '',
        });
      }
    }
  }
  return {
    __autoProvider: 'waway',
    waway: { orderNum, tracks },
  };
}

async function callWawayTrackPublicFetch(code) {
  const url = expandWawayTemplate(WAWAY_TRACK_URL_TEMPLATE, code);
  const baseHeaders = {
    'User-Agent': WAWAY_BROWSER_UA,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    Referer: WAWAY_TRACK_REFERER,
  };
  const { status, text } = await httpOrHttpsGetText(url, baseHeaders);
  if (status < 200 || status >= 300) {
    throw new Error(`华唯查询 HTTP ${status}: ${(text || '').slice(0, 180)}`);
  }
  const raw = wawayTryParseJsonFromResponse(text);
  if (!raw) {
    throw new Error('华唯：响应中未找到可解析的轨迹 JSON');
  }
  return wawayPayloadFromParsedJson(raw, code);
}

function isWawayUsable(payload) {
  return (
    payload &&
    payload.waway &&
    Array.isArray(payload.waway.tracks) &&
    payload.waway.tracks.length > 0
  );
}

/** 华唯：官网 GET /pro/V1/Home/Track/{单号}（URL 写死在 WAWAY_TRACK_URL_TEMPLATE） */
async function callWawayTrack(mailNoList) {
  const code = mailNoList.map((s) => String(s).trim()).filter(Boolean)[0];
  if (!code) throw new Error('Empty tracking number');
  return callWawayTrackPublicFetch(code);
}

function portal218CookieFromResponseHeaders(headers) {
  const sc = headers && headers['set-cookie'];
  if (!sc) return '';
  const list = Array.isArray(sc) ? sc : [sc];
  return list
    .map((line) => String(line).split(';')[0].trim())
    .filter(Boolean)
    .join('; ');
}

async function portal218EnsureSessionCookie() {
  const r = await httpGetFullResponse(`${PORTAL218_BASE}/track`, {
    'User-Agent': PORTAL218_BROWSER_UA,
    Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
  });
  return portal218CookieFromResponseHeaders(r.headers);
}

function portal218AjaxHeaders(cookie, extra) {
  const h = {
    'User-Agent': PORTAL218_BROWSER_UA,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    Referer: PORTAL218_REFERER,
    Origin: PORTAL218_ORIGIN,
    'X-Requested-With': 'XMLHttpRequest',
    ...(extra || {}),
  };
  if (cookie) h.Cookie = cookie;
  return h;
}

function portal218StripHtmlInner(s) {
  return String(s || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** trackItem 页面常见 layui 时间轴：<span class="trackdate|tracklocation|trackinfo"> */
function portal218SpanTextByClass(block, cls) {
  const re = new RegExp(
    `<span[^>]*\\bclass\\s*=\\s*["'][^"']*\\b${cls}\\b[^"']*["'][^>]*>([\\s\\S]*?)</span>`,
    'i'
  );
  const m = String(block || '').match(re);
  return m ? portal218StripHtmlInner(m[1]) : '';
}

/** 解析 /trackItem：优先 layui 时间轴，其次 <table> 行 */
function portal218ParseTrackItemHtml(html) {
  const tracks = [];
  const h = String(html || '');
  if (!h || h.length < 30) return tracks;
  if (/请求错误/i.test(h) && !/<table/i.test(h) && !/layui-timeline-item/i.test(h)) {
    return tracks;
  }
  const itemRe = /<li[^>]*\blayui-timeline-item\b[^>]*>([\s\S]*?)<\/li>/gi;
  let m;
  while ((m = itemRe.exec(h))) {
    const inner = m[1];
    const time = portal218SpanTextByClass(inner, 'trackdate');
    const loc = portal218SpanTextByClass(inner, 'tracklocation');
    const info = portal218SpanTextByClass(inner, 'trackinfo');
    const desc = [loc, info].filter(Boolean).join(' · ');
    if (time && desc && time.length < 120) tracks.push({ time, desc });
    else if (time && info && time.length < 120) tracks.push({ time, desc: info });
    else if (time && loc && time.length < 120) tracks.push({ time, desc: loc });
  }
  if (tracks.length) return tracks;
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  while ((m = trRe.exec(h))) {
    const inner = m[1];
    const tds = [];
    let tdM;
    const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    while ((tdM = tdRe.exec(inner))) {
      tds.push(portal218StripHtmlInner(tdM[1]));
    }
    if (tds.length >= 2) {
      const time = tds[0];
      const desc = tds.slice(1).join(' · ');
      if (desc && time.length < 120) {
        tracks.push({ time, desc });
      }
    }
  }
  return tracks;
}

function portal218PickRow(rows, code) {
  const c = String(code || '').trim().toUpperCase();
  const fields = [
    'waybillnumber',
    'tracknumber',
    'customernumber1',
    'systemnumber',
    'newtracknumber',
  ];
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    if (!r || typeof r !== 'object') continue;
    for (let j = 0; j < fields.length; j += 1) {
      const f = fields[j];
      if (r[f] != null && String(r[f]).trim().toUpperCase() === c) {
        return r;
      }
    }
  }
  return rows[0];
}

function portal218SummaryTracksFromListRow(row) {
  const time = row.outdate != null ? String(row.outdate) : '';
  const parts = [];
  if (row.outdesc != null && String(row.outdesc).trim()) parts.push(String(row.outdesc));
  if (row.outinfo != null && String(row.outinfo).trim()) parts.push(String(row.outinfo));
  const desc = parts.join(' · ');
  if (!time && !desc) return [];
  return [{ time, desc }];
}

function isPortal218Usable(payload) {
  return (
    payload &&
    payload.portal218 &&
    Array.isArray(payload.portal218.tracks) &&
    payload.portal218.tracks.length > 0
  );
}

async function callPortal218Track(mailNoList) {
  const code = mailNoList.map((s) => String(s).trim()).filter(Boolean)[0];
  if (!code) throw new Error('Empty tracking number');
  let cookie = '';
  try {
    cookie = await portal218EnsureSessionCookie();
  } catch (e) {
    console.error('[api/track] portal218 session (GET /track):', e.message || e);
  }
  const listBody = querystring.stringify({
    'searchList.waybillnumber': code,
    'searchListField.waybillnumber': PORTAL218_SEARCH_FIELD,
    searchLang: 'zh',
    page: 1,
    limit: 30,
  });
  const listUrl = `${PORTAL218_BASE}/trackList`;
  const { status, text } = await httpPostFormUrlEncodedWithHeaders(
    listUrl,
    listBody,
    portal218AjaxHeaders(cookie)
  );
  if (status < 200 || status >= 300) {
    throw new Error(`轨迹门户 trackList HTTP ${status}: ${(text || '').slice(0, 160)}`);
  }
  let raw;
  try {
    raw = text ? JSON.parse(text) : {};
  } catch (_) {
    throw new Error(`轨迹门户 trackList 非 JSON: ${(text || '').slice(0, 200)}`);
  }
  if (Number(raw.code) !== 0) {
    throw new Error(raw.msg || `轨迹门户查询失败 code=${raw.code}`);
  }
  const rows = Array.isArray(raw.data) ? raw.data : [];
  if (!rows.length) {
    return { __autoProvider: 'portal218', portal218: { orderNum: code, tracks: [] } };
  }
  const row = portal218PickRow(rows, code);
  let tracks = [];
  const pkid = row && row.pkid;
  if (pkid != null && pkid !== '') {
    try {
      const itemBody = querystring.stringify({
        orderpkid: String(pkid),
        waybillnumber:
          row.waybillnumber != null && String(row.waybillnumber).trim()
            ? String(row.waybillnumber)
            : code,
        searchLang: 'zh',
      });
      const itemUrl = `${PORTAL218_BASE}/trackItem`;
      const ir = await httpPostFormUrlEncodedWithHeaders(itemUrl, itemBody, {
        ...portal218AjaxHeaders(cookie, {
          Accept: 'text/html,application/xhtml+xml,*/*',
        }),
      });
      if (ir.status >= 200 && ir.status < 300 && ir.text) {
        tracks = portal218ParseTrackItemHtml(ir.text);
      }
    } catch (e) {
      console.error('[api/track] portal218 trackItem:', e.message || e);
    }
  }
  if (!tracks.length) {
    tracks = portal218SummaryTracksFromListRow(row);
  }
  return { __autoProvider: 'portal218', portal218: { orderNum: code, tracks } };
}

async function resolveAutoTrack(mailNoList, ctx) {
  const oisEn = oisResolveTranslateEnFromUiLang(ctx && ctx.lang);
  const speedafRaw = await callSpeedaf(mailNoList);
  if (!isSpeedafEffectivelyEmpty(speedafRaw)) return speedafRaw;

  if (oisEnvReady()) {
    try {
      const ois = await callOisQueryTrace(mailNoList, 0, { isTranslateEn: oisEn });
      if (isOisTraceUsable(ois)) {
        return { __autoProvider: 'ois', ois };
      }
    } catch (err) {
      console.error('[api/track] auto fallback ois:', err.message || err);
    }
  }

  if (PORTAL218_IN_AUTO) {
    try {
      const p218 = await callPortal218Track(mailNoList);
      if (isPortal218Usable(p218)) return p218;
    } catch (err) {
      console.error('[api/track] auto fallback portal218:', err.message || err);
    }
  }

  if (WAWAY_IN_AUTO) {
    try {
      const ww = await callWawayTrack(mailNoList);
      if (isWawayUsable(ww)) return ww;
    } catch (err) {
      console.error('[api/track] auto fallback waway:', err.message || err);
    }
  }

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
      service: 'hkxh-track / Speedaf + Yanwen + Kingtrans + sz56t + WMS + OIS + Waway + portal218 proxy',
      note:
        '地址栏访问为 GET，本接口只接受 POST。请在官网页面输入单号点击查询；或用 curl/Postman POST JSON。',
      noteEn:
        'Browser URL bar sends GET; this API only accepts POST. Use the site’s query button, or POST JSON via curl/Postman.',
      post: {
        method: 'POST',
        'Content-Type': 'application/json',
        bodyExample: { trackingNumber: 'YOUR_MAIL_NO' },
        bodyExampleAlt: { mailNoList: ['YOUR_MAIL_NO'], lang: 'zh' },
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
        bodyOis: {
          provider: 'ois',
          trackingNumber: '运单/参考号/转单号',
          env: 'OIS_APP_KEY + OIS_APP_SECRET；full 需 OIS_COMPANY_NO；minimal 设 OIS_TRACE_BODY1_MINIMAL=1',
        },
        bodyWaway: {
          provider: 'waway',
          trackingNumber: '华唯单号',
          note: '华唯 URL 已写死在 api/track.js（WAWAY_TRACK_URL_TEMPLATE）',
        },
        bodyPortal218: {
          provider: 'portal218',
          trackingNumber: '单号',
          note: '218.244.139.186:9999 轨迹门户，请求写在 api/track.js',
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
  const trackCtx = { lang: body.lang };
  try {
    let data;
    if (provider === 'auto' || provider === 'merge') {
      data = await resolveAutoTrack(mailNoList, trackCtx);
    } else if (provider === 'yanwen' || provider === 'yw56' || provider === 'yw') {
      data = await callYanwenTracking(mailNoList);
    } else if (provider === 'kingtrans' || provider === 'k5') {
      data = await callKingtransTrack(mailNoList);
    } else if (provider === 'sz56t' || provider === 'hualei') {
      data = await callSz56tTrack(mailNoList);
    } else if (provider === 'wms' || provider === 'gettrack') {
      data = await callWmsGetTrack(mailNoList);
    } else if (provider === 'ois' || provider === 'yha' || provider === 'yuehang') {
      data = await callOisQueryTrace(mailNoList, 0, {
        isTranslateEn: oisResolveTranslateEnFromUiLang(body.lang),
      });
    } else if (provider === 'waway' || provider === 'uhuawei' || provider === 'waw') {
      data = await callWawayTrack(mailNoList);
    } else if (provider === 'portal218' || provider === 'tms218' || provider === '218track') {
      data = await callPortal218Track(mailNoList);
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
