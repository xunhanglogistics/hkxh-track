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
 */
const crypto = require('crypto');
const CryptoJS = require('crypto-js');

const DES_IV_HEX = '1234567890abcdef';
const APP_CODE = process.env.SPEEDAF_APP_CODE || 'CN000796';
const SECRET_KEY = process.env.SPEEDAF_SECRET_KEY || 'Ty2pi72K';
const SPEEDAF_URL = 'https://apis.speedaf.com/open-api/express/track/query';

/** 文档正式环境为 http://；自行设 YW56_TRACK_BASE 可改为 https 等 */
const YW56_TRACK_BASE =
  process.env.YW56_TRACK_BASE || 'http://api.track.yw56.com.cn/api/tracking';
const YW56_AUTHORIZATION = process.env.YW56_AUTHORIZATION || '';

const KINGTRANS_API_BASE = (
  process.env.KINGTRANS_API_BASE || 'http://fhex.kingtrans.cn'
).trim().replace(/\/$/, '');
const KINGTRANS_CLIENT_ID = (process.env.KINGTRANS_CLIENT_ID || '').trim();
const KINGTRANS_TOKEN = (process.env.KINGTRANS_TOKEN || '').trim();

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
  return Array.isArray(yw.result) && yw.result.length > 0;
}

function kingtransEnvReady() {
  return !!(KINGTRANS_API_BASE && KINGTRANS_CLIENT_ID && KINGTRANS_TOKEN);
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
      '未配置 KINGTRANS_CLIENT_ID / KINGTRANS_TOKEN（API 根地址默认 http://fhex.kingtrans.cn）'
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
      service: 'hkxh-track / Tencent SCF → Speedaf + Yanwen + Kingtrans',
      note: 'POST：provider auto 依次速达非/燕文/Kingtrans；kingtrans 仅 K5；见 api.kingtrans.net',
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

  try {
    let data;
    if (provider === 'auto' || provider === 'merge') {
      data = await resolveAutoTrack(mailNoList);
    } else if (provider === 'yanwen' || provider === 'yw56' || provider === 'yw') {
      data = await callYanwenTracking(mailNoList);
    } else if (provider === 'kingtrans' || provider === 'k5') {
      data = await callKingtransTrack(mailNoList);
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
