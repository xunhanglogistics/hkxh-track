/**
 * 百度搜索资源平台 — 普通收录「API 提交 / 主动推送」
 * 文档：https://ziyuan.baidu.com 站内「资源提交」相关说明
 *
 * 使用前在平台获取：接口调用地址里的 site、token（与站点验证通过后一致）
 *
 * 用法：
 *   set BAIDU_PUSH_SITE=https://hkxhlogistics.com
 *   set BAIDU_PUSH_TOKEN=你的token
 *   node scripts/baidu-push-urls.js
 *
 * 或一条命令：
 *   BAIDU_PUSH_SITE=https://hkxhlogistics.com BAIDU_PUSH_TOKEN=xxx node scripts/baidu-push-urls.js
 *
 * 若无 Node.js，可用 PowerShell（无需 npm）：
 *   .\scripts\baidu-push-urls.ps1
 */

const http = require('http');

/** 百度接口要求 site 多为纯域名；若平台给的含 https:// 会自动去掉 */
function normalizeBaiduSite(site) {
  const s = String(site).trim().replace(/\/+$/, '');
  if (/^https?:\/\//i.test(s)) {
    try {
      return new URL(s).host;
    } catch {
      return s.replace(/^https?:\/\//i, '').split('/')[0] || s;
    }
  }
  return s;
}

const site = normalizeBaiduSite(process.env.BAIDU_PUSH_SITE || '');
const token = process.env.BAIDU_PUSH_TOKEN || '';

/** 首页 + 你有独立可访问路径时再往数组里加（与站点同域、完整 https URL） */
const URLS_TO_PUSH = [
  'https://hkxhlogistics.com/',
  // 示例：若以后做了独立页面再取消注释
  // 'https://hkxhlogistics.com/services.html',
];

function push() {
  if (!site || !token) {
    console.error(
      '请设置环境变量 BAIDU_PUSH_SITE（如 hkxhlogistics.com 或含 https:// 均可）和 BAIDU_PUSH_TOKEN（API 提交页里的 token）。'
    );
    process.exit(1);
  }

  const body = URLS_TO_PUSH.filter(Boolean).join('\n');
  const path =
    '/urls?site=' +
    encodeURIComponent(site) +
    '&token=' +
    encodeURIComponent(token);

  const req = http.request(
    {
      hostname: 'data.zz.baidu.com',
      port: 80,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Length': Buffer.byteLength(body, 'utf8'),
      },
    },
    (res) => {
      let chunks = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        chunks += c;
      });
      res.on('end', () => {
        console.log('HTTP', res.statusCode);
        try {
          console.log(JSON.stringify(JSON.parse(chunks), null, 2));
        } catch {
          console.log(chunks);
        }
      });
    }
  );

  req.on('error', (e) => {
    console.error(e.message);
    process.exit(1);
  });

  req.write(body);
  req.end();
}

push();
