# 腾讯云部署：用自有域名 `api.hkxhlogistics.com` 做轨迹代理

你的网站 **https://hkxhlogistics.com** 在 GitHub Pages，域名在腾讯云 DNS。可以这样拆：

| 记录 | 用途 |
|------|------|
| `@` / `www` | 继续指向 **GitHub Pages**（你现在的配置不变） |
| `api` 子域 | 指向 **腾讯云 API 网关 + 云函数**，专门给浏览器调 Speedaf |

---

## 一、腾讯云 DNS（你已买域名的地方）

1. 打开 [腾讯云 DNSPod / 解析](https://console.cloud.tencent.com/cns)，选域名 `hkxhlogistics.com`。
2. **不要动** 现在指向 GitHub 的 `@`、`www` 记录。
3. 等 **API 网关绑定自定义域名** 成功后，控制台会提示要加的解析（一般是 **CNAME** 到网关域名），按提示新增一条主机记录 **`api`** 即可。

---

## 二、创建云函数 SCF

1. 打开 [云函数 SCF](https://console.cloud.tencent.com/scf) → **新建** → 从头开始。
2. **运行环境**：Node.js 18 或 16（需支持原生 `fetch`，Node 18+ 自带）。
3. **提交方法**：本目录 `index.js` 内容复制到「函数代码」里（或打包 zip 上传）。
4. **高级配置 → 环境变量**（建议填写，勿依赖代码默认值）：
   - `SPEEDAF_APP_CODE`
   - `SPEEDAF_SECRET_KEY`
   - `SPEEDAF_CUSTOMER_CODE`
   - `SPEEDAF_PLATFORM_SOURCE`
5. **超时时间** 建议 ≥ 30 秒（外调 Speedaf 可能较慢）。
6. 保存并部署。

---

## 三、创建 API 网关并关联云函数

1. 打开 [API 网关](https://console.cloud.tencent.com/apigateway) → 新建 **HTTP API**（或「服务」里新建 API）。
2. 新建路由，例如：`POST /track`（路径可自定，与前端 `TRACK_PROXY` 一致即可）。
3. **后端类型** 选 **云函数 SCF**，绑定上一步的函数。
4. **发布** 服务/环境（如「发布」到正式环境）。

记下网关给出的 **默认访问地址**（可先用来测试）。

---

## 四、绑定自定义域名 `api.hkxhlogistics.com`

1. 在 API 网关该服务里找到 **自定义域名** → 添加 `api.hkxhlogistics.com`。
2. 按控制台说明申请/上传 **HTTPS 证书**（可使用腾讯云免费 SSL 证书）。
3. 在 **DNSPod** 为 `api` 添加控制台要求的 **CNAME**（指向网关分配的域名）。
4. 等待解析生效（通常几分钟到几十分钟）。

---

## 五、改网站前端

在仓库 `index.html` 里修改：

```javascript
var TRACK_PROXY = 'https://api.hkxhlogistics.com/track';
```

（若你在网关配置的路径是 `/` 而不是 `/track`，则改成对应完整 URL。）

提交并 push 到 GitHub，等 GitHub Pages 更新。

---

## 六、验证

浏览器打开：

`https://hkxhlogistics.com` → 输入单号 → 应能查到轨迹（请求发往 `api.hkxhlogistics.com`，经腾讯云出网访问 Speedaf）。

---

## 常见问题

- **网关返回 502**：检查 SCF 是否绑定正确、超时是否够、Node 版本是否 ≥ 18（需要 `fetch`）。
- **事件格式不对**：若网关集成方式较老，`event` 结构可能不同，可在 SCF 里临时 `console.log(JSON.stringify(event))` 看一次日志再微调 `parseEventBody`。
- **仍要省钱**：可选用按量计费 + 极低并发，具体以腾讯云账单为准。
