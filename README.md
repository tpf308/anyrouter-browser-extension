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
Authorization: <Access Token>
New-Api-User:  <用户 ID>
```

## 运行状况探测（AI 健康检测）

为识别「网站界面正常、但 AI 模型已崩溃」的情况，插件可主动发一个最小推理请求，判断模型是否真的在响应：

```
POST https://a-ocnfniawgw.cn-shanghai.fcapp.run/v1/messages
x-api-key: <API 令牌（渠道 API Key，sk-xxx）>
```

- 探测后端固定为「大陆网络优化」直连地址，与额度接口的 `anyrouter.top` 不同；需在设置中配置 API 令牌。
- 是否开启检测由「刷新间隔」控制：间隔 **> 0** 时随额度一起定时探测（探测失败会加密重试并弹系统通知，恢复后自动复位）；间隔设为 **0** 则关闭自动刷新与运行状况检测。
- **即使间隔设为 0（检测关闭），点击面板右上角刷新按钮仍会强制探测一次**，结果显示在面板的健康卡片上（标注「手动」）。关闭状态下的手动探测只在面板内展示，不会把工具栏徽标染红、也不发系统通知（这些仅在开启检测时生效）；卡片结果会在下次保存设置或再次手动刷新时回落为「已关闭」。

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
   - **用户 ID**：AnyRouter 控制台「个人设置」中的数字 ID
   - **Access Token**：控制台「个人设置 → 访问令牌」中生成并复制的令牌
6. 点击「保存」，面板会自动刷新并展示数据。

> Access Token 和 API Key（`sk-xxx`）不是同一个东西：前者是控制台账户层面的访问凭据（用于管理后台接口），后者是用于转发 LLM 请求的渠道令牌。本插件需要的是 **Access Token**。

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

- `userId`、`accessToken` 与 `apiToken` 存储在 `chrome.storage.local`，不会同步到 Google 账号，也不会写入日志。
- 插件声明两个域名权限：`https://anyrouter.top/*`（额度与统计接口）与 `https://a-ocnfniawgw.cn-shanghai.fcapp.run/*`（AI 运行状况探测）。两者均为 AnyRouter 自有后端。
- 不读取浏览器 Cookie，不调用与 AnyRouter 无关的第三方服务。
