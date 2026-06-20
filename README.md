# AnyRouter Quota Monitor

一个零依赖的 Chrome MV3 插件，**专注做两件事**：

1. **工具栏图标显示 AnyRouter 已使用额度**（令牌为无限额度时拿不到剩余余额，故展示已用）；
2. **主动探测 `claude-opus-4-8` 健康状态**（主站 + 大陆直连双线路），并在弹窗里逐条展示。

只需一个 API Key（`sk-xxx`）即可——用量查询与 opus 探测共用它，**不再需要用户 ID 或 Access Token**。

## 调用的接口

已使用额度来源是 new-api 的 OpenAI 兼容计费接口（走 `TokenAuth`，只认 `Authorization`，从令牌反查用户，无需用户 ID）：

| 用途 | 方法 / 路径 |
| --- | --- |
| 已使用额度（`total_usage`，美分） | `GET https://anyrouter.top/v1/dashboard/billing/usage?start_date=…&end_date=…` |

```
Authorization: Bearer <API Key>
```

> **已使用额度 = `total_usage / 100`**（new-api 中 1 USD = 500000 积分，接口已折算为 USD；日期参数 new-api 忽略，仅为兼容通用模板形态）。
> 因本账户令牌均为「无限额度」，计费接口给不出剩余余额，故图标展示**已使用额度**而非剩余。提取口径与 CC Switch「通用模板」一致（`used = total_usage / 100`）。
> 若 `usage` 接口拉取失败，插件不会把已用当 0，而是保留上次成功的用量并标注「刷新失败」。

## 运行状况探测（AI 健康检测）

为识别「网站界面正常、但 AI 模型已崩溃」的情况，插件主动发最小推理请求，判断模型是否真的在响应。
插件**同时探测两条线路**，并在弹窗的健康卡片中逐条展示各自的可用性、耗时与最近成功时间：

```
POST https://anyrouter.top/v1/messages                       ← 主站
POST https://a-ocnfniawgw.cn-shanghai.fcapp.run/v1/messages   ← 大陆直连
x-api-key: <API Key>
{ "model": "claude-opus-4-8", "max_tokens": 1, "messages": [{ "role": "user", "content": "hi" }] }
```

- 两条线路是同一服务的不同入口：**主站** `anyrouter.top` 与**大陆网络优化直连** `a-ocnfniawgw.cn-shanghai.fcapp.run`。
- **探测模型固定为 `claude-opus-4-8`**（即你实际使用的模型）：早期版本用轻量的 `claude-haiku-4-5` 探测，遇到 opus 不可用但 haiku 仍能响应时会误报「正常」；现在自动与手动探测都用 opus，探测结果与你的真实可用性一致。每次探测为 `max_tokens:1` 的最小请求，单次开销极小，但会以 opus 计入你的使用日志。
- **告警口径（三档）**：仅当**两条线路都探测失败**时，才把工具栏徽标染红「AI!」并弹系统通知；**仅一条线路异常**（另一条仍可用）时，徽标显示**紫色「AI」**作温和提示、不弹通知；两条都正常则徽标回到余额数字。只要任一条能通即视为 AI 可用。任一线路恢复后徽标会随下次探测（≤5 分钟，或手动刷新立即）自动复位，不再卡红。弹窗里两条线路始终各自独立显示状态（绿色正常 / 红色异常 / 灰色未检测）。
- **刷新间隔内置固定为 5 分钟**：配了 API Key 后两条线路即随余额每 5 分钟定时探测（双线路均失败会以 3 分钟密集重试并弹系统通知，恢复后自动复位；连续约 2 小时仍失败则停自动探测、等手动刷新）。顶栏「自动」开关可关闭这套后台周期探测，关闭后仅在点刷新按钮时探测。
- **点击弹窗右上角刷新按钮可强制立即探测两条线路一次**（无需等待 5 分钟周期）。

## 本地探测（可选，根治浏览器 fetch 的假 429）

**问题**：浏览器 `fetch()` 改不了 `User-Agent` 等被禁头，请求落不到 anyrouter 的「活通道」，会出现**主站明明能用却一直报 429（红色 AI!）**的假阳性。

