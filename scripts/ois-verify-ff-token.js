/**
 * 用货代日志里冻结的 timestamp / nonce / access token 计算伪装 token（header 里那串）
 * 用法：node scripts/ois-verify-ff-token.js
 * 若与货代抓包里的 token 头逐字一致，说明 encode 与货代一致（再对 sign 需 body1）
 */
function mask(b64) {
  return String(b64)
    .replace(/a/g, '-')
    .replace(/c/g, '#')
    .replace(/x/g, '^')
    .replace(/M/g, '$');
}

const ts = 1776320079036;
const nonce = 'request';
const accessToken = 'b438b87b-f9b2-494e-8f80-e587f0b35692';

// 与当前 Node 一致：对象字面量顺序 timestamp → nonce → token
const orderA = JSON.stringify({
  timestamp: ts,
  nonce,
  token: accessToken,
});

// 常见另一种：键名字典序 nonce, timestamp, token
const orderB = JSON.stringify({
  nonce,
  timestamp: ts,
  token: accessToken,
});

function show(label, jsonStr) {
  const b64 = Buffer.from(jsonStr, 'utf8').toString('base64');
  const masked = mask(b64);
  console.log('---', label, '---');
  console.log('JSON:', jsonStr);
  console.log('伪装 token（完整，可与抓包逐字对比）:', masked);
  console.log('长度:', masked.length);
  console.log('');
}

show('Node 常用顺序: timestamp, nonce, token', orderA);
show('键字典序: nonce, timestamp, token', orderB);
