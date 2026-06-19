(function (root) {
  const ANYROUTER_BASE_URL = "https://anyrouter.top";
  const PROBE_PATH = "/v1/messages";
  // 已使用额度来源：OpenAI 兼容计费接口（走 new-api 的 TokenAuth）。只需 API Key（Authorization: Bearer），
  // 不需要用户 ID——令牌本身即可定位用户。令牌为「无限额度」时拿不到剩余余额，故展示**已使用额度**。
  // 带宽松日期区间以兼容通用模板（CC Switch 等）的请求形态；new-api 的 GetUsage 实际忽略日期，
  // 只返回累计 total_usage（美分）。used = total_usage / 100。
  const BILLING_USAGE_PATH = "/v1/dashboard/billing/usage";
  const BILLING_USAGE_QUERY = "start_date=2024-01-01&end_date=2026-12-31";
  // 探测专用后端：大陆网络优化直连地址
  const PROBE_BASE_URL = "https://a-ocnfniawgw.cn-shanghai.fcapp.run";
  // 探测目标模型：用户实际使用的 claude-opus-4-8。
  //
  // 关键背景（经抓包逆向）：anyrouter 把 /v1/messages 分成两条上游——
  //   · 「活通道」(opus-4-8 真能用)：只接收「看起来像 Claude Code」的请求；
  //   · 「死通道」：其它请求一律回 503。
  // 要落到活通道，必须同时满足（缺一即 503）：
  //   1) URL 带 ?beta=true（见 buildProbeUrl）；
  //   2) 1m 上下文 beta 头 context-1m-2025-08-07（见 buildProbeHeaders）；
  //   3) body 带 metadata.user_id（device/session 结构，值可任意，只校验格式）；
  //   4) system 首块为 CC 计费头标记、次块为 CC 身份行（见下两常量）；
  //   5) body 带 stream:true（实测非流式会间歇性触发上游 520，流式稳定回 200/429）。
  // 因此探测「伪装成 Claude Code」——这样它走的正是用户真实 CC 走的那条通道，
  // 结果与用户的真实可用性一致：opus 对 CC 可用 → 200(绿)；连 CC 都用不了 → 非 200(红)。
  // 判定（见 background.js probeModel）：200 与 429（活通道在线，429=限流但可用）视为正常；
  // 503 / 400 / 其它非 2xx / 网络错视为异常。
  const PROBE_TARGET_MODEL = "claude-opus-4-8";
  const PROBE_ANTHROPIC_BETA = "context-1m-2025-08-07";
  const PROBE_MAX_TOKENS = 16;
  // 落到活通道所需的 CC 签名（实测只校验格式、不校验具体值；cc_version 用一个真实近期版本即可）
  const PROBE_BILLING_SYSTEM = "x-anthropic-billing-header: cc_version=2.1.183; cc_entrypoint=cli;";
  const PROBE_CLI_SYSTEM = "You are Claude Code, Anthropic's official CLI for Claude.";
  // 探测线路清单：主站与大陆直连后端各探一次，两条结果都展示。
  const PROBE_TARGETS = [
    { key: "main", name: "主站", baseUrl: ANYROUTER_BASE_URL }, // https://anyrouter.top
    { key: "cn", name: "大陆直连", baseUrl: PROBE_BASE_URL }, // a-ocnfniawgw.cn-shanghai.fcapp.run
  ];
  const PROBE_ANTHROPIC_VERSION = "2023-06-01";
  const PROBE_TIMEOUT_MS = 15000;
  const CONFIG_KEY = "anyrouterQuotaConfig";
  const SNAPSHOT_KEY = "anyrouterQuotaSnapshot";

  // 刷新间隔已内置固定 5 分钟，不再由用户配置。
  const DEFAULT_REFRESH_MINUTES = 5;
  // AI 探测三段式：正常 5 min → 失败后 3 min 密集重试 → 累计 40 次（≈2h）仍失败 → 停止自动探测，等手动刷新
  const AGGRESSIVE_REFRESH_MINUTES = 3;
  const GIVE_UP_FAILURE_COUNT = 40;

  const toNumberOrNull = (value) => {
    if (value === null || value === undefined || value === "") return null;
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value === "string") {
      const normalized = value.replace(/[$,\s]/g, "");
      if (!normalized) return null;
      const parsed = Number(normalized);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  };

  const toNumber = (value, fallback = 0) => {
    const parsed = toNumberOrNull(value);
    return parsed === null ? fallback : parsed;
  };

  const formatUsd = (value) => `$${toNumber(value).toFixed(2)}`;

  // 取 URL 主机名做展示（如 anyrouter.top）；非法串原样回退
  const hostOf = (url) => {
    try {
      return new URL(url).host;
    } catch (error) {
      return String(url || "");
    }
  };

  const normalizeApiToken = (token) => (typeof token === "string" ? token.trim() : "");

  const hasValidApiToken = (config) => Boolean(normalizeApiToken(config?.apiToken));
  // 精简后凭据只剩单个 API Key：配置有效 == 有 API Key
  const hasValidConfig = (config) => hasValidApiToken(config);

  // 计费接口鉴权：Authorization: Bearer <API Key>（TokenAuth 会剥掉 Bearer/sk- 前缀按令牌查用户）
  const buildBillingHeaders = (config) => ({
    Authorization: `Bearer ${normalizeApiToken(config?.apiToken)}`,
    Accept: "application/json",
  });

  const buildBillingUsageUrl = () =>
    new URL(`${BILLING_USAGE_PATH}?${BILLING_USAGE_QUERY}`, ANYROUTER_BASE_URL).toString();

  // 按给定 baseUrl 拼探测端点：/v1/messages?beta=true（?beta=true 是落到活通道的必要条件之一）
  const buildProbeUrl = (baseUrl) =>
    new URL(`${PROBE_PATH}?beta=true`, baseUrl || PROBE_BASE_URL).toString();

  // 探测鉴权用 x-api-key（与计费接口同一个 API Key）。anthropic-beta 带 1m 上下文，
  // 配合 ?beta=true 与 body 里的 CC 签名，才能落到 opus-4-8 的活通道（详见 PROBE_TARGET_MODEL 注释）。
  const buildProbeHeaders = (config) => ({
    "x-api-key": normalizeApiToken(config?.apiToken),
    "anthropic-version": PROBE_ANTHROPIC_VERSION,
    "anthropic-beta": PROBE_ANTHROPIC_BETA,
    "Content-Type": "application/json",
    Accept: "application/json",
  });

  // 生成随机 64 位 hex 作设备指纹占位（活通道只校验 metadata 格式、不校验具体值）
  const randomHex = (len) => {
    const bytes = new Uint8Array(len / 2);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  };

  // 探测请求体：伪装成 Claude Code，以落到 opus-4-8 的活通道（见 PROBE_TARGET_MODEL 注释）。
  // 消息仅 "hi"、max_tokens 16，模型只回几个 token，单次开销极小。stream:true 必须带（见上注释第 5 条）。
  const buildProbeBody = (model) =>
    JSON.stringify({
      model: model || PROBE_TARGET_MODEL,
      max_tokens: PROBE_MAX_TOKENS,
      stream: true,
      system: [
        { type: "text", text: PROBE_BILLING_SYSTEM },
        { type: "text", text: PROBE_CLI_SYSTEM },
      ],
      metadata: {
        user_id: JSON.stringify({
          device_id: randomHex(64),
          account_uuid: "",
          session_id: crypto.randomUUID(),
        }),
      },
      messages: [{ role: "user", content: "hi" }],
    });

  // 根据聚合探测的连续失败次数挑选刷新周期：
  //   连续失败 ≥ 40 次 → null（停自动探测，等手动刷新）
  //   连续失败 1–39 次 → AGGRESSIVE（3 min 密集重试）
  //   正常            → 内置固定间隔（5 min）
  const getEffectiveRefreshMinutes = (probeState) => {
    const fails = toNumber(probeState?.consecutiveFailures);
    if (fails >= GIVE_UP_FAILURE_COUNT) return null;
    if (fails >= 1) return AGGRESSIVE_REFRESH_MINUTES;
    return DEFAULT_REFRESH_MINUTES;
  };

  const formatBadgeValue = (value) => {
    const amount = Math.max(toNumber(value), 0);
    if (amount === 0) return "0";
    if (amount < 1) return "<1";
    if (amount < 10) return amount.toFixed(1).replace(/\.0$/, "");
    if (amount < 1000) return `${Math.round(amount)}`;
    if (amount < 10000) return `${(amount / 1000).toFixed(1).replace(/\.0$/, "")}k`;
    if (amount < 1000000) return `${Math.round(amount / 1000)}k`;
    return `${Math.round(amount / 1000000)}m`;
  };

  // 展示「已使用额度」：used = total_usage/100（美分→USD）。
  // usageOk=false / 缺 total_usage / error 体 → 无效，让上层回落到上次成功的用量。
  const extractUsed = (usageBody, usageOk = true) => {
    if (!usageOk || !usageBody || typeof usageBody !== "object" || usageBody.error) {
      return { isValid: false, invalidMessage: usageBody?.error?.message || "无法获取用量信息" };
    }
    const usedRaw = toNumberOrNull(usageBody.total_usage);
    if (usedRaw === null) {
      return { isValid: false, invalidMessage: "用量响应缺少 total_usage" };
    }
    const used = usedRaw / 100;
    return {
      isValid: true,
      used,
      badgeText: formatBadgeValue(used),
      formatted: { used: formatUsd(used) },
    };
  };

  const formatMillis = (ms) => {
    const n = Math.max(Math.round(toNumber(ms)), 0);
    if (n < 1000) return `${n} ms`;
    return `${(n / 1000).toFixed(1)} s`;
  };

  const formatRelativeTime = (msTimestamp) => {
    const t = toNumber(msTimestamp);
    if (t <= 0) return "-";
    const diff = Math.max(Math.floor((Date.now() - t) / 1000), 0);
    if (diff < 5) return "刚刚";
    if (diff < 60) return `${diff} 秒前`;
    if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
    return `${Math.floor(diff / 86400)} 天前`;
  };

  const formatTimeShort = (msTimestamp) => {
    const t = toNumber(msTimestamp);
    if (t <= 0) return "-";
    const d = new Date(t);
    if (Number.isNaN(d.getTime())) return "-";
    const pad = (x) => String(x).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };

  // 把一份探测子状态映射成展示用 health。聚合状态与每条线路状态都用它，保证口径一致。
  //   isAggregate：仅聚合的连续失败数驱动「停自动探测」（见 getEffectiveRefreshMinutes）；
  //   单条线路在另一条还通时并不会真的停探，故 false 时不显示「已停止自动探测」。
  const statusFromProbe = (sub, isAggregate = true) => {
    const ps = sub || {};
    const lastSuccessAt = toNumber(ps.lastSuccessAt);
    const lastSuccessText = lastSuccessAt > 0 ? formatTimeShort(lastSuccessAt) : "-";

    if (!ps.lastCheckedAt) {
      return {
        state: "unknown",
        tone: "idle",
        label: "未检测",
        description: "尚未发起任何探测，等待下次刷新。",
        metaText: "-",
        lastSuccessText,
        lastSuccessTs: lastSuccessAt,
      };
    }

    const checkedRel = formatRelativeTime(ps.lastCheckedAt);

    if (ps.lastResult === "success") {
      const latency = toNumber(ps.latencyMs);
      return {
        state: "healthy",
        tone: "good",
        label: "运行正常",
        description: `探测耗时 ${formatMillis(latency)}（${checkedRel}）`,
        metaText: formatMillis(latency),
        lastSuccessText,
        lastSuccessTs: lastSuccessAt,
      };
    }

    // 失败
    const errMsg = (ps.lastErrorMessage || "").toString().slice(0, 120) || "未知错误";
    const consecutive = toNumber(ps.consecutiveFailures);
    const giveUp = isAggregate && consecutive >= GIVE_UP_FAILURE_COUNT;
    return {
      state: "unhealthy",
      tone: "danger",
      label: "AI 异常",
      description: giveUp
        ? `${errMsg}（已连续失败 ${consecutive} 次，已停止自动探测；点击右上角刷新按钮可手动重试）`
        : `${errMsg}（${checkedRel}${consecutive > 1 ? `，连续失败 ${consecutive} 次` : ""}）`,
      metaText: checkedRel,
      lastSuccessText,
      lastSuccessTs: lastSuccessAt,
    };
  };

  // 主动探测的健康状态：聚合 health（顶层，驱动徽标/通知/重试）+ 每条线路 health（targets[]，供面板逐条展示）。
  // 聚合口径「任一线路成功即成功」已由后台写入 probeState 顶层字段（见 mergeProbeState）。
  const computeHealth = (probeState, config) => {
    const ps0 = probeState || {};

    // 没有 API Key 时根本无法探测
    if (!hasValidApiToken(config)) {
      return {
        state: "no-token",
        tone: "idle",
        label: "缺少 API Key",
        description: "未配置 API Key，无法进行主动探测。",
        metaText: "-",
        lastSuccessText: "-",
        lastSuccessTs: 0,
        targets: [],
      };
    }

    const aggregate = statusFromProbe(ps0, true);
    // 每条线路独立 health，供面板渲染两行。isAggregate=false：单条线路失败不显示「已停止自动探测」。
    const targets = (Array.isArray(ps0.targets) ? ps0.targets : []).map((t) => ({
      key: t.key,
      name: t.name,
      host: hostOf(t.baseUrl),
      ...statusFromProbe(t, false),
    }));

    // 部分降级：聚合仍 healthy（至少一条线路通），但有线路实测失败 → 标记 partial（徽标紫色提示）。
    const downCount = targets.filter((t) => t.state === "unhealthy").length;
    const partial = aggregate.state === "healthy" && downCount > 0;

    return { ...aggregate, partial, targets };
  };

  root.UsageQuota = {
    ANYROUTER_BASE_URL,
    AGGRESSIVE_REFRESH_MINUTES,
    BILLING_USAGE_PATH,
    CONFIG_KEY,
    DEFAULT_REFRESH_MINUTES,
    GIVE_UP_FAILURE_COUNT,
    PROBE_BASE_URL,
    PROBE_TARGET_MODEL,
    PROBE_PATH,
    PROBE_TARGETS,
    PROBE_TIMEOUT_MS,
    SNAPSHOT_KEY,
    buildBillingHeaders,
    buildBillingUsageUrl,
    buildProbeBody,
    buildProbeHeaders,
    buildProbeUrl,
    computeHealth,
    extractUsed,
    formatBadgeValue,
    formatMillis,
    formatRelativeTime,
    formatTimeShort,
    formatUsd,
    getEffectiveRefreshMinutes,
    hasValidApiToken,
    hasValidConfig,
    hostOf,
    normalizeApiToken,
    toNumber,
    toNumberOrNull,
  };
})(globalThis);
