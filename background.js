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

const setSnapshot = async (snapshot) => {
  await storageSet({ [UsageQuota.SNAPSHOT_KEY]: snapshot });
  await renderAction(snapshot);
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
      title: "AnyRouter Quota：请先配置 Access Token + 用户 ID",
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
    } else if (isStale) {
      tone = "stale";                          // 琥珀：经 anyrouter.top 抓取额度失败、展示旧数据（非红）
    } else if (data.status.tone === "danger") {
      tone = "warn";                           // 额度耗尽/极低 → 橙色，不与 AI 告警的红色混淆
    } else {
      tone = data.status.tone;                 // good / warn
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

// 把本次 probe 结果累加到上次 probeState 上，跟踪 lastSuccessAt / consecutiveFailures。
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
    // 本轮未探测（probeResult === null）时清空 source；用于「关闭监测」下手动探测的结果
    // 在下一次普通刷新后回落到「已关闭」展示
    source: null,
  };

  if (!probeResult) return base;

  const now = Date.now();
  base.lastCheckedAt = now;
  base.latencyMs = Number(probeResult.latencyMs) || 0;
  base.source = source === "manual" ? "manual" : "auto";

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

// 主动探测：发一个最小请求到 /v1/messages，判断 AI 模型是否真的在响应。
const probeAi = async (config) => {
  if (!UsageQuota.hasValidApiToken(config)) {
    return { success: false, latencyMs: 0, errorMessage: "缺少 API 令牌" };
  }

  const url = UsageQuota.buildProbeUrl(config);
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

const fetchUsage = async ({ forceProbe = false } = {}) => {
  const config = await getConfig();
  const previous = await getSnapshot();

  if (!UsageQuota.hasValidConfig(config)) {
    return setSnapshot({
      state: "unconfigured",
      updatedAt: null,
      errorMessage: "请配置 Access Token 和用户 ID",
    });
  }

  await renderAction({
    state: "loading",
    data: previous?.data || null,
    updatedAt: previous?.updatedAt || null,
  });

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
      return setSnapshot({
        state: "unconfigured",
        updatedAt: null,
        errorMessage: userBody?.message || "Access Token 或用户 ID 无效",
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
    const probeSource = forceProbe ? "manual" : "auto";
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
          UsageQuota.toNumber(prevActivity.successfulProbeTotal) + (probeResult?.success ? 1 : 0),
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

    // 本轮没有成功探测：清掉 source，让「关闭监测」下的手动探测结果回落到「已关闭」，
    // 并据此重算 health —— 否则额度接口持续失败时，旧的「（手动）」结果/红色徽标会卡死
    //（额度故障常与 AI 真实故障同时发生，正是最需要准确的时候）
    const healthEnabled = UsageQuota.normalizeHealthEnabled(config);
    const probeState = mergeProbeState(previous?.probeState, null, healthEnabled, "auto");
    if (staleData) staleData.health = UsageQuota.computeHealth(probeState, config);
    // health 可能从「AI 异常（手动）」回落，顺带清掉残留的故障通知（本轮没探测，不会误报新故障）
    await maybeNotifyHealth(previous?.data?.health, staleData?.health, healthEnabled);

    return setSnapshot({
      state: staleData ? "stale" : "error",
      updatedAt: previous?.updatedAt || null,
      failedAt: Date.now(),
      errorMessage: message,
      data: staleData,
      probeState,
      activityState: previous?.activityState, // 抓取失败：活跃状态原样保留，下个 tick 再判定
    });
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
