/**
 * 复现货代 011419131569.log 中的参数，校验签名是否与日志一致
 */
const crypto = require('crypto');

function mask(b64) {
  return String(b64)
    .replace(/a/g, '-')
    .replace(/c/g, '#')
    .replace(/x/g, '^')
    .replace(/M/g, '$');
}

function oisSortedSignString(paramMap) {
  const keys = Object.keys(paramMap).filter(
    (k) => paramMap[k] != null && paramMap[k] !== ''
  );
  keys.sort();
  return keys.map((k) => `${k}=${paramMap[k]}`).join('&');
}

function oisComputeSign(paramMap, appSecret) {
  const plain = oisSortedSignString(paramMap);
  const b64 = Buffer.from(plain, 'utf8').toString('base64');
  return crypto.createHash('md5').update(b64 + appSecret, 'utf8').digest('hex').toUpperCase();
}

function oisComputeSignSecretFirst(paramMap, appSecret) {
  const plain = oisSortedSignString(paramMap);
  const b64 = Buffer.from(plain, 'utf8').toString('base64');
  return crypto.createHash('md5').update(appSecret + b64, 'utf8').digest('hex').toUpperCase();
}

/** 与 011419131569.log 中一致；也可用环境变量 OIS_APP_SECRET 覆盖 */
const appSecret =
  process.env.OIS_APP_SECRET || 'edc9a8b7848a474fb415c10af9b84e7b';
const body1 = '{"isTranslateEn":0,"noList":"011419131569","queryType":"1"}';
const ts = 1776321287385;
const nonce = 'request';
const accessToken = '7e15f944-7f94-49d9-b9db-5f488d803a87';
const version = '1.0';
const expectSign = '801625867C497FE2ADE63AAFD282438E';

// PDF 顺序：timestamp, nonce, token
const payloadPdf = JSON.stringify({
  timestamp: ts,
  nonce,
  token: accessToken,
});
const maskedPdf = mask(Buffer.from(payloadPdf, 'utf8').toString('base64'));

const signPdf = oisComputeSign(
  { body1, token: maskedPdf, version },
  appSecret
);

console.log('货代日志期望 sign:', expectSign);
console.log('body1:', body1);
console.log('PDF 内层 token JSON 顺序 (timestamp,nonce,token) => sign:', signPdf, signPdf === expectSign ? '✓' : '✗');

const payloadSorted = JSON.stringify({
  nonce,
  timestamp: ts,
  token: accessToken,
});
const maskedSorted = mask(Buffer.from(payloadSorted, 'utf8').toString('base64'));
const signSorted = oisComputeSign(
  { body1, token: maskedSorted, version },
  appSecret
);
console.log('内层 sorted (nonce,timestamp,token) => sign:', signSorted, signSorted === expectSign ? '✓' : '✗');

// 尝试：timestamp 在 JSON 里为字符串（部分 Java 序列化）
const payloadTsStr = JSON.stringify({
  timestamp: String(ts),
  nonce,
  token: accessToken,
});
const maskedTsStr = mask(Buffer.from(payloadTsStr, 'utf8').toString('base64'));
const signTsStr = oisComputeSign(
  { body1, token: maskedTsStr, version },
  appSecret
);
console.log('timestamp 为字符串 => sign:', signTsStr, signTsStr === expectSign ? '✓' : '✗');

const signRev = oisComputeSignSecretFirst(
  { body1, token: maskedPdf, version },
  appSecret
);
console.log('MD5(secret+b64) 反向 => sign:', signRev, signRev === expectSign ? '✓' : '✗');

console.log('');
console.log(
  '说明：若以上均不等于货代日志中的签名，多为「伪装 token」与 Java 侧序列化一字之差；' +
    '日志未给出完整 token 头时无法 100% 复现。以线上 minimal body1 + queryType=1 实测为准。'
);
