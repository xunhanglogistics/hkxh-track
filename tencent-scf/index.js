/**
 * 腾讯云 SCF：正式环境域名 **apis.speedaf.com**（见官方文档 track_query）
 *
 * 部署后：推荐「函数 URL」触发器（API 网关触发器已停售新建）。
 * 前端 TRACK_PROXY = 控制台给出的完整 HTTPS 地址（通常无 /api/track 路径）。
 *
 * 环境变量（函数配置 → 环境变量）：
 * SPEEDAF_APP_CODE, SPEEDAF_SECRET_KEY（速达非）
 * YW56_AUTHORIZATION（燕文）
 * KINGTRANS_API_BASE、KINGTRANS_CLIENT_ID、KINGTRANS_TOKEN（K5 searchTrack）
 * SZ56T_API_BASE（华磊/sz56t URL1 根；POST …/selectTrack.htm?documentCode=）
 * WMS_SERVICE_URL、WMS_APP_TOKEN、WMS_APP_KEY（POST form gettrack，见货代 API 文档）
 * OIS_PROJECT_URL、OIS_APP_KEY、OIS_APP_SECRET、OIS_COMPANY_NO（越航轨迹 queryTraceoutList）
 */
const crypto = require('crypto');
const querystring = require('querystring');
const CryptoJS = require('crypto-js');
const iconv = require('iconv-lite');

const DES_IV_HEX = '1234567890abcdef';
const APP_CODE = process.env.SPEEDAF_APP_CODE || 'CN000796';
const SECRET_KEY = process.env.SPEEDAF_SECRET_KEY || 'Ty2pi72K';
const SPEEDAF_URL = 'https://apis.speedaf.com/open-api/express/track/query';

/** 文档正式环境为 http://；自行设 YW56_TRACK_BASE 可改为 https 等 */
const YW56_TRACK_BASE =
  process.env.YW56_TRACK_BASE || 'http://api.track.yw56.com.cn/api/tracking';
const YW56_AUTHORIZATION = process.env.YW56_AUTHORIZATION || '';

const KINGTRANS_API_BASE = (
  process.env.KINGTRANS_API_BASE || 'https://fhex.kingtrans.cn'
).trim().replace(/\/$/, '');
const KINGTRANS_CLIENT_ID = (process.env.KINGTRANS_CLIENT_ID || '').trim();
const KINGTRANS_TOKEN = (process.env.KINGTRANS_TOKEN || '').trim();

const SZ56T_API_BASE = (process.env.SZ56T_API_BASE || '').trim().replace(/\/$/, '');

const WMS_SERVICE_URL = (process.env.WMS_SERVICE_URL || '').trim();
const WMS_APP_TOKEN = (process.env.WMS_APP_TOKEN || '').trim();
const WMS_APP_KEY = (process.env.WMS_APP_KEY || '').trim();

const OIS_PROJECT_URL = (process.env.OIS_PROJECT_URL || 'https://ois.yha56.com/').trim();
const OIS_APP_KEY = (process.env.OIS_APP_KEY || '').trim();
const OIS_APP_SECRET = (process.env.OIS_APP_SECRET || '').trim();
const OIS_COMPANY_NO = (process.env.OIS_COMPANY_NO || '').trim();
const OIS_QUERY_TYPE = (process.env.OIS_QUERY_TYPE || '99').trim();
const OIS_HEADER_VERSION = (process.env.OIS_HEADER_VERSION || '1.0').trim();
const OIS_TOKEN_NONCE = (process.env.OIS_TOKEN_NONCE || 'slnkda').trim();
const OIS_TOKEN_INNER_ORDER = (process.env.OIS_TOKEN_INNER_ORDER || 'pdf').trim().toLowerCase();
const OIS_TOKEN_TIMESTAMP_STRING = /^1|true|yes$/i.test(
  String(process.env.OIS_TOKEN_TIMESTAMP_STRING || '').trim()
);
const OIS_TRACE_OMIT_IS_TRANSLATE = /^1|true|yes$/i.test(
  String(process.env.OIS_TRACE_OMIT_IS_TRANSLATE || '').trim()
);
const OIS_TRACE_BODY1_MINIMAL = /^1|true|yes$/i.test(
  String(process.env.OIS_TRACE_BODY1_MINIMAL || '').trim()
);
const OIS_IS_TRANSLATE_EN = process.env.OIS_IS_TRANSLATE_EN;

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

/**
 * 轨迹实时查询：官方文档要求 data 仅为 { mailNoList: [...] }，
 * sign = md5(timestamp + secretKey + JSON.stringify(data))，勿加 customerCode/platformSource，否则 60004
 */
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

