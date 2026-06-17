# AnyRouter Quota Monitor

一个零依赖的 Chrome MV3 插件，用于读取 AnyRouter（new-api 体系）的用户额度与使用统计，UI 复刻自同系列的 CodexZH 插件。

工具栏图标直接展示实时可用额度，点击图标可在面板中查看今日、本周、累计、订阅等详情。

## 调用的接口（额度数据：https://anyrouter.top）

| 用途 | 方法 / 路径 |
| --- | --- |
| 用户基础信息 | `GET /api/user/self` |
| 数据看板（按小时聚合的请求/Token/额度） | `GET /api/data/self?start_timestamp=&end_timestamp=` |
| 实时速率（RPM/TPM） | `GET /api/log/self/stat?type=0` |
| 当前订阅信息 | `GET /api/subscription/self` |

所有请求都使用以下 header：

```
Authorization: <API Key>
New-Api-User:  <用户 ID>
```

> 自 v2.1.1 起，设置面板只保留**用户 ID** 与单个 **API Key** 两项：该 API Key 同时用作额度查询的 `Authorization` 与站点探测的 `x-api-key`（详见下文「凭据说明」）。

## 运行状况探测（AI 健康检测）

为识别「网站界面正常、但 AI 模型已崩溃」的情况，插件可主动发最小推理请求，判断模型是否真的在响应。
插件会**同时探测两条线路**，并在面板的健康卡片中逐条展示各自的可用性、耗时与最近成功时间：

```
POST https://anyrouter.top/v1/messages                       ← 主站
POST https://a-ocnfniawgw.cn-shanghai.fcapp.run/v1/messages   ← 大陆直连
x-api-key: <API Key>
```

- 两条线路是同一服务的不同入口：**主站** `anyrouter.top` 与**大陆网络优化直连** `a-ocnfniawgw.cn-shanghai.fcapp.run`；探测需在设置中配置 API Key。
- **告警口径：仅当两条线路都探测失败时**，才把工具栏徽标染红「AI!」并弹系统通知；只要任一条能通即视为 AI 可用。面板里两条线路始终各自独立显示状态（绿色正常 / 红色异常 / 灰色未检测）。
- **刷新间隔已内置固定为 5 分钟**，设置面板不再暴露该选项：配置 API Key 后两条线路即随额度一起每 5 分钟定时探测（双线路均失败会以 3 分钟密集重试并弹系统通知，恢复后自动复位；连续约 2 小时仍失败则停自动探测、等手动刷新）。你长时间未实际使用 AI 时会自动转入休眠心跳（仅读累计请求数、不发探测），回来后自动恢复。
- **点击面板右上角刷新按钮可强制立即探测两条线路一次**（无需等待 5 分钟周期），结果显示在面板的健康卡片上（标注「手动」）。

## 产品口径

- **图标数字**：展示实时剩余额度 `quota / 500000`（new-api 中 1 USD = 500000 积分）。
- **图标颜色**：绿色表示剩余额度 ≥ 周限额度 25%，橙色低于 25%，红色低于 10% 或已用尽，灰色表示未配置，深橙表示显示的是上次成功数据。
- **数字压缩**：`12.4` 表示约 `$12.40`，`1.2k` 表示约 `$1,200`，`<1` 表示不足 `$1`。完整金额在面板内展示。
- **面板主指标**：实时可用额度、本周已用、周限额度、今日消费。
- **面板详情**：今日调用 / Token / 日限额度 / 本周调用 / 总请求次数 / 总使用额度 / 总使用 Token / RPM / TPM / 订阅开始 / 订阅到期。
- **今日/本周用量**：从 `/api/data/self` 按用户本地时区聚合当日 0 点后或近 7 天的记录得到。`/api/data/self` 失败时回退为 0，但实时余额仍可展示。
- **日限/周限**：根据 `/api/subscription/self` 中订阅的 `amount_total` 与重置周期（daily/weekly/monthly/never）换算；订阅缺失时显示 `$0.00`。

## 安装使用

1. 打开 Chrome 的 `chrome://extensions/`。
2. 开启右上角「开发者模式」。
3. 点击「加载已解压的扩展程序」。
4. 选择本目录（包含 `manifest.json`）。
5. 点击工具栏插件图标 → 右上角钥匙按钮，填写：
   - **用户 ID**：AnyRouter 控制台「个人设置」中的数字 ID（可留空，此时仅做站点检测、不查额度）
   - **API Key**：用于鉴权的令牌（见下方「凭据说明」）
6. 点击「保存」，面板会自动刷新并展示数据。

### 凭据说明

为简化设置，本插件把额度查询用的 **Access Token** 与站点探测用的渠道 **API Key（`sk-xxx`）** 合并成了同一个 **API Key** 输入框——填入的值会同时用作两类请求的鉴权头。

> ⚠️ 注意：在 AnyRouter（new-api 体系）里这两者本是**不同**的令牌——Access Token 是控制台账户层面的访问凭据（走 `Authorization`，用于管理后台接口查额度），渠道 API Key 则用于转发 LLM 请求（走 `x-api-key`，用于站点探测）。合并成一个字段后：
>
> - 填 **Access Token** → 额度查询可用，站点探测可能失败；
> - 填渠道 **API Key（`sk-xxx`）** → 站点探测可用，额度查询可能失败。
>
> 只有当你的同一个令牌恰好被两类接口都接受时，两项功能才会同时可用。若发现其中一项不工作，多半就是这个原因。

## 文件结构

```text
manifest.json   Chrome MV3 配置
background.js   后台定时刷新、动态图标和 badge
usage.js        接口 URL、鉴权头、金额转换和数据聚合
popup.html      插件面板结构
popup.css       面板视觉样式
popup.js        配置弹窗、刷新和渲染逻辑
README.md       使用说明
```

## 隐私与权限

- `userId` 与 API Key 存储在 `chrome.storage.local`（API Key 同时写入 `accessToken` 与 `apiToken` 两个键），不会同步到 Google 账号，也不会写入日志。
- 插件声明两个域名权限：`https://anyrouter.top/*`（额度与统计接口）与 `https://a-ocnfniawgw.cn-shanghai.fcapp.run/*`（AI 运行状况探测）。两者均为 AnyRouter 自有后端。
- 不读取浏览器 Cookie，不调用与 AnyRouter 无关的第三方服务。
