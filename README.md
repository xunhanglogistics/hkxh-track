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
