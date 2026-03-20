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

### 若日志 / 接口返回：`getaddrinfo ENOTFOUND …speedaf.com`

请先核对官方文档：正式环境域名为 **`https://apis.speedaf.com`**（**apis** 带 **s**），勿写成 `api.speedaf.com`（无 s，易 ENOTFOUND）。

本项目已在 **`vercel.json`** 中为 `api/track.js` 设置 **`regions`: `["hkg1"]`（香港）**。**请重新 Deploy**。  
（Vercel 已不再支持 `preferredRegion`，须用官方字段 **`regions`**。Hobby 套餐通常只能指定**一个**区域；Pro 可在该数组中增加 `sin1`、`icn1` 等。）

若仍失败，可在 Vercel 环境变量增加 **`TRACK_DNS_SERVERS`**（逗号分隔）。`api/track.js` 会 **`dns.lookup` → 失败则经 DoH 解析**，再 **`https` 连 `apis.speedaf.com`**。也可使用 **[tencent-scf](./tencent-scf/README.md)**。

## 前端部署在 GitHub Pages + 自有域名时（重要）

GitHub Pages **没有** `/api/track`，页面里的 `fetch('/api/track')` 会打到你的网站根域名，必然失败，随后会退回浏览器直连 Speedaf，再次出现 **CORS**。

请在 `index.html` 里把 `TRACK_PROXY` 改成你的 **Vercel 完整地址**，例如：

`https://你的项目名.vercel.app/api/track`

改完后重新 push 到 GitHub，等 Pages 更新后再试。

若在国内仍无法访问 `*.vercel.app`（连接被重置），**浏览器无法连上 Vercel 时查询必然失败**。请任选其一：

- 把代理部署到 **腾讯云 SCF + API 网关**（见 **[tencent-scf/README.md](./tencent-scf/README.md)**），网关路径建议 **`/api/track`**，与当前 `TRACK_PROXY` 一致。
- 或在 Vercel 绑定 **自定义子域**（如 `api.hkxhlogistics.com`）并做 DNS 解析；部分网络下比裸 `vercel.app` 略好，**不保证**国内一定通。

## 域名在腾讯云时（推荐国内访客 / Vercel 解析 Speedaf 失败时）

主站继续 **GitHub Pages**，将 **`api.hkxhlogistics.com` 的 DNS 从 Vercel 改为 API 网关**（详见 **[tencent-scf/README.md](./tencent-scf/README.md)**）。网关需暴露 **`POST /api/track`**；与 `index.html` 中 `TRACK_PROXY = 'https://api.hkxhlogistics.com/api/track'` 一致则**不必改前端**。
