/**
 * 越航 OIS 轨迹直连：getAuth → queryTraceoutList（与 api/track.js、Utils.java sign 一致）
 * 签名参与字段：body1、nonce、timestamp、token(明文 access token)、version（排序后 Base64+MD5）；HTTP 头 token 仍为 encodeMixChar 后的伪装串
 *
 * 用法：
 *   复制 ois-test.example.json → ois-test.json 填写密钥与公司/客户编码
 *   npm run ois-test -- 1Z0E319J0437330473
 *   npm run ois-test -- 1Z0E319J0437330473 zh
 *   npm run ois-test -- --verbose 011419131569 zh   # 打印发往越航的完整 HTTP 报文（含 token/sign，仅本地）
 * PowerShell（无 npm 时，需已安装 Node 并加入 PATH）：scripts/ois-direct-test.ps1
 * 或环境变量：OIS_PROJECT_URL、OIS_APP_KEY、OIS_APP_SECRET、OIS_COMPANY_NO
 */
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const querystring = require('querystring');

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
        ...(extraHeaders || {}),
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

function oisMaskTokenBase64(b64) {
  return String(b64).replace(/a/g, '-').replace(/c/g, '#').replace(/x/g, '^').replace(/M/g, '$');
}

function oisBuildMaskedTokenHeader(realToken, nonce, innerOrder) {
  const ts = Date.now();
  const tsStr = /^1|true|yes$/i.test(
    String(process.env.OIS_TOKEN_TIMESTAMP_STRING || '').trim()
  );
  const tsVal = tsStr ? String(ts) : ts;
  const n = nonce || 'slnkda';
  const order = (innerOrder || process.env.OIS_TOKEN_INNER_ORDER || 'pdf').trim().toLowerCase();
  const inner =
    order === 'sorted'
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

function translateEnFromLang(lang) {
  if (lang == null || lang === '') return undefined;
  const s = String(lang).toLowerCase();
  if (s === 'zh' || s.startsWith('zh-')) return 0;
  if (s === 'en' || s.startsWith('en-')) return 1;
  return undefined;
}

/** 可复制的 HTTP/1.1 风格报文（本地调试用，含真实 token/sign，勿提交日志） */
function printVerboseOisWire({
  projectUrl,
  authUrl,
  appSecret,
  traceUrl,
  formBody,
  token,
  sign,
  version,
  body1,
  sortedPlain,
}) {
  const base = projectUrl.startsWith('http') ? projectUrl : `https://${projectUrl}`;
  const host = new URL(`${base}/`).host;
  const authPathQuery = authUrl.replace(/^https?:\/\/[^/]+/i, '');
  const tracePathQuery = traceUrl.replace(/^https?:\/\/[^/]+/i, '');
  const esc = appSecret ? appSecret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '';
  const getDisplayRedacted = esc ? authUrl.replace(new RegExp(esc, 'g'), '***') : authUrl;
  const len = Buffer.byteLength(formBody, 'utf8');
  const b64Payload = Buffer.from(sortedPlain, 'utf8').toString('base64');
  const lines = [];
  lines.push('========== 1) GET getAuth ==========');
  lines.push(`GET ${authPathQuery} HTTP/1.1`);
  lines.push(`Host: ${host}`);
  lines.push('Accept: application/json');
  lines.push('');
  lines.push('（无 body）');
  lines.push('');
  lines.push('脱敏 URL（appSecret 已替换为 ***）:');
  lines.push(getDisplayRedacted);
  lines.push('');
  lines.push('========== 2) POST queryTraceoutList ==========');
  lines.push(`POST ${tracePathQuery} HTTP/1.1`);
  lines.push(`Host: ${host}`);
  lines.push('Content-Type: application/x-www-form-urlencoded;charset=UTF-8');
  lines.push(`Content-Length: ${len}`);
  lines.push(`token: ${token}`);
  lines.push(`sign: ${sign}`);
  lines.push(`version: ${version}`);
  lines.push('');
  lines.push(formBody);
  lines.push('');
  lines.push('========== 签名中间态（对照 PDF / Gitee demo） ==========');
  lines.push('signSortedString（参与 Base64 前）:');
  lines.push(sortedPlain);
  lines.push('signBase64Payload:');
  lines.push(b64Payload);
  lines.push('body1 JSON 原文:');
  lines.push(body1);
  lines.push('signMd5HexUpper（应与 header sign 一致）:');
  lines.push(sign);
  console.log(lines.join('\n'));
}

function loadConfig() {
  const p = path.join(__dirname, '..', 'ois-test.json');
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const verbose = rawArgs.some((a) => a === '--verbose' || a === '-v');
  const argv = rawArgs.filter((a) => a !== '--verbose' && a !== '-v');
  const cfg = loadConfig();
  const projectUrl = (
    (cfg && cfg.projectUrl) ||
    process.env.OIS_PROJECT_URL ||
    'https://ois.yha56.com/'
  )
    .trim()
    .replace(/\/+$/, '');
  const appKey = ((cfg && cfg.appKey) || process.env.OIS_APP_KEY || '').trim();
  const appSecret = ((cfg && cfg.appSecret) || process.env.OIS_APP_SECRET || '').trim();
  const companyNo = ((cfg && cfg.companyNo) || process.env.OIS_COMPANY_NO || '').trim();
  const queryType = ((cfg && cfg.queryType) || process.env.OIS_QUERY_TYPE || '99').trim();
  const version = ((cfg && cfg.version) || process.env.OIS_HEADER_VERSION || '1.0').trim();
  const tokenNonce = ((cfg && cfg.tokenNonce) || process.env.OIS_TOKEN_NONCE || 'slnkda').trim();
  const tokenInnerOrder = (cfg && cfg.tokenInnerOrder) || process.env.OIS_TOKEN_INNER_ORDER || 'pdf';
  const traceBody1Minimal = /^1|true|yes$/i.test(
    String(
      (cfg && cfg.traceBody1Minimal) || process.env.OIS_TRACE_BODY1_MINIMAL || ''
    ).trim()
  );
  const traceOmitIsTranslate = /^1|true|yes$/i.test(
    String(
      (cfg && cfg.traceOmitIsTranslate) || process.env.OIS_TRACE_OMIT_IS_TRANSLATE || ''
    ).trim()
  );
  const defaultLang = (cfg && cfg.lang) || 'zh';

  let no = argv[0];
  let lang = argv[1] || defaultLang;
  if (!no) {
    console.error(
      '用法: npm run ois-test -- <运单号> [zh|en]\n' +
        '      npm run ois-test -- --verbose <运单号> [zh|en]   # 打印发往越航的完整报文\n' +
        '  需 ois-test.json（从 ois-test.example.json 复制）或设置 OIS_* 环境变量'
    );
    process.exit(1);
  }
  if (argv.length === 1 && /^zh|en$/i.test(argv[0])) {
    console.error('第一个参数应为运单号');
    process.exit(1);
  }

  if (!appKey || !appSecret) {
    console.error('缺少 appKey/appSecret，请配置 ois-test.json 或环境变量');
    process.exit(1);
  }
  if (!traceBody1Minimal && !companyNo) {
    console.error('非 minimal 模式缺少 companyNo；或设 traceBody1Minimal / OIS_TRACE_BODY1_MINIMAL=1');
    process.exit(1);
  }

  const q = querystring.stringify({ appKey, appSecret });
  const authUrl = `${projectUrl}/ois/order/getAuth?${q}`;
  console.error('GET', authUrl.replace(appSecret, '***'));
  const authRes = await httpOrHttpsGetText(authUrl, { Accept: 'application/json' });
  let authJson;
  try {
    authJson = JSON.parse(authRes.text);
  } catch (e) {
    console.error('getAuth 非 JSON:', authRes.text.slice(0, 300));
    process.exit(1);
  }
  if (authRes.status < 200 || authRes.status >= 300 || Number(authJson.result_code) !== 0) {
    console.error('getAuth 失败:', authRes.status, authRes.text.slice(0, 400));
    process.exit(1);
  }
  if (!authJson.body || String(authJson.body.ack).toLowerCase() !== 'true' || !authJson.body.token) {
    console.error('getAuth 未通过:', JSON.stringify(authJson));
    process.exit(1);
  }
  const realTok = authJson.body.token;
  const { masked, nonce: oisNonce, tsVal } = oisBuildMaskedTokenHeader(
    realTok,
    tokenNonce,
    tokenInnerOrder
  );
  const te = translateEnFromLang(lang);
  let body1Obj;
  if (traceBody1Minimal) {
    body1Obj = {
      isTranslateEn: te !== undefined ? te : 0,
      noList: no,
      queryType,
    };
    if (traceOmitIsTranslate) delete body1Obj.isTranslateEn;
  } else {
    body1Obj = {
      companyNo,
      queryType,
      noList: no,
    };
    if (te !== undefined) body1Obj.isTranslateEn = te;
  }
  const body1 = JSON.stringify(body1Obj);
  const sign = oisComputeSign(
    { body1, nonce: oisNonce, timestamp: tsVal, token: realTok, version },
    appSecret
  );
  const sortedPlain = oisSortedSignString({
    body1,
    nonce: oisNonce,
    timestamp: tsVal,
    token: realTok,
    version,
  });
  const formBody = querystring.stringify({ body1 });
  const traceUrl = `${projectUrl}/tms/expose/queryTraceoutList`;
  if (verbose) {
    printVerboseOisWire({
      projectUrl,
      authUrl,
      appSecret,
      traceUrl,
      formBody,
      token: masked,
      sign,
      version,
      body1,
      sortedPlain,
    });
  }
  console.error('POST', traceUrl);
  const { status, text } = await httpPostFormUrlEncodedWithHeaders(traceUrl, formBody, {
    token: masked,
    sign,
    version,
  });
  console.log('HTTP', status);
  let out;
  try {
    out = JSON.parse(text);
  } catch (_) {
    console.log(text.slice(0, 2000));
    process.exit(1);
  }
  console.log(JSON.stringify(out, null, 2));
  const rc = Number(out.result_code);
  process.exit(status >= 200 && status < 300 && rc === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