**方案**：装一个本地探测 host（`native-host/`，PowerShell + `curl.exe`）。扩展通过 Chrome 原生消息（Native Messaging）调它，用**与真实 Claude Code 完全一致的请求**（带 `user-agent: claude-cli/…`）探活，真成功才判绿。host 隐藏运行、无窗口闪烁；**未安装时扩展自动回退到浏览器 fetch**，照常可用。

安装三步（**顺序很重要**）：

1. 先在 `chrome://extensions/` **重新加载扩展**（本版给 `manifest.json` 加了固定 `key`，扩展 ID 已固定，host 才能授权连接）。
2. 进入 `native-host/`，右键 `install.ps1` →「使用 PowerShell 运行」（或在该目录执行 `powershell -ExecutionPolicy Bypass -File install.ps1`）。脚本会写 native host 清单、注册到 Chrome/Edge、生成默认代理配置。
3. 点弹窗刷新按钮 ⟳ —— 健康卡片底部出现 **「本地探测 ✓」** 即表示已生效（未装时显示「浏览器探测 · 装本地探测更准」）。

- **代理**：主站 `anyrouter.top` 默认走 Clash `socks5h://127.0.0.1:7897`、大陆直连走直连。端口不同就改 `native-host/probe-config.json` 里的 `proxyMain`。
- **卸载**：运行 `native-host/uninstall.ps1`（仅删注册表项，文件保留），扩展自动回退到浏览器 fetch。
- 依赖系统自带的 `curl.exe`（Windows 10/11 默认就有）。

## 产品口径

- **图标数字**：展示已使用额度（USD）。数字压缩规则：`12.4` ≈ `$12.40`，`1.2k` ≈ `$1,200`，`<1` 表示不足 `$1`。
- **图标颜色**：完全由 AI 健康决定——**红色「AI!」**＝两条线路都失败、**紫色「AI」**＝单条线路异常、AI 正常为绿色；灰色＝未配置。
- **弹窗内容**：只展示两条线路的 opus 检测卡片（状态 / 耗时 / 最近成功时间）。已使用额度仅显示在工具栏图标上。

## 安装使用

1. 打开 Chrome 的 `chrome://extensions/`。
2. 开启右上角「开发者模式」。
3. 点击「加载已解压的扩展程序」。
4. 选择本目录（包含 `manifest.json`）。
5. 点击工具栏插件图标 → 右上角钥匙按钮，填写 **API Key**（AnyRouter 控制台「API 令牌」里的渠道令牌 `sk-xxx`）。
6. 点击「保存」，图标会自动刷新出余额、弹窗显示 opus 检测结果。

> 同一个 API Key 同时用作余额查询的 `Authorization: Bearer` 与 opus 探测的 `x-api-key`，两项功能共用一处配置。

## 文件结构

```text
manifest.json   Chrome MV3 配置（含固定 key、nativeMessaging 权限）
background.js   后台定时刷新、动态图标和 badge、AI 探测（本地 host 优先、fetch 回退）
usage.js        接口 URL、鉴权头、余额换算与健康状态计算、本地探测请求规格
popup.html      弹窗结构
popup.css       弹窗视觉样式
popup.js        配置弹窗、刷新和渲染逻辑
native-host/    可选本地探测 host（host.ps1 / host.bat / install.ps1 / uninstall.ps1）
README.md       使用说明
```

## 隐私与权限

- API Key 存储在 `chrome.storage.local`（键名 `apiToken`），不会同步到 Google 账号，也不会写入日志。
- 插件声明两个域名权限：`https://anyrouter.top/*`（余额计费接口 + 主站探测）与 `https://a-ocnfniawgw.cn-shanghai.fcapp.run/*`（大陆直连探测）。两者均为 AnyRouter 自有后端。
- `nativeMessaging` 权限仅用于（可选地）调用本地探测 host；不装 host 时该权限不产生任何外部行为。host 在本机以你的身份运行 `curl.exe`，API Key 经原生消息本地传给它、用于请求头，不落日志。
- 不读取浏览器 Cookie，不调用与 AnyRouter 无关的第三方服务。