function isSpeedafEffectivelyEmpty(raw) {
  if (raw == null) return true;
  if (typeof raw.success === 'boolean' && !raw.success) return true;
  let data = raw;
  if (raw.data !== undefined) data = raw.data;
  if (!Array.isArray(data) || data.length === 0) return true;
  const tracks = data[0] && data[0].tracks;
  return !Array.isArray(tracks) || tracks.length === 0;
}

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
      '未配置 KINGTRANS_CLIENT_ID / KINGTRANS_TOKEN（API 根地址默认 https://fhex.kingtrans.cn）'
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
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json;charset=UTF-8',
      Accept: 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let raw;
  try {
    raw = text ? JSON.parse(text) : {};
  } catch (_) {
    throw new Error(`Kingtrans non-JSON (${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    throw new Error(
      `Kingtrans HTTP ${res.status}: ${(raw && raw.message) || text.slice(0, 200)}`
    );
  }
  return raw;
}

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

/** 华磊 selectTrack.htm：POST，documentCode 在 query；空 body */
async function callSz56tTrack(mailNoList) {
  if (!sz56tEnvReady()) {
    throw new Error(
      '华磊/sz56t 轨迹未配置：请在 SCF 环境变量中设置 SZ56T_API_BASE（文档 URL1 根地址，无末尾斜杠）'
    );
  }
  const code = mailNoList.map((s) => String(s).trim()).filter(Boolean)[0];
  if (!code) throw new Error('Empty tracking number');
  const url = `${SZ56T_API_BASE}/selectTrack.htm?documentCode=${encodeURIComponent(code)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Accept: '*/*' },
  });
  const buf = Buffer.from(await res.arrayBuffer());
  const text = decodeSz56tJsonBuffer(buf);
  let raw;
  try {
    raw = text ? JSON.parse(text) : [];
  } catch (_) {
    throw new Error(`sz56t non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    throw new Error(`sz56t HTTP ${res.status}: ${text.slice(0, 200)}`);
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
    throw new Error('WMS gettrack 未配置：请设置 WMS_SERVICE_URL、WMS_APP_TOKEN、WMS_APP_KEY');
  }
  const code = mailNoList.map((s) => String(s).trim()).filter(Boolean)[0];
  if (!code) throw new Error('Empty tracking number');
  const paramsJson = JSON.stringify({ tracking_number: code });
  const form = new URLSearchParams();
  form.set('appToken', WMS_APP_TOKEN);
  form.set('appKey', WMS_APP_KEY);
  form.set('serviceMethod', 'gettrack');
  form.set('paramsJson', paramsJson);
  const res = await fetch(WMS_SERVICE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body: form.toString(),
  });
  const text = await res.text();
  let raw;
  try {
    raw = text ? JSON.parse(text) : {};
  } catch (_) {
    throw new Error(`WMS gettrack non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    throw new Error(`WMS gettrack HTTP ${res.status}: ${(raw && raw.cnmessage) || text.slice(0, 200)}`);
  }
  return raw;
}

function oisProjectBase() {
  return OIS_PROJECT_URL.replace(/\/+$/, '');
}

