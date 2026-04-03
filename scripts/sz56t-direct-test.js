/**
 * 华磊/sz56t 轨迹直连探活：与 api/track.js 中 httpPostEmpty + selectTrack 一致（POST、Content-Length: 0）。
 *
 * 用法：
 *   1) 复制 sz56t-test.example.json → sz56t-test.json，填写 apiBase、documentCode，然后：
 *      npm run sz56t-test
 *   2) 或环境变量：SZ56T_API_BASE、SZ56T_DOCUMENT_CODE
 *      node scripts/sz56t-direct-test.js
 *   3) 或命令行（便于临时试）：node scripts/sz56t-direct-test.js "http://host:port" "单号"
 *
 * PowerShell / curl.exe（无需 Node）：见 scripts/sz56t-direct-test.ps1
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

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
          text: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function loadJsonConfig() {
  const root = path.join(__dirname, '..');
  const p = path.join(root, 'sz56t-test.json');
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    console.error('sz56t-test.json 解析失败:', e.message);
    process.exit(1);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  let apiBase = '';
  let documentCode = '';

  if (argv.length >= 2) {
    apiBase = argv[0].trim().replace(/\/$/, '');
    documentCode = argv[1].trim();
  } else {
    const cfg = loadJsonConfig();
    apiBase = (
      (cfg && cfg.apiBase) ||
      process.env.SZ56T_API_BASE ||
      ''
    )
      .trim()
      .replace(/\/$/, '');
    documentCode = (
      (cfg && cfg.documentCode) ||
      process.env.SZ56T_DOCUMENT_CODE ||
      ''
    ).trim();
  }

  if (!apiBase || !documentCode) {
    console.error(
      '缺少 apiBase 或 documentCode。\n' +
        '  • 复制 sz56t-test.example.json 为 sz56t-test.json 并填写；或\n' +
        '  • 设置环境变量 SZ56T_API_BASE、SZ56T_DOCUMENT_CODE；或\n' +
        '  • node scripts/sz56t-direct-test.js "<URL1根>" "<单号>"\n'
    );
    process.exit(1);
  }

  const url = `${apiBase}/selectTrack.htm?documentCode=${encodeURIComponent(documentCode)}`;
  console.error('POST', url);
  console.error('(empty body, Content-Length: 0)\n');

  try {
    const { status, text } = await httpPostEmpty(url);
    console.log('HTTP', status);
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (_) {
      console.log('正文（非 JSON）:', text.slice(0, 2000));
      process.exit(status >= 200 && status < 300 ? 0 : 1);
    }
    console.log(JSON.stringify(parsed, null, 2));
    if (!Array.isArray(parsed) && parsed && typeof parsed === 'object' && Array.isArray(parsed.data)) {
      console.error(
        '\n提示: 返回为 { data: [...] }，与旧文档中的顶层数组不同；官网/Vercel 代理已自动规范，直连看到此结构属正常。'
      );
    } else if (!Array.isArray(parsed)) {
      console.error('\n提示: 若非 { data: [...] } 且非数组，请核对接口是否变更。');
    }
    process.exit(status >= 200 && status < 300 ? 0 : 1);
  } catch (e) {
    console.error('请求失败:', e.message || e);
    process.exit(1);
  }
}

main();
