/**
 * 用「冻结」的 timestamp / token / nonce / body1 验签（与单次请求一致即可对比）
 * 用法：在环境变量中填入货代提供的一次性参数后执行：
 *   set OIS_APP_SECRET=...
 *   set FF_TIMESTAMP=1776320079036
 *   set FF_TOKEN=b438b87b-...
 *   set FF_NONCE=request
 *   set FF_BODY1={"companyNo":"..."}   （必须与货代日志里参与签名的 body1 完全一致）
 *   node scripts/ois-sign-verify-once.js
 */
const crypto = require('crypto');

function mask(b64) {
  return String(b64)
    .replace(/a/g, '-')
    .replace(/c/g, '#')
    .replace(/x/g, '^')
    .replace(/M/g, '$');
}

function oisComputeSign(paramMap, appSecret) {
  const keys = Object.keys(paramMap).filter(
    (k) => paramMap[k] != null && paramMap[k] !== ''
  );
  keys.sort();
  const plain = keys.map((k) => `${k}=${paramMap[k]}`).join('&');
  const b64 = Buffer.from(plain, 'utf8').toString('base64');
  return crypto.createHash('md5').update(b64 + appSecret, 'utf8').digest('hex').toUpperCase();
}

const appSecret = process.env.OIS_APP_SECRET || '';
const ts = Number(process.env.FF_TIMESTAMP || '0');
const realTok = process.env.FF_TOKEN || '';
const nonce = process.env.FF_NONCE || 'request';
const body1 = process.env.FF_BODY1 || '';
const version = process.env.FF_VERSION || '1.0';
const expect = process.env.FF_EXPECT_SIGN || '';

if (!appSecret || !realTok || !body1) {
  console.error('请设置 OIS_APP_SECRET、FF_TOKEN、FF_BODY1（及 FF_TIMESTAMP、FF_NONCE）');
  process.exit(1);
}

const payload = JSON.stringify({
  timestamp: ts,
  nonce,
  token: realTok,
});
const masked = mask(Buffer.from(payload, 'utf8').toString('base64'));
const sign = oisComputeSign({ body1, token: masked, version }, appSecret);

console.log('计算 sign:', sign);
if (expect) console.log('期望 sign:', expect, sign === expect ? '一致' : '不一致');
