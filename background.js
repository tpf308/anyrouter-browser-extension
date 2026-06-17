importScripts("usage.js");

const FETCH_TIMEOUT_MS = 12000;
const ALARM_NAME = "anyrouter-quota-refresh";
const NOTIFICATION_DOWN_ID = "anyrouter-ai-down";
const NOTIFICATION_UP_ID = "anyrouter-ai-up";

const TONE_COLORS = {
  good: "#0f9f6e",
  warn: "#d97706",
  danger: "#dc2626",
  unknown: "#64748b",
  error: "#b91c1c",
  stale: "#92400e",
  idle: "#475569",
  loading: "#2563eb",
};

const storageGet = (keys) =>
  new Promise((resolve) => {
    chrome.storage.local.get(keys, resolve);
  });

const storageSet = (items) =>
  new Promise((resolve) => {
    chrome.storage.local.set(items, resolve);
  });

const getConfig = async () => {
  const result = await storageGet(UsageQuota.CONFIG_KEY);
  return result[UsageQuota.CONFIG_KEY] || {};
};

const getSnapshot = async () => {
  const result = await storageGet(UsageQuota.SNAPSHOT_KEY);
  return result[UsageQuota.SNAPSHOT_KEY] || null;
};

const setSnapshot = async (snapshot, { renderActionState = true } = {}) => {
  await storageSet({ [UsageQuota.SNAPSHOT_KEY]: snapshot });
  if (renderActionState) {
    await renderAction(snapshot);
  }
  return snapshot;
};

const scheduleRefresh = async ({ immediate = true } = {}) => {
  const config = await getConfig();
  const snapshot = await getSnapshot();
  const periodMinutes = UsageQuota.getEffectiveRefreshMinutes(
    config,
    snapshot?.probeState,
    snapshot?.activityState
  );
  // null = 给入「放弃」档：清掉 alarm，等用户手动点刷新
  if (periodMinutes === null) {
    chrome.alarms.clear(ALARM_NAME);
    return;
  }
  const opts = { periodInMinutes: periodMinutes };
  if (immediate) opts.delayInMinutes = 0.2; // 12 秒后触发首次刷新
  chrome.alarms.create(ALARM_NAME, opts);
};

