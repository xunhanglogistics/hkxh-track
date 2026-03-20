# 腾讯云 SCF + API 网关：国内代理 Speedaf（推荐替代 Vercel）

正式环境接口域名为 **`https://apis.speedaf.com`**（见 [轨迹实时查询文档](https://apis.speedaf.com/doc/zh-cn/track_query.html)），勿误用 `api.speedaf.com`。把代理放在 **腾讯云 SCF** 可从国内访问该域名。

前端仓库里 **`index.html`** 已使用：

```text
https://api.hkxhlogistics.com/api/track
```

使用 **函数 URL** 后，前端要把 **`TRACK_PROXY` 改成控制台给出的完整 URL**（通常不是 `/api/track`，见第五节）。

---

## 部署前说明（重要）

| 项目 | 说明 |
|------|------|
| **子域 `api`** | 若绑定 **函数 URL 自定义域名**，`api` 的 DNS 指向腾讯云；**不要**再指到 Vercel。主站继续 **`www` / `@` → GitHub Pages**。 |
| **路径** | **函数 URL** 多为根路径 **`/`**；`TRACK_PROXY` 与控制台地址一致即可。 |
| **依赖** | 必须包含 **`crypto-js`**（与 `package.json` 一致）。 |

---

## 若控制台提示「API 网关停售」怎么办？

你看到的 **「API 网关产品停止售卖」** 一般是腾讯云对 **旧版 API 网关** 的调整，**不等于**不能对外提供 HTTPS。

请先做两件事：

1. 点公告里的 **「了解停售计划」**，按官方说明看 **替代产品名称**（可能是新版网关、或其它接入方式）与 **迁移指引**。  
2. 在函数详情页左侧打开 **「函数 URL」**（**不是**「创建触发器」下拉里找），按 [官方文档](https://cloud.tencent.com/document/product/583/100227) **新建函数 URL**。

**常见替代路径：**

| 方式 | 说明 |
|------|------|
| **函数 URL** | 左侧菜单 **函数 URL → 新建**，得公网 HTTPS；把 **`TRACK_PROXY`** 设为该完整地址。 |
| **API 网关触发器** | 2024-07-01 起**不可新建**，下拉里即使有也勿依赖。 |
| **TSE 云原生网关 / CLB** | 企业高级场景，配置更重。 |

**结论**：用 **「函数 URL」独立菜单** 创建端点，不要用「定时触发」等无关触发器。

---

## 一、本地打包（上传 SCF 用）

在本机进入 **`tencent-scf`** 目录：

```bash
npm install
```

将以下文件/目录打成 **zip 根目录即为这些条目**（不要多包一层文件夹）：

- `index.js`
- `package.json`
- `node_modules/`（整个目录）

**Windows**：可全选上述三项 → 右键「压缩为 zip」；或用 PowerShell：

```powershell
cd tencent-scf
npm install
Compress-Archive -Path index.js,package.json,node_modules -DestinationPath ..\scf-track.zip -Force
```

得到 **`scf-track.zip`** 备用。

---

## 二、创建云函数 SCF

1. 打开 [云函数 SCF 控制台](https://console.cloud.tencent.com/scf) → **新建** → **从头开始**。
2. **函数类型**：事件函数（默认即可）。
3. **运行环境**：**Node.js 18.15**（或 16/18 最新 LTS，需支持全局 **`fetch`**）。
4. **提交方法**：上传 **`scf-track.zip`**（上一步打的包）。
5. **执行方法**：`index.main_handler`（与 `exports.main_handler` 对应；若控制台默认 `main_handler` 亦可，以你创建模板为准，需指向本文件的 **`main_handler`**）。
6. **高级配置**：
   - **超时时间**：建议 **60 秒**（外调 Speedaf 可能较慢）。
   - **内存**：256MB 一般够用，可按监控上调。
7. **环境变量**（勿把密钥提交到 Git 公开仓库，在控制台填写）：

   | 变量名 | 说明 |
   |--------|------|
   | `SPEEDAF_APP_CODE` | 与 Vercel / 商务一致 |
   | `SPEEDAF_SECRET_KEY` | 与 Vercel / 商务一致 |
   | `SPEEDAF_CUSTOMER_CODE` | 与 Vercel / 商务一致 |
   | `SPEEDAF_PLATFORM_SOURCE` | 如 `HKXH` |

8. **部署** 函数。

**测试（可选）**：完成下一节「函数 URL」后，用 **`curl` 或 Postman** 直接请求公网地址。

---

## 三、创建「函数 URL」（当前推荐）

腾讯云公告：**2024 年 7 月 1 日起不再支持新建「API 网关触发器」**，基础 HTTP 场景请改用 **函数 URL**。

> **注意：「函数 URL」不在「创建触发器」的下拉列表里。**  
> 请在函数详情页左侧菜单点 **「函数 URL」**（与「触发器管理」并列）→ **「新建函数 URL」**。  
> 官方文档：[创建函数 URL](https://cloud.tencent.com/document/product/583/100227)。

1. 打开你的函数详情页 → 左侧 **函数 URL** → **新建函数 URL**。
2. **公网访问**：开启（网站从公网调用时必须开）。
3. **授权类型**：选 **开放**（无需鉴权 / 匿名），便于浏览器直接 POST；若选 CAM 鉴权，需按文档配签名，本仓库未实现。
4. **CORS**：若从 **其它域名** 的网页调用（如 GitHub Pages），建议开启 CORS，并允许 **POST**、**Content-Type** 等（与控制台选项一致）。
5. 确定后复制 **HTTPS 访问地址**（通常路径为 **`/`**，**没有** `/api/track`）。
6. 本机测试：

   ```bash
   curl -sS -X POST "https://你的函数URL（控制台复制的完整地址）" \
     -H "Content-Type: application/json" \
     -d '{"mailNoList":["ZA120210959708"]}'
   ```

   若返回轨迹 JSON 或 Speedaf 业务字段（而不是 ENOTFOUND），说明 **国内出口已通**。

`index.js` 已兼容 **API 网关旧事件** 与 **函数 URL 常用结构**（`requestContext.http.method` + `body`）。若仍 502，到 **日志查询** 里看报错，必要时把 **event** 打日志发给开发对照。

---

## 四、自定义域名 `api.hkxhlogistics.com`（可选）

函数 URL 控制台若提供 **自定义域名 / 绑定证书**，可将 **`api.hkxhlogistics.com`** 绑到该 URL（步骤以腾讯云当前界面为准，可使用 [免费 SSL 证书](https://console.cloud.tencent.com/ssl)）。

在 [DNSPod](https://console.cloud.tencent.com/cns) 为 **`api`** 添加控制台要求的 **CNAME**（并去掉仍指向 **Vercel** 的旧记录）。

---

## 五、改前端 `TRACK_PROXY`（使用函数 URL 时必做）

函数 URL 一般是 **根路径**，请把 `index.html` 里的地址改成 **控制台复制的完整 HTTPS 地址**，例如：

```javascript
var TRACK_PROXY = 'https://xxxxx.gz.tencentscf.com';
```

**不要**再写 `/api/track`，除非你在其它产品里单独配置了该路径。

若已绑定自定义域名且 HTTPS 可用：

```javascript
var TRACK_PROXY = 'https://api.hkxhlogistics.com';
```

改完后 **push 到 GitHub**，等 GitHub Pages 更新后再试查询。

---

## 六、常见问题

| 现象 | 处理 |
|------|------|
| **502 / 504** | 看 SCF **日志**；加长超时；确认集成服务、环境已**发布**。 |
| **依赖找不到** | zip 内必须含 **`node_modules`**，且与线上 Node 大版本一致。 |
| **CORS** | 本函数已返回 `Access-Control-Allow-Origin: *`；函数 URL 若仍报跨域，在触发器/函数 URL 设置里打开 **CORS**（若有）。 |
| **event 结构不同** | `console.log(JSON.stringify(event))` 看一次日志，把结果对照 `getMethod` / `parseEventBody`。 |

---

## 七、与 Vercel 的关系

- **轨迹查询**：建议 **只保留腾讯云** 这一条代理（当前方案）。
- **主站静态页**：可继续 **GitHub Pages**；`api` 子域专给 **函数 URL / 自定义域名**。
- 若仍希望 **Vercel 部署预览**：可用另一个子域（如 `preview-api.xxx`），不要与生产 `api` 冲突。
