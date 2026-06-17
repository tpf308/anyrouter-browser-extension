(function (root) {
  const QUOTA_PER_USD = 500000;
  const ANYROUTER_BASE_URL = "https://anyrouter.top";
  const USER_SELF_PATH = "/api/user/self";
  const DATA_SELF_PATH = "/api/data/self";
  const LOG_STAT_PATH = "/api/log/self/stat";
  const SUBSCRIPTION_SELF_PATH = "/api/subscription/self";
  const PROBE_PATH = "/v1/messages";
  // 探测专用后端：大陆网络优化直连地址（独立于额度接口的 siteUrl）
  const PROBE_BASE_URL = "https://a-ocnfniawgw.cn-shanghai.fcapp.run";
  const PROBE_MODEL = "claude-haiku-4-5-20251001";
  // 探测线路清单：主站与大陆直连后端各探一次，两条结果都展示。
  // 主站在前，与「同时探测 anyrouter.top 和 fcapp.run」的列举顺序一致。
  const PROBE_TARGETS = [
    { key: "main", name: "主站", baseUrl: ANYROUTER_BASE_URL }, // https://anyrouter.top
    { key: "cn", name: "大陆直连", baseUrl: PROBE_BASE_URL }, // a-ocnfniawgw.cn-shanghai.fcapp.run
  ];
  const PROBE_ANTHROPIC_VERSION = "2023-06-01";
  const PROBE_TIMEOUT_MS = 15000;
  const CONFIG_KEY = "anyrouterQuotaConfig";
  const SNAPSHOT_KEY = "anyrouterQuotaSnapshot";

  const MAX_RANGE_SECONDS = 2592000; // 后端限制最长 30 天

  // 刷新间隔已内置固定 5 分钟，不再由用户配置（设置面板已移除该字段）。
  const DEFAULT_REFRESH_MINUTES = 5;
  const MIN_REFRESH_MINUTES = 0;
  const MAX_REFRESH_MINUTES = 60;
  // AI 探测三段式：正常 5 min → 失败后 3 min 密集重试 → 累计 40 次（≈2h）仍失败 → 停止自动探测，等用户手动刷新
  const AGGRESSIVE_REFRESH_MINUTES = 3;
  const GIVE_UP_FAILURE_COUNT = 40;

  // 被动观察：你没在用 AI 时自动休眠，避免无谓探测。判据是 anyrouter 累计 request_count 的增长
  // （扣除我们自己的成功探测）——失败/超时的真实请求也会让它增长，所以崩溃期照样能判定「你在用」、继续探测告警。
  const IDLE_THRESHOLD_MINUTES = 30; // 连续无真实请求达到此时长 → 进入休眠（停探测、停额度刷新）
  const DORMANT_REFRESH_MINUTES = 15; // 休眠期心跳间隔：只读 request_count 探知你是否回来，绝不发 AI 探测

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

  const quotaToUsd = (quota) => toNumber(quota) / QUOTA_PER_USD;

  const formatUsd = (value) => `$${toNumber(value).toFixed(2)}`;

  const formatCount = (value) => Math.round(toNumber(value)).toLocaleString("zh-CN");

  const formatToken = (value) => {
    const n = Math.round(toNumber(value));
    if (n >= 1_000_000) {
      const m = n / 1_000_000;
      const s = m >= 100 ? Math.round(m) : m >= 10 ? m.toFixed(1) : m.toFixed(2);
      return `${s}M`;
    }
    return n.toLocaleString("zh-CN");
  };

  const clamp01 = (value) => Math.min(Math.max(value, 0), 1);

  const normalizeSiteUrl = (siteUrl) => {
    const raw = (typeof siteUrl === "string" ? siteUrl : "").trim();
    if (!raw) return ANYROUTER_BASE_URL;
    try {
      const u = new URL(raw);
      return `${u.protocol}//${u.host}`;
    } catch (error) {
      return ANYROUTER_BASE_URL;
    }
  };

  // 取 URL 主机名做展示（如 anyrouter.top）；非法串原样回退
  const hostOf = (url) => {
    try {
      return new URL(url).host;
    } catch (error) {
      return String(url || "");
    }
  };

  const normalizeAccessToken = (token) => (typeof token === "string" ? token.trim() : "");

  const normalizeApiToken = (token) => (typeof token === "string" ? token.trim() : "");

  const normalizeUserId = (userId) => {
    const n = toNumberOrNull(userId);
    return n && n > 0 ? Math.floor(n) : null;
  };

  const normalizeRefreshMinutes = (value) => {
    const n = toNumberOrNull(value);
    if (n === null) return DEFAULT_REFRESH_MINUTES;
    return Math.min(Math.max(Math.floor(n), MIN_REFRESH_MINUTES), MAX_REFRESH_MINUTES);
  };

  // 根据「是否在用 AI」(休眠) 与「上次探测连续失败次数」挑选实际刷新周期：
  //   休眠中(你没在用)   → 休眠心跳间隔（≥ 正常间隔，只读 request_count、不探测）—— 优先级最高
  //   连续失败 ≥ 40 次   → null（停自动探测，等手动刷新）
  //   连续失败 1–39 次   → AGGRESSIVE（3 min 密集重试）
  //   正常              → 内置固定间隔（5 min）
  // 间隔已内置固定，不再读取 config.refreshMinutes（保留 config 形参以兼容调用方）。
  const getEffectiveRefreshMinutes = (config, probeState, activityState) => {
    const base = DEFAULT_REFRESH_MINUTES; // 内置固定 5 min
    // 空闲优先：你没在用 AI 时，无论 AI 是否异常都进入休眠心跳，不再主动探测
    if (activityState?.mode === "dormant") return Math.max(DORMANT_REFRESH_MINUTES, base);
    const fails = toNumber(probeState?.consecutiveFailures);
    if (fails >= GIVE_UP_FAILURE_COUNT) return null;
    if (fails >= 1) return AGGRESSIVE_REFRESH_MINUTES;
    return base;
  };

  // 运行状况检测已随「内置 5 min 刷新」常开；是否真正发探测仍由 hasValidApiToken / 活跃状态门控。
  const normalizeHealthEnabled = () => true;

  // 被动活跃判定：根据上轮活跃状态 + 本轮读到的累计 request_count，判断「是否检测到真实使用」并给出新的休眠/活跃模式。
  // 本轮探测结果未知时也能调用——successfulProbeTotal 的滚动累加交由调用方在拿到探测结果后完成
  // （成功探测会被平台计入 request_count，失败探测不计入，故只扣成功的那部分）。
  const decideActivityMode = (prevActivity, totalRequestCount, { now, forcePresent = false } = {}) => {
    const prevProbeTotal = toNumber(prevActivity?.successfulProbeTotal);
    // 本轮 request_count 只反映「此前」已记账的成功探测，用旧的 prevProbeTotal 还原真实用户请求数
    const userCount = Math.max(0, toNumber(totalRequestCount) - prevProbeTotal);
    const baselined = Boolean(prevActivity?.baselined);
    const prevUserCount = toNumber(prevActivity?.lastUserRequestCount);

    // 首次无基线、或手动刷新（你显然在场）、或真实请求数变大 → 记为「刚刚活跃」
    const sawActivity = forcePresent || !baselined || userCount > prevUserCount;
    const lastActivityAt = sawActivity ? now : toNumber(prevActivity?.lastActivityAt) || now;
    const idleMs = now - lastActivityAt;
    const mode = baselined && idleMs >= IDLE_THRESHOLD_MINUTES * 60000 ? "dormant" : "active";

    return {
      userCount,
      sawActivity,
      // 钳位：吸收探测日志 1 拍延迟造成的瞬时回退，保证只有真实请求能推动基线
      nextLastUserRequestCount: Math.max(prevUserCount, userCount),
      lastActivityAt,
      mode,
    };
  };

  const hasValidConfig = (config) =>
    Boolean(normalizeAccessToken(config?.accessToken)) && Boolean(normalizeUserId(config?.userId));

  const hasValidApiToken = (config) => Boolean(normalizeApiToken(config?.apiToken));

  const buildAuthHeaders = (config) => ({
    Authorization: normalizeAccessToken(config?.accessToken),
    "New-Api-User": String(normalizeUserId(config?.userId)),
    Accept: "application/json",
  });

  // 按给定 baseUrl 拼探测端点（/v1/messages）；缺省回退大陆优化后端
  const buildProbeUrl = (baseUrl) => new URL(PROBE_PATH, baseUrl || PROBE_BASE_URL).toString();

  // AnyRouter 是 Anthropic 协议代理，使用 /v1/messages + x-api-key
  const buildProbeHeaders = (config) => ({
    "x-api-key": normalizeApiToken(config?.apiToken),
    "anthropic-version": PROBE_ANTHROPIC_VERSION,
    "Content-Type": "application/json",
    Accept: "application/json",
  });

  const buildProbeBody = (model) =>
    JSON.stringify({
      model: model || PROBE_MODEL,
      max_tokens: 1,
      messages: [{ role: "user", content: "hi" }],
    });

  const buildUrl = (config, path, params) => {
    const base = normalizeSiteUrl(config?.siteUrl);
    const url = new URL(path, base);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
      }
    }
    return url.toString();
  };

  const buildUserUrl = (config) => buildUrl(config, USER_SELF_PATH);

  const buildDataUrl = (config, startTs, endTs) =>
    buildUrl(config, DATA_SELF_PATH, {
      start_timestamp: Math.floor(startTs),
      end_timestamp: Math.ceil(endTs),
    });

  const buildLogStatUrl = (config) => buildUrl(config, LOG_STAT_PATH, { type: 0 });

  const buildSubscriptionUrl = (config) => buildUrl(config, SUBSCRIPTION_SELF_PATH);

  // 计算今日 0 点（本地时区）和本周 7 天起点的 unix 秒
  const computeTimestamps = () => {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000;
    const weekStart = Math.floor(Date.now() / 1000) - 7 * 24 * 3600;
    const nowSec = Math.floor(Date.now() / 1000);
    return {
      nowSec,
      todayStart: Math.floor(todayStart),
      weekStart: Math.floor(weekStart),
    };
  };

  // 聚合一段数据看板记录
  const aggregate = (rows, sinceTs) => {
    let count = 0;
    let quota = 0;
    let tokens = 0;
    if (!Array.isArray(rows)) return { count, quota, tokens };
    for (const row of rows) {
      const createdAt = toNumber(row?.created_at);
      if (sinceTs && createdAt < sinceTs) continue;
      count += toNumber(row?.count);
      quota += toNumber(row?.quota);
      tokens += toNumber(row?.token_used);
    }
    return { count, quota, tokens };
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

  const getStatus = (remainingUsd, weeklyBudgetUsd) => {
    if (remainingUsd <= 0) {
      return {
        tone: "danger",
        label: "暂无可用额度",
        description: "实时剩余额度为 0，请尽快处理额度。",
        ratio: 0,
      };
    }
    if (weeklyBudgetUsd <= 0) {
      return {
        tone: "good",
        label: "额度可用",
        description: "未检测到订阅周限，按实时剩余额度展示。",
        ratio: null,
      };
    }
    const ratio = remainingUsd / weeklyBudgetUsd;
    if (ratio < 0.1) {
      return {
        tone: "danger",
        label: "额度紧张",
        description: "剩余额度低于周限额度 10%。",
        ratio,
      };
    }
    if (ratio < 0.25) {
      return {
        tone: "warn",
        label: "接近预警",
        description: "剩余额度低于周限额度 25%。",
        ratio,
      };
    }
    return {
      tone: "good",
      label: "额度充足",
      description: "当前剩余额度处于健康区间。",
      ratio,
    };
  };

  const formatUnixDate = (unix) => {
    const n = toNumber(unix);
    if (n <= 0) return "-";
    const d = new Date(n * 1000);
    if (Number.isNaN(d.getTime())) return "-";
    const pad = (x) => String(x).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
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
  // 入参 sub：{ lastCheckedAt, lastResult, lastSuccessAt, lastErrorMessage, latencyMs, consecutiveFailures }
  //   isAggregate：是否为聚合状态。仅聚合的连续失败数驱动「停自动探测」（见 getEffectiveRefreshMinutes，
  //   只读聚合 consecutiveFailures）；单条线路在另一条还通时并不会真的停探，故 false 时不显示「已停止自动探测」。
  // 出参：{ state, tone, label, description, metaText (副标签：耗时或相对时间), lastSuccessText, lastSuccessTs }
  const statusFromProbe = (sub, enabled, isAggregate = true) => {
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
        label: enabled ? "运行正常" : "运行正常（手动）",
        description: `探测耗时 ${formatMillis(latency)}（${checkedRel}）`,
        metaText: formatMillis(latency),
        lastSuccessText,
        lastSuccessTs: lastSuccessAt,
      };
    }

    // 失败
    const errMsg = (ps.lastErrorMessage || "").toString().slice(0, 120) || "未知错误";
    const consecutive = toNumber(ps.consecutiveFailures);
    const giveUp = isAggregate && enabled && consecutive >= GIVE_UP_FAILURE_COUNT;
    return {
      state: "unhealthy",
      tone: "danger",
      label: enabled ? "AI 异常" : "AI 异常（手动）",
      description: giveUp
        ? `${errMsg}（已连续失败 ${consecutive} 次，已停止自动探测；点击右上角刷新按钮可手动重试）`
        : `${errMsg}（${checkedRel}${consecutive > 1 ? `，连续失败 ${consecutive} 次` : ""}）`,
      metaText: checkedRel,
      lastSuccessText,
      lastSuccessTs: lastSuccessAt,
    };
  };

  // 主动探测的健康状态：聚合 health（顶层字段，驱动徽标/通知/重试）+ 每条线路 health（health.targets[]，供面板逐条展示）。
  // 聚合口径「任一线路成功即成功」已由后台写入 probeState 顶层字段（见 mergeProbeState），此处沿用，故现有消费方零改动。
  const computeHealth = (probeState, config) => {
    const enabled = normalizeHealthEnabled(config);
    const ps0 = probeState || {};
    // 关闭自动监测时，仍展示「最近一次手动探测」（点右上角刷新触发）的结果；
    // 普通刷新一旦不再探测会清空 source，从而回落到「已关闭」
    const hasManualProbe = ps0.source === "manual" && toNumber(ps0.lastCheckedAt) > 0;

    // 没有 API 令牌时根本无法探测：优先提示（无论开关状态），避免「已关闭」却让用户点刷新探测的矛盾
    if (!hasValidApiToken(config)) {
      return {
        state: "no-token",
        tone: "idle",
        label: "缺少 API 令牌",
        description: "未配置 API 令牌，无法进行主动探测。",
        metaText: "-",
        lastSuccessText: "-",
        lastSuccessTs: 0,
        targets: [],
      };
    }

    if (!enabled && !hasManualProbe) {
      return {
        state: "disabled",
        tone: "idle",
        label: "已关闭",
        description: "自动检测已关闭（刷新间隔为 0）。点击右上角刷新按钮可手动探测一次，或将刷新间隔设为大于 0 开启。",
        metaText: "-",
        lastSuccessText: "-",
        lastSuccessTs: 0,
        targets: [],
      };
    }

    // 聚合 health：沿用 probeState 顶层聚合字段（与改造前完全一致）
    const aggregate = statusFromProbe(ps0, enabled);
    // 每条线路独立 health，供面板渲染两行。isAggregate=false：单条线路失败不显示「已停止自动探测」
    // （真正的停探只看聚合连续失败数，另一条还通时本条仍在随每次刷新被探测）。
    const targets = (Array.isArray(ps0.targets) ? ps0.targets : []).map((t) => ({
      key: t.key,
      name: t.name,
      host: hostOf(t.baseUrl),
      ...statusFromProbe(t, enabled, false),
    }));

    return { ...aggregate, targets };
  };

  // 从 /api/subscription/self 提取活跃订阅
  const extractActiveSubscription = (subResponse) => {
    if (!subResponse?.success) return null;
    const payload = subResponse.data || {};
    const active = Array.isArray(payload.subscriptions) ? payload.subscriptions : [];
    const all = Array.isArray(payload.all_subscriptions) ? payload.all_subscriptions : [];
    const list = active.length > 0 ? active : all;
    if (list.length === 0) return null;
    // 选 end_time 最大的一条作为当前订阅
    let pick = null;
    for (const s of list) {
      const sub = s?.subscription || s;
      if (!sub) continue;
      if (!pick || toNumber(sub.end_time) > toNumber(pick.end_time)) pick = sub;
    }
    return pick;
  };

  // 把订阅的 amount_total / reset_period 换算成日限 & 周限
  const computeBudgetsFromSubscription = (sub, planMap) => {
    if (!sub) return { dailyBudgetUsd: 0, weeklyBudgetUsd: 0 };
    const total = toNumber(sub.amount_total);
    const totalUsd = quotaToUsd(total);
    const resetPeriod = (sub.quota_reset_period || sub.reset_period || "").toString().toLowerCase();

    let dailyBudgetUsd = 0;
    let weeklyBudgetUsd = 0;

    if (resetPeriod === "daily" || resetPeriod === "day") {
      dailyBudgetUsd = totalUsd;
      weeklyBudgetUsd = totalUsd * 7;
    } else if (resetPeriod === "weekly" || resetPeriod === "week") {
      weeklyBudgetUsd = totalUsd;
      dailyBudgetUsd = totalUsd / 7;
    } else if (resetPeriod === "monthly" || resetPeriod === "month") {
      weeklyBudgetUsd = totalUsd / 4;
      dailyBudgetUsd = totalUsd / 30;
    } else {
      // 不重置或自定义周期：把订阅期内总额度按天/周分摊
      const start = toNumber(sub.start_time);
      const end = toNumber(sub.end_time);
      const span = Math.max(end - start, 86400);
      const days = Math.max(span / 86400, 1);
      dailyBudgetUsd = totalUsd / days;
      weeklyBudgetUsd = (totalUsd / days) * 7;
    }
    return { dailyBudgetUsd, weeklyBudgetUsd };
  };

  // 整合所有响应得到展示用的 data。
  // 注：data.health 现在由后台主动探测后注入，extractUsage 不再计算。
  const extractUsage = ({
    userResponse,
    dataResponse,
    logStatResponse,
    subscriptionResponse,
  }) => {
    if (!userResponse?.success || !userResponse.data) {
      return {
        isValid: false,
        invalidMessage: userResponse?.message || "无法获取账户信息",
      };
    }

    const user = userResponse.data;
    const remainingUsd = quotaToUsd(user.quota);
    const totalUsedUsd = quotaToUsd(user.used_quota);
    const totalRequests = toNumber(user.request_count);

    const ts = computeTimestamps();
    const { todayStart, weekStart } = ts;

    // 数据看板可能失败，失败时今日/本周回落到 0
    const dataRows = dataResponse?.success ? dataResponse.data : [];
    const todayAgg = aggregate(dataRows, todayStart);
    const weekAgg = aggregate(dataRows, weekStart);
    const totalAggInRange = aggregate(dataRows, 0);

    // log/self/stat 给的是最近的 rpm/tpm
    const rpm = toNumber(logStatResponse?.data?.rpm);
    const tpm = toNumber(logStatResponse?.data?.tpm);

    const subscription = extractActiveSubscription(subscriptionResponse);
    const { dailyBudgetUsd, weeklyBudgetUsd } = computeBudgetsFromSubscription(subscription);

    const todayUsedUsd = quotaToUsd(todayAgg.quota);
    const weekUsedUsd = quotaToUsd(weekAgg.quota);

    const status = getStatus(remainingUsd, weeklyBudgetUsd);

    const subscriptionStart = subscription ? formatUnixDate(subscription.start_time) : "-";
    const subscriptionEnd = subscription ? formatUnixDate(subscription.end_time) : "-";

    return {
      isValid: true,
      planName: "AnyRouter",
      unit: "USD",

      // 主指标
      total: weeklyBudgetUsd,
      used: weekUsedUsd,
      remaining: remainingUsd,

      // 用户信息
      userId: toNumber(user.id),
      username: user.username || "-",
      displayName: user.display_name || user.username || "-",
      group: user.group || "default",

      // 数额
      dailyBudgetUsd,
      weeklyBudgetUsd,
      todayUsedUsd,
      weekUsedUsd,
      totalUsedUsd,
      weekRemainingUsd: remainingUsd,
      todayCalls: todayAgg.count,
      todayTokens: todayAgg.tokens,
      weekCalls: weekAgg.count,
      weekTokens: weekAgg.tokens,
      totalRequests,
      totalTokens: totalAggInRange.tokens, // 近 7 天 token 合计（接口未提供历史总量）
      rpm,
      tpm,
      subscriptionStart,
      subscriptionEnd,

      // 状态（health 由后台注入）
      status,
      badgeText: formatBadgeValue(remainingUsd),
      weekUsedRatio: weeklyBudgetUsd > 0 ? clamp01(weekUsedUsd / weeklyBudgetUsd) : 0,

      formatted: {
        dailyBudget: formatUsd(dailyBudgetUsd),
        weeklyBudget: formatUsd(weeklyBudgetUsd),
        todayUsed: formatUsd(todayUsedUsd),
        weekUsed: formatUsd(weekUsedUsd),
        totalUsed: formatUsd(totalUsedUsd),
        weekRemaining: formatUsd(remainingUsd),
        todayCalls: formatCount(todayAgg.count),
        todayTokens: formatToken(todayAgg.tokens),
        weekCalls: formatCount(weekAgg.count),
        totalRequests: formatCount(totalRequests),
        totalTokens: formatToken(totalAggInRange.tokens),
        rpm: formatCount(rpm),
        tpm: formatToken(tpm),
      },
    };
  };

  root.UsageQuota = {
    ANYROUTER_BASE_URL,
    CONFIG_KEY,
    DATA_SELF_PATH,
    DEFAULT_REFRESH_MINUTES,
    LOG_STAT_PATH,
    MAX_REFRESH_MINUTES,
    MIN_REFRESH_MINUTES,
    PROBE_BASE_URL,
    PROBE_MODEL,
    PROBE_PATH,
    PROBE_TARGETS,
    PROBE_TIMEOUT_MS,
    SUBSCRIPTION_SELF_PATH,
    QUOTA_PER_USD,
    SNAPSHOT_KEY,
    AGGRESSIVE_REFRESH_MINUTES,
    GIVE_UP_FAILURE_COUNT,
    IDLE_THRESHOLD_MINUTES,
    DORMANT_REFRESH_MINUTES,
    USER_SELF_PATH,
    MAX_RANGE_SECONDS,
    aggregate,
    buildAuthHeaders,
    buildDataUrl,
    buildLogStatUrl,
    buildProbeBody,
    buildProbeHeaders,
    buildProbeUrl,
    buildSubscriptionUrl,
    buildUserUrl,
    computeHealth,
    computeTimestamps,
    decideActivityMode,
    extractUsage,
    formatBadgeValue,
    formatCount,
    formatMillis,
    formatRelativeTime,
    formatTimeShort,
    formatToken,
    formatUsd,
    formatUnixDate,
    getEffectiveRefreshMinutes,
    hasValidApiToken,
    hasValidConfig,
    hostOf,
    normalizeAccessToken,
    normalizeApiToken,
    normalizeHealthEnabled,
    normalizeRefreshMinutes,
    normalizeSiteUrl,
    normalizeUserId,
    quotaToUsd,
    toNumber,
    toNumberOrNull,
  };
})(globalThis);