const getActionState = (snapshot) => {
  if (!snapshot || snapshot.state === "unconfigured") {
    return {
      badge: "SET",
      tone: "idle",
      title: "AnyRouter Quota：请先配置 API Key + 用户 ID",
      ratio: null,
    };
  }

  if (snapshot.state === "loading") {
    return {
      badge: "...",
      tone: "loading",
      title: "AnyRouter Quota：正在刷新额度",
      ratio: null,
    };
  }

  // 仅探测（未登录/登录失效但配了 API 令牌）：工具栏只反映 AI 健康，不展示额度
  if (snapshot.state === "probe-only") {
    const health = snapshot.health;
    const enabled = snapshot.probeState?.enabled === true;
    // 沿用「仅开启监测时才让 AI 异常染红」的约定，避免监测关时手动探测把工具栏卡红
    const isAiDown = health?.state === "unhealthy" && enabled;
    return {
      badge: isAiDown ? "AI!" : "SET",
      tone: isAiDown ? "danger" : "idle",
      title: [
        isAiDown
          ? `AnyRouter：AI 探测失败（${health.description || "未知错误"}）`
          : "AnyRouter Quota：仅站点检测（未登录）",
        health?.label ? `AI 状态：${health.label}` : "",
        "配置 API Key + 用户 ID 可查看额度",
      ]
        .filter(Boolean)
        .join("\n"),
      ratio: null,
    };
  }

  if (snapshot.data) {
    const data = snapshot.data;
    const isStale = snapshot.state === "stale";
    const health = data.health;
    // 仅在「开启检测」(刷新间隔>0) 时，让 AI 异常接管工具栏徽标；
    // 关闭时（间隔=0）的手动探测结果只在面板卡片展示，不把工具栏染红、也不发通知，
    // 否则关闭状态下没有自动 tick 来复位，红色 AI! 会卡死。
    const isAiDown = health?.state === "unhealthy" && snapshot.probeState?.enabled === true;

    // 红色（danger）只保留给「AI 模型异常」告警；额度等级与抓取失败一律不用红色，
    // 避免红色示警含义被稀释（诉求：只有检测到 AI 崩溃才变红）。
    let tone;
    if (isAiDown) {
      tone = "danger";                         // 唯一的红色来源：AI 崩溃告警
    } else if (data.status.tone === "danger") {
      tone = "warn";                           // 额度耗尽/极低 → 橙色，不与 AI 告警的红色混淆
    } else {
      tone = data.status.tone;                 // good / warn：stale 快照（仅 onStartup 重绘）沿用上次额度色，保持原样
    }
    const badge = isAiDown ? "AI!" : data.badgeText;

    const headlineLine = isAiDown
      ? `AnyRouter：AI 探测失败（${health.description || "未知错误"}）`
      : isStale
        ? "AnyRouter Quota：显示上次成功数据，刷新失败"
        : "AnyRouter Quota";

    return {
      badge,
      tone,
      title: [
        headlineLine,
        `实时剩余 ${data.formatted.weekRemaining}`,
        `本周已用 ${data.formatted.weekUsed} / 周限 ${data.formatted.weeklyBudget}`,
        health && health.state !== "unknown" && health.state !== "disabled" && health.state !== "no-token"
          ? `AI 状态：${health.label}（${health.metaText}）`
          : "",
        snapshot.updatedAt ? `更新时间 ${new Date(snapshot.updatedAt).toLocaleString("zh-CN")}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
      ratio: data.status.ratio,
    };
  }

  // 抓取额度失败且无缓存数据：用琥珀色提示，不变红（红色仅用于 AI 告警）
  return {
    badge: "ERR",
    tone: "stale",
    title: `AnyRouter Quota：${snapshot.errorMessage || "查询失败"}`,
    ratio: null,
  };
};

const roundRect = (ctx, x, y, width, height, radius) => {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
};

const drawIcon = (size, tone) => {
  if (typeof OffscreenCanvas === "undefined") return null;

  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext("2d");
  const scale = size / 32;

  ctx.clearRect(0, 0, size, size);

  // AnyRouter 视觉主色：青绿渐变
  const grad = ctx.createLinearGradient(0, 0, size, size);
  grad.addColorStop(0, "#22c4a8");
  grad.addColorStop(1, "#0ea5a3");

  const r = 7 * scale;
  roundRect(ctx, 0, 0, size, size, r);
  ctx.fillStyle = grad;
  ctx.fill();

  // 状态色小圆点（右上角）
  const dotColor = TONE_COLORS[tone] || TONE_COLORS.idle;
  if (tone !== "idle" && tone !== "unknown") {
    const dotR = 4.5 * scale;
    const dotX = size - dotR - 1 * scale;
    const dotY = dotR + 1 * scale;
    ctx.beginPath();
    ctx.arc(dotX, dotY, dotR, 0, Math.PI * 2);
    ctx.fillStyle = dotColor;
    ctx.fill();
  }

  return ctx.getImageData(0, 0, size, size);
};

const renderAction = async (snapshot) => {
  const state = getActionState(snapshot);
  const color = TONE_COLORS[state.tone] || TONE_COLORS.idle;

  await chrome.action.setTitle({ title: state.title });
  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setBadgeTextColor({ color: "#ffffff" });
  await chrome.action.setBadgeText({ text: state.badge.slice(0, 4) });

  const imageData = {};
  for (const size of [16, 32, 48, 128]) {
    const icon = drawIcon(size, state.tone);
    if (icon) imageData[size] = icon;
  }

  if (Object.keys(imageData).length > 0) {
    await chrome.action.setIcon({ imageData });
  }
};

const fetchJson = async (url, headers, signal) => {
  const response = await fetch(url, {
    method: "GET",
    headers,
    cache: "no-store",
    signal,
  });

  let body = null;
  try {
    body = await response.json();
  } catch (error) {
    body = null;
  }
  return { response, body };
};

const isAuthFailure = (response, body) => {
  if (response?.status === 401 || response?.status === 403) return true;
  const message = (body?.message || "").toString();
  return /access\s*token|未登录|登录|无权|user.*id|token.*invalid|mismatch/i.test(message);
};

const showNotification = (id, options) =>
  new Promise((resolve) => {
    try {
      chrome.notifications.create(
        id,
        {
          type: "basic",
          iconUrl: "icon128.png",
          priority: 2,
          requireInteraction: false,
          ...options,
        },
        () => {
          const err = chrome.runtime.lastError;
          if (err) console.warn("notify failed:", err.message);
          resolve();
        }
      );
    } catch (error) {
      console.warn("notify threw:", error?.message);
      resolve();
    }
  });

const clearNotification = (id) =>
  new Promise((resolve) => {
    try {
      chrome.notifications.clear(id, () => resolve());
    } catch (error) {
      resolve();
    }
  });

// 把一条线路的本轮结果滚动并到上次子状态上。res 形如 {key,name,baseUrl,success,latencyMs,errorMessage}。
const mergeOne = (prevSub, res, now) => {
  const sub = {
    key: res.key,
    name: res.name,
    baseUrl: res.baseUrl,
    lastCheckedAt: now,
    lastSuccessAt: Number(prevSub?.lastSuccessAt) || 0,
    lastResult: prevSub?.lastResult || null,
    lastErrorMessage: prevSub?.lastErrorMessage || "",
    latencyMs: Number(res.latencyMs) || 0,
    consecutiveFailures: Number(prevSub?.consecutiveFailures) || 0,
  };
  if (res.success) {
    sub.lastResult = "success";
    sub.lastSuccessAt = now;
    sub.lastErrorMessage = "";
    sub.consecutiveFailures = 0;
  } else {
    sub.lastResult = "fail";
    sub.lastErrorMessage = res.errorMessage || "未知错误";
    sub.consecutiveFailures = (Number(prevSub?.consecutiveFailures) || 0) + 1;
  }
  return sub;
};

// 把本次 probe 结果累加到上次 probeState 上：聚合字段（驱动徽标/通知/重试/放弃）+ 各线路子状态 targets[]。
// 聚合口径「任一线路成功即成功」：成功清零顶层连续失败，全失败才累加——故红色徽标/通知只在两条都挂时触发。
// probeResult === null 表示本轮没探（关了或没令牌），保留旧状态但更新 enabled。
const mergeProbeState = (prev, probeResult, enabled, source) => {
  const base = {
    enabled: Boolean(enabled),
    lastCheckedAt: Number(prev?.lastCheckedAt) || 0,
    lastSuccessAt: Number(prev?.lastSuccessAt) || 0,
    lastResult: prev?.lastResult || null,
    lastErrorMessage: prev?.lastErrorMessage || "",
    latencyMs: Number(prev?.latencyMs) || 0,
    consecutiveFailures: Number(prev?.consecutiveFailures) || 0,
    // 各线路子状态：本轮未探测时原样带过上次的，供面板继续展示
    targets: Array.isArray(prev?.targets) ? prev.targets : [],
    // 本轮未探测（probeResult === null）时清空 source；用于「关闭监测」下手动探测的结果
    // 在下一次普通刷新后回落到「已关闭」展示
    source: null,
  };

  if (!probeResult) return base;

  const now = Date.now();
  base.lastCheckedAt = now;
  base.latencyMs = Number(probeResult.latencyMs) || 0;
  base.source = source === "manual" ? "manual" : "auto";

  // 按 key 把上次子状态与本轮各线路结果合并
  const prevByKey = {};
  for (const sub of base.targets) {
    if (sub && sub.key) prevByKey[sub.key] = sub;
  }
  const resultTargets = Array.isArray(probeResult.targets) ? probeResult.targets : [];
  base.targets = resultTargets.map((res) => mergeOne(prevByKey[res.key], res, now));

  if (probeResult.success) {
    base.lastResult = "success";
    base.lastSuccessAt = now;
    base.lastErrorMessage = "";
    base.consecutiveFailures = 0;
  } else {
    base.lastResult = "fail";
    base.lastErrorMessage = probeResult.errorMessage || "未知错误";
    base.consecutiveFailures = (Number(prev?.consecutiveFailures) || 0) + 1;
  }

  return base;
};

// 探测单条线路：发一个最小请求到该线路的 /v1/messages，判断 AI 模型是否真的在响应。
const probeOne = async (config, target) => {
  const url = UsageQuota.buildProbeUrl(target.baseUrl);
  const headers = UsageQuota.buildProbeHeaders(config);
  const body = UsageQuota.buildProbeBody(UsageQuota.PROBE_MODEL);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UsageQuota.PROBE_TIMEOUT_MS);
  const startedAt = Date.now();

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body,
      cache: "no-store",
      signal: controller.signal,
    });
    const latencyMs = Date.now() - startedAt;

    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (!response.ok) {
      const msg =
        payload?.error?.message ||
        payload?.message ||
        `HTTP ${response.status}`;
      return { success: false, latencyMs, errorMessage: msg };
    }

    // OpenAI 兼容格式：返回必须包含 choices；Anthropic 兼容则有 content。
    // 同时拦截 200 + error 的诡异情况。
    if (payload?.error) {
      return {
        success: false,
        latencyMs,
        errorMessage: payload.error?.message || "模型返回错误",
      };
    }

    const hasChoices = Array.isArray(payload?.choices) && payload.choices.length > 0;
    const hasContent = Array.isArray(payload?.content) && payload.content.length > 0;
    if (!hasChoices && !hasContent) {
      return {
        success: false,
        latencyMs,
        errorMessage: "响应格式异常，未返回模型输出",
      };
    }

    return { success: true, latencyMs, errorMessage: "" };
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    const isTimeout = error?.name === "AbortError";
    return {
      success: false,
      latencyMs,
      errorMessage: isTimeout
        ? `探测超时（>${Math.round(UsageQuota.PROBE_TIMEOUT_MS / 1000)}s）`
        : error?.message || "网络错误",
    };
  } finally {
    clearTimeout(timer);
  }
};

// 主动探测：对所有线路（主站 + 大陆直连）并发探测，判断 AI 模型是否真的在响应。
// 聚合口径：任一线路成功即视为成功；仅当全部线路失败才算失败（驱动徽标/通知/重试）。
// 返回 successCount（成功线路条数），供活跃度记账按实际计入 request_count 的探测数扣除。
const probeAi = async (config) => {
  const targets = UsageQuota.PROBE_TARGETS;

  if (!UsageQuota.hasValidApiToken(config)) {
    return {
      success: false,
      successCount: 0,
      latencyMs: 0,
      errorMessage: "缺少 API 令牌",
      targets: targets.map((t) => ({
        key: t.key,
        name: t.name,
        baseUrl: t.baseUrl,
        success: false,
        latencyMs: 0,
        errorMessage: "缺少 API 令牌",
      })),
    };
  }

  const results = await Promise.all(
    targets.map(async (t) => {
      const r = await probeOne(config, t);
      return {
        key: t.key,
        name: t.name,
        baseUrl: t.baseUrl,
        success: Boolean(r.success),
        latencyMs: Number(r.latencyMs) || 0,
        errorMessage: r.errorMessage || "",
      };
    })
  );

  const succeeded = results.filter((r) => r.success);
  const successCount = succeeded.length;
  const anySuccess = successCount > 0;

  // 聚合时延：有成功线路取最快的（用户最关心「最快能多快通」）；全失败取最慢的（更能反映卡顿时长）
  const latencyMs = anySuccess
    ? Math.min(...succeeded.map((r) => r.latencyMs))
    : results.reduce((max, r) => Math.max(max, r.latencyMs), 0);

  // 全失败时给聚合错误信息，附一条线路的失败原因作示例
  let errorMessage = "";
  if (!anySuccess) {
    const sample = results.find((r) => r.errorMessage)?.errorMessage || "未知错误";
    errorMessage = `两条线路均失败（示例：${sample}）`;
  }

  return { success: anySuccess, successCount, latencyMs, errorMessage, targets: results };
};

// 仅在 healthy/unknown/disabled ↔ unhealthy 之间翻转时弹通知，避免每分钟重复打扰
const maybeNotifyHealth = async (prevHealth, nextHealth, enabled) => {
  if (!nextHealth) return;
  // 关闭检测（间隔=0）时不弹 AI 通知——手动探测结果只在面板展示；并清掉可能残留的故障通知
  if (!enabled) {
    await clearNotification(NOTIFICATION_DOWN_ID);
    return;
  }
  const wasDown = prevHealth?.state === "unhealthy";
  const nowDown = nextHealth.state === "unhealthy";

  if (!wasDown && nowDown) {
    await clearNotification(NOTIFICATION_UP_ID);
    await showNotification(NOTIFICATION_DOWN_ID, {
      title: "AnyRouter：AI 探测失败",
      message: `${nextHealth.description || "模型未响应"}。你正在使用的 AI 客户端可能也会卡住，建议尽快检查。`,
    });
    return;
  }

  // 离开 unhealthy（恢复正常或转为「已关闭」等）都清掉故障通知；仅在确认恢复正常时才弹恢复提示
  if (wasDown && !nowDown) {
    await clearNotification(NOTIFICATION_DOWN_ID);
    if (nextHealth.state === "healthy") {
      await showNotification(NOTIFICATION_UP_ID, {
        title: "AnyRouter：AI 服务恢复",
        message: `主动探测成功，${nextHealth.description || "模型已正常响应"}。`,
      });
    }
  }
};

// 仅探测：未登录（无 Access Token/用户 ID）或登录失效时，只要配了 API 令牌就单独探测一次站点，
// 不查额度。结果存成带 health 的快照供面板展示；手动点刷新与按间隔自动监控都走这里。
const runProbeOnly = async (config, { previous = null, source = "manual" } = {}) => {
  const healthEnabled = UsageQuota.normalizeHealthEnabled(config);
  const probeResult = await probeAi(config);
  const probeState = mergeProbeState(previous?.probeState, probeResult, healthEnabled, source);
  const health = UsageQuota.computeHealth(probeState, config);

  // 自动监控时 AI 异常/恢复照常通知；监测关闭（间隔=0）时 enabled=false，maybeNotifyHealth 自动不弹
  const prevHealth = previous?.health || previous?.data?.health || null;
  await maybeNotifyHealth(prevHealth, health, healthEnabled);

  return setSnapshot({
    state: "probe-only",
    updatedAt: Date.now(),
    errorMessage: "",
    // 未登录没有额度数据；保留上次额度（若有），但面板在 probe-only 下只展示探测卡片
    data: previous?.data || null,
    health,
    probeState,
    activityState: previous?.activityState || null,
  });
};

const fetchUsage = async ({ forceProbe = false } = {}) => {
  const config = await getConfig();
  const previous = await getSnapshot();

  // 探测只需 API 令牌：未登录时无活跃/休眠状态，按 healthEnabled（间隔>0）或手动强制判定是否探测
  const wantProbe =
    (forceProbe || UsageQuota.normalizeHealthEnabled(config)) && UsageQuota.hasValidApiToken(config);
  const probeSource = forceProbe ? "manual" : "auto";

  if (!UsageQuota.hasValidConfig(config)) {
    // 未登录但配了 API 令牌：手动/自动都仍探测站点，不卡在「未配置」
    if (wantProbe) return runProbeOnly(config, { previous, source: probeSource });
    return setSnapshot({
      state: "unconfigured",
      updatedAt: null,
      errorMessage: "请配置 API Key 和用户 ID",
    });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const headers = UsageQuota.buildAuthHeaders(config);
    const { todayStart, nowSec, weekStart } = UsageQuota.computeTimestamps();

    const userUrl = UsageQuota.buildUserUrl(config);
    const dataUrl = UsageQuota.buildDataUrl(config, weekStart, nowSec);
    const logStatUrl = UsageQuota.buildLogStatUrl(config);
    const subscriptionUrl = UsageQuota.buildSubscriptionUrl(config);

    // /api/user/self 是关键，先单独发以便处理鉴权失败
    const { response: userRes, body: userBody } = await fetchJson(userUrl, headers, controller.signal);

    if (isAuthFailure(userRes, userBody)) {
      // 登录令牌失效：额度查不了，但有 API 令牌时仍探测站点，避免「登录过期连检测都用不了」
      if (wantProbe) return runProbeOnly(config, { previous, source: probeSource });
      return setSnapshot({
        state: "unconfigured",
        updatedAt: null,
        errorMessage: userBody?.message || "API Key 或用户 ID 无效",
      });
    }

    if (!userRes.ok || !userBody?.success) {
      throw new Error(userBody?.message || `HTTP ${userRes.status}`);
    }

    // 被动活跃判定：anyrouter 累计 request_count 是否增长（已在 decideActivityMode 内扣除自己的成功探测）
    // 决定你是否真的在用 AI；据此门控探测、并在你离开 ~30min 后转入休眠。
    const totalRequestCount = UsageQuota.toNumber(userBody.data?.request_count);
    const prevActivity = previous?.activityState || {};
    const activity = UsageQuota.decideActivityMode(prevActivity, totalRequestCount, {
      now: Date.now(),
      forcePresent: forceProbe, // 手动刷新视为你在场
    });

    // 其他三个接口并发查询，单个失败不致命
    const fetchOptional = async (url) => {
      try {
        const { response, body } = await fetchJson(url, headers, controller.signal);
        if (!response.ok) return null;
        return body;
      } catch (error) {
        return null;
      }
    };

    // 与额度接口同 tick 主动探测 AI 健康。
    // 自动探测仅在「开启监测 且 处于活跃」时进行；手动点刷新（forceProbe）无视监测开关与休眠，强制探一次。
    const healthEnabled = UsageQuota.normalizeHealthEnabled(config);
    const shouldProbe =
      ((healthEnabled && activity.mode === "active") || forceProbe) && UsageQuota.hasValidApiToken(config);
    const probePromise = shouldProbe ? probeAi(config) : Promise.resolve(null);

    const [dataBody, logStatBody, subscriptionBody, probeResult] = await Promise.all([
      fetchOptional(dataUrl),
      fetchOptional(logStatUrl),
      fetchOptional(subscriptionUrl),
      probePromise,
    ]);

    const data = UsageQuota.extractUsage({
      userResponse: userBody,
      dataResponse: dataBody,
      logStatResponse: logStatBody,
      subscriptionResponse: subscriptionBody,
    });

    if (!data.isValid) {
      throw new Error(data.invalidMessage);
    }

    // 滚动更新 probeState（基于上次 + 本次结果）
    const prevProbe = previous?.probeState || {};
    const probeState = mergeProbeState(prevProbe, probeResult, healthEnabled, probeSource);
    data.health = UsageQuota.computeHealth(probeState, config);

    // 滚动维护活跃状态。成功探测会被平台计入 request_count，故按累计成功探测数扣除，避免探测把自己喂成「活跃」。
    let activityState;
    if (activity.mode === "dormant") {
      // 进入/保持休眠：以当前原始 request_count 为基线、探测账清零。休眠期不探测，
      // 于是「你是否回来」纯看原始请求数增长（无探测干扰）——彻底杜绝长期累计漂移把人卡死在休眠。
      activityState = {
        baselined: true,
        lastUserRequestCount: totalRequestCount,
        successfulProbeTotal: 0,
        lastActivityAt: activity.lastActivityAt,
        mode: "dormant",
      };
    } else {
      activityState = {
        baselined: true,
        lastUserRequestCount: activity.nextLastUserRequestCount,
        successfulProbeTotal:
          UsageQuota.toNumber(prevActivity.successfulProbeTotal) +
          (probeResult ? UsageQuota.toNumber(probeResult.successCount) : 0),
        lastActivityAt: activity.lastActivityAt,
        mode: "active",
      };
    }

    const snapshot = {
      state: "ready",
      updatedAt: Date.now(),
      errorMessage: "",
      data,
      probeState,
      activityState,
    };
    await maybeNotifyHealth(previous?.data?.health, data.health, healthEnabled);
    const result = await setSnapshot(snapshot);

    // 周期可能因失败次数或活跃/休眠切换而变化（正常 ↔ 3min ↔ 休眠心跳 ↔ 停），重排 alarm
    const prevPeriod = UsageQuota.getEffectiveRefreshMinutes(config, previous?.probeState, previous?.activityState);
    const nowPeriod = UsageQuota.getEffectiveRefreshMinutes(config, probeState, activityState);
    if (prevPeriod !== nowPeriod) {
      await scheduleRefresh({ immediate: false });
    }

    return result;
  } catch (error) {
    const message =
      error?.name === "AbortError" ? "请求超时，请检查平台地址或网络" : error?.message || "查询失败";
    const staleData = previous?.data || null;

    // 额度查询失败时，若需要探测（手动点刷新，或开启监测）仍单独探一次——
    // 额度故障常与 AI 真实故障同时发生，正是最需要准确探测结果的时候；点刷新也能刷新探测时间。
    // 不需要探测时（无 API 令牌 / 监测关且非手动）按原逻辑传 null：让旧的手动探测结果回落、避免红色徽标卡死。
    const healthEnabled = UsageQuota.normalizeHealthEnabled(config);
    const probeResult = wantProbe ? await probeAi(config) : null;
    const probeState = mergeProbeState(previous?.probeState, probeResult, healthEnabled, probeSource);
    const health = UsageQuota.computeHealth(probeState, config);
    if (staleData) staleData.health = health;
    // health 据本轮探测结果重算；据此触发/清掉故障通知（即便没有旧额度数据也能正确告警）
    await maybeNotifyHealth(previous?.data?.health || previous?.health, health, healthEnabled);

    // 刷新失败只写入快照给弹窗展示，不更新工具栏图标/徽标
    return setSnapshot(
      {
        state: staleData ? "stale" : "error",
        updatedAt: previous?.updatedAt || null,
        failedAt: Date.now(),
        errorMessage: message,
        data: staleData,
        probeState,
        // 抓取失败但仍探测了（catch 路径不知是否休眠，按 wantProbe 探）：探测同样被平台计入
        // request_count，必须把本轮成功探测数累加进 successfulProbeTotal，否则下个 tick 会把这些
        // 探测请求误读成「用户在用 AI」、反复刷新 lastActivityAt 而把人永久卡在「活跃」、永不休眠。
        // 全失败时 successCount=0 即原样保留；未探测（probeResult 为 null）时也原样保留，下个 tick 再判定。
        activityState: probeResult
          ? {
              ...(previous?.activityState || {}),
              successfulProbeTotal:
                UsageQuota.toNumber(previous?.activityState?.successfulProbeTotal) +
                UsageQuota.toNumber(probeResult.successCount),
            }
          : previous?.activityState,
      },
      { renderActionState: false }
    );
  } finally {
    clearTimeout(timeout);
  }
};

// 休眠心跳：只读 anyrouter 的 request_count（最轻量、免费、绝不探测），用来发现你是否回来用 AI。
// 真实请求数一旦增长 → 立即整刷一次（含探测）并把 alarm 调回正常间隔；否则保持休眠、不动面板。
const dormantHeartbeat = async () => {
  const config = await getConfig();
  if (!UsageQuota.hasValidConfig(config)) return;
  const previous = await getSnapshot();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const headers = UsageQuota.buildAuthHeaders(config);
    const userUrl = UsageQuota.buildUserUrl(config);
    const { response, body } = await fetchJson(userUrl, headers, controller.signal);
    // 心跳失败（网络/鉴权波动）：保持休眠，下个心跳再试，不动面板也不报错
    if (!response.ok || !body?.success) return;

    const totalRequestCount = UsageQuota.toNumber(body.data?.request_count);
    const activity = UsageQuota.decideActivityMode(previous?.activityState || {}, totalRequestCount, {
      now: Date.now(),
    });

    if (activity.mode === "active") {
      // 你回来了：整刷一次。fetchUsage 会独立从 request_count 复算活跃状态、按需探测并把 alarm 调回正常间隔。
      await fetchUsage();
    }
    // 仍休眠：活跃状态无实质变化（无新请求、无探测），无需写回快照，保持上次额度展示
  } catch (error) {
    // 心跳异常：忽略，保持休眠
  } finally {
    clearTimeout(timeout);
  }
};

// 一次性迁移：旧版的 healthEnabled 开关已并入「刷新间隔」。把显式关闭过检测的旧配置
// 迁移成 refreshMinutes=0，避免升级后自动检测被意外打开；并清掉废弃的 healthEnabled 字段。
const migrateConfig = async () => {
  const config = await getConfig();
  if (!("healthEnabled" in config)) return;
  const wasDisabled =
    config.healthEnabled === false ||
    config.healthEnabled === "false" ||
    config.healthEnabled === 0 ||
    config.healthEnabled === "0";
  const next = { ...config };
  delete next.healthEnabled;
  if (wasDisabled) next.refreshMinutes = 0;
  await storageSet({ [UsageQuota.CONFIG_KEY]: next });
};

chrome.runtime.onInstalled.addListener(async () => {
  await migrateConfig();
  await scheduleRefresh();
  await fetchUsage();
});

chrome.runtime.onStartup.addListener(async () => {
  await scheduleRefresh();
  const snapshot = await getSnapshot();
  await renderAction(snapshot);
  await fetchUsage();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  // 休眠期只跑轻量心跳（只读 request_count）；活跃期正常整刷 + 探测
  const snapshot = await getSnapshot();
  if (snapshot?.activityState?.mode === "dormant") {
    await dormantHeartbeat();
  } else {
    await fetchUsage();
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "refreshUsage") {
    // 来自弹窗刷新按钮的请求带 forceProbe，强制探测一次（无视监测开关）
    fetchUsage({ forceProbe: Boolean(message.forceProbe) }).then(sendResponse);
    return true;
  }

  if (message?.type === "getUsageState") {
    Promise.all([getConfig(), getSnapshot()]).then(([config, snapshot]) => {
      sendResponse({ config, snapshot });
    });
    return true;
  }

  return false;
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes[UsageQuota.CONFIG_KEY]) {
    scheduleRefresh();
  }
});
