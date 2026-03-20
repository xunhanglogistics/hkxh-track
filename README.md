# hkxh-track

深圳市海凯讯航国际货运代理有限公司官方物流查询系统，提供全球包裹实时跟踪与物流信息查询服务。

## 部署到 Vercel（推荐，可解决 CORS）

1. 将本仓库推送到 GitHub（或使用 Vercel 支持的其它 Git）。
2. 打开 [vercel.com](https://vercel.com)，用 GitHub 登录。
3. 点击 **Import Project**，选择本仓库，保持默认设置，点击 **Deploy**。
4. 部署完成后，在项目 **Settings → Environment Variables** 中可选的环境变量（与 `api/track.js` 内默认一致时可省略）：
   - `SPEEDAF_APP_CODE`（默认 CN000796）
   - `SPEEDAF_SECRET_KEY`（默认 Ty2pi72K）
   - `SPEEDAF_CUSTOMER_CODE`（默认 CN000796）
   - `SPEEDAF_PLATFORM_SOURCE`（默认 HKXH）
5. 访问 Vercel 分配的域名（如 `https://xxx.vercel.app`），物流查询会通过 `/api/track` 代理请求 Speedaf，不再出现跨域错误。

## 前端部署在 GitHub Pages + 自有域名时（重要）

GitHub Pages **没有** `/api/track`，页面里的 `fetch('/api/track')` 会打到你的网站根域名，必然失败，随后会退回浏览器直连 Speedaf，再次出现 **CORS**。

请在 `index.html` 里把 `TRACK_PROXY` 改成你的 **Vercel 完整地址**，例如：

`https://你的项目名.vercel.app/api/track`

改完后重新 push 到 GitHub，等 Pages 更新后再试。

若在国内仍无法访问 `*.vercel.app`（连接被重置），需要把同一套代理部署到**国内可访问**的服务器（阿里云函数、腾讯云 SCF 等），并把 `TRACK_PROXY` 改成该地址；或在 Vercel 上绑定**自定义子域**（如 `api.你的域名.com`）并配置 DNS，有时可访问性会好于默认 `vercel.app`。