function oisMaskTokenBase64(b64) {
  return String(b64).replace(/a/g, '-').replace(/c/g, '#').replace(/x/g, '^').replace(/M/g, '$');
}

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
  const res = await fetch(url, { method: 'GET', headers: { Accept: 'application/json' } });
  const text = await res.text();
  let raw;
  try {
    raw = text ? JSON.parse(text) : {};
  } catch (_) {
    throw new Error(`OIS getAuth non-JSON (${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    throw new Error(`OIS getAuth HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  if (Number(raw.result_code) !== 0 || !raw.body || String(raw.body.ack).toLowerCase() !== 'true') {
    throw new Error(`OIS getAuth 失败: ${(raw && raw.message) || text.slice(0, 200)}`);
  }
  const tok = raw.body.token;
  if (!tok) throw new Error('OIS getAuth 未返回 token');
  oisTokenCache = { token: tok, at: now };
  return tok;
}

function oisResolveTranslateEnFromUiLang(lang) {
  if (lang == null || lang === '') return undefined;
  const s = String(lang).toLowerCase();
  if (s === 'zh' || s.startsWith('zh-')) return 0;
  if (s === 'en' || s.startsWith('en-')) return 1;
  return undefined;
}

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
      '越航 OIS 轨迹未配置：请设置 OIS_APP_KEY、OIS_APP_SECRET（full 还需 OIS_COMPANY_NO；minimal 设 OIS_TRACE_BODY1_MINIMAL=1）'
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
  const sign = oisComputeSign(
    { body1, nonce: oisNonce, timestamp: tsVal, token: realTok, version: ver },
    OIS_APP_SECRET
  );
  const formBody = querystring.stringify({ body1 });
  const url = `${oisProjectBase()}/tms/expose/queryTraceoutList`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      token: masked,
      sign,
      version: ver,
    },
    body: formBody,
  });
  const text = await res.text();
  let raw;
  try {
    raw = text ? JSON.parse(text) : {};
  } catch (_) {
    throw new Error(`OIS queryTraceoutList non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  const rc = Number(raw.result_code);
  if (res.ok && oisShouldRetryResultCode(rc) && att < 1) {
    return callOisQueryTrace(mailNoList, att + 1, opts);
  }
  if (!res.ok) {
    throw new Error(`OIS queryTraceoutList HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  if (rc !== 0) {
    throw new Error(
      `OIS queryTraceoutList result_code=${rc}: ${(raw && raw.message) || text.slice(0, 200)}`
    );
  }
  return raw;
}

async function resolveAutoTrack(mailNoList, ctx) {
  const oisEn = oisResolveTranslateEnFromUiLang(ctx && ctx.lang);
  const speedafRaw = await callSpeedaf(mailNoList);
  if (!isSpeedafEffectivelyEmpty(speedafRaw)) return speedafRaw;

  if (YW56_AUTHORIZATION) {
    try {
      const yw = await callYanwenTracking(mailNoList);
      if (isYanwenHasUsableResult(yw)) {
        return { __autoProvider: 'yanwen', ...yw };
      }
    } catch (err) {
      console.error('[scf/track] auto fallback yanwen:', err.message || err);
    }
  }

  if (kingtransEnvReady()) {
    try {
      const kt = await callKingtransTrack(mailNoList);
      if (isKingtransHasUsableResult(kt)) {
        return { __autoProvider: 'kingtrans', ...kt };
      }
    } catch (err) {
      console.error('[scf/track] auto fallback kingtrans:', err.message || err);
    }
  }

  if (sz56tEnvReady()) {
    try {
      const sz = await callSz56tTrack(mailNoList);
      if (isSz56tHasUsableResult(sz)) {
        return { __autoProvider: 'sz56t', sz56t: sz };
      }
    } catch (err) {
      console.error('[scf/track] auto fallback sz56t:', err.message || err);
    }
  }

  if (wmsEnvReady()) {
    try {
      const wms = await callWmsGetTrack(mailNoList);
      if (isWmsGetTrackUsable(wms)) {
        return { __autoProvider: 'wms', wms };
      }
    } catch (err) {
      console.error('[scf/track] auto fallback wms gettrack:', err.message || err);
    }
  }

  if (oisEnvReady()) {
    try {
      const ois = await callOisQueryTrace(mailNoList, 0, { isTranslateEn: oisEn });
      if (isOisTraceUsable(ois)) {
        return { __autoProvider: 'ois', ois };
      }
    } catch (err) {
      console.error('[scf/track] auto fallback ois:', err.message || err);
    }
  }

  return speedafRaw;
}

async function callYanwenTracking(mailNoList) {
  if (!YW56_AUTHORIZATION) {
    throw new Error(
      '未配置 YW56_AUTHORIZATION：请在 SCF 环境变量中填写燕文「商户号」或「制单账号」（轨迹接口 Authorization）'
    );
  }
  const list = mailNoList.slice(0, 30).map((s) => String(s).trim()).filter(Boolean);
  if (!list.length) throw new Error('Empty tracking numbers');
  const nums = list.join(',');
  const url = `${YW56_TRACK_BASE.replace(/\/$/, '')}?nums=${encodeURIComponent(nums)}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: YW56_AUTHORIZATION,
      Accept: 'application/json',
    },
  });
  const text = await res.text();
  let raw;
  try {
    raw = text ? JSON.parse(text) : {};
  } catch (_) {
    throw new Error(`Yanwen non-JSON (${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    throw new Error(
      `Yanwen HTTP ${res.status}: ${(raw && raw.message) || text.slice(0, 200)}`
    );
  }
  return raw;
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
      service: 'hkxh-track / Tencent SCF → Speedaf + Yanwen + Kingtrans + sz56t + WMS + OIS',
      note: 'POST：auto 末尾可接 WMS / 越航 OIS（需对应环境变量）',
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
    } else {
      data = await callSpeedaf(mailNoList);
    }
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
