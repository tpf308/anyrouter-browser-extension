importScripts("usage.js");

const FETCH_TIMEOUT_MS = 12000;
const ALARM_NAME = "anyrouter-quota-refresh";
const NOTIFICATION_DOWN_ID = "anyrouter-ai-down";
const NOTIFICATION_UP_ID = "anyrouter-ai-up";

const TONE_COLORS = {
  good: "#0f9f6e",
  warn: "#d97706",
  danger: "#dc2626",
  partial: "#7c3aed",
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
  // 自动刷新开关关闭：不排周期 alarm，仅保留手动刷新（点刷新按钮）
  if (!UsageQuota.isAutoRefreshEnabled(config)) {
    chrome.alarms.clear(ALARM_NAME);
    return;
  }
  const snapshot = await getSnapshot();
  const periodMinutes = UsageQuota.getEffectiveRefreshMinutes(snapshot?.probeState);
  // null = 「放弃」档：清掉 alarm，等用户手动点刷新
  if (periodMinutes === null) {
    chrome.alarms.clear(ALARM_NAME);
    return;
  }
  const opts = { periodInMinutes: periodMinutes };
  if (immediate) opts.delayInMinutes = 0.2; // 12 秒后触发首次刷新
  chrome.alarms.create(ALARM_NAME, opts);
};

// 周期可能因探测连续失败次数变化（正常 5min ↔ 3min 密集重试 ↔ 停），失败档变化时重排 alarm
const rescheduleIfNeeded = async (previous, probeState) => {
  const prevPeriod = UsageQuota.getEffectiveRefreshMinutes(previous?.probeState);
  const nowPeriod = UsageQuota.getEffectiveRefreshMinutes(probeState);
  if (prevPeriod !== nowPeriod) await scheduleRefresh({ immediate: false });
};

const getActionState = (snapshot) => {
  if (!snapshot || snapshot.state === "unconfigured") {
    return {
      badge: "SET",
      tone: "idle",
      title: "AnyRouter：请先配置 API Key",
      ratio: null,
    };
  }

  if (snapshot.state === "loading") {
    return {
      badge: "...",
      tone: "loading",
      title: "AnyRouter：正在刷新",
      ratio: null,
    };
  }

  const data = snapshot.data;
  // health 优先取快照顶层（余额失败时仍在），回退 data.health。
  // 红色（danger）只保留给「全部线路均失败」的 AI 告警；单条线路异常用紫色；额度耗尽/极低降级为橙色。
  const health = data?.health || snapshot.health;
  const isAiDown = health?.state === "unhealthy";
  const isAiPartial = !isAiDown && health?.partial === true;

  if (data) {
    const isStale = snapshot.state === "stale";

    // 已用额度本身无「危险档位」概念，颜色完全由 AI 健康决定：红=全挂、紫=单线异常、否则绿。
    const tone = isAiDown ? "danger" : isAiPartial ? "partial" : "good";
    const badge = isAiDown ? "AI!" : isAiPartial ? "AI" : data.badgeText || "0";

    const headlineLine = isAiDown
      ? `AnyRouter：AI 探测失败（${health.description || "未知错误"}）`
      : isAiPartial
        ? "AnyRouter：单条线路异常（其余线路仍可用）"
        : isStale
          ? "AnyRouter：显示上次用量，刷新失败"
          : "AnyRouter Quota";

    return {
      badge,
      tone,
      title: [
        headlineLine,
        `已用额度 ${data.formatted?.used || "-"}`,
        health && health.state !== "unknown" && health.state !== "no-token"
          ? `AI 状态：${health.label}（${health.metaText}）`
          : "",
        snapshot.updatedAt ? `更新时间 ${new Date(snapshot.updatedAt).toLocaleString("zh-CN")}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
      ratio: null,
    };
  }

  // 无缓存余额：仍据 AI 健康优先反映状态（如首次启动余额失败但 AI 已挂，应红/紫而非吞成 ERR）
  if (isAiDown || isAiPartial) {
    return {
      badge: isAiDown ? "AI!" : "AI",
      tone: isAiDown ? "danger" : "partial",
      title: isAiDown
        ? `AnyRouter：AI 探测失败（${health.description || "未知错误"}）`
        : "AnyRouter：单条线路异常（其余线路仍可用）",
      ratio: null,
    };
  }

  // 查询失败且无缓存余额、AI 也未挂：用琥珀色提示，不变红（红色仅用于 AI 告警）
  return {
    badge: "ERR",
    tone: "stale",
    title: `AnyRouter：${snapshot.errorMessage || "查询失败"}`,
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

// 把本次 probe 结果累加到上次 probeState 上：聚合字段（驱动徽标/通知/重试）+ 各线路子状态 targets[]。
// 聚合口径「任一线路成功即成功」：成功清零顶层连续失败，全失败才累加——故红色徽标/通知只在两条都挂时触发。
// probeResult === null 表示本轮没探，保留旧状态。
const mergeProbeState = (prev, probeResult, source) => {
  const base = {
    lastCheckedAt: Number(prev?.lastCheckedAt) || 0,
    lastSuccessAt: Number(prev?.lastSuccessAt) || 0,
    lastResult: prev?.lastResult || null,
    lastErrorMessage: prev?.lastErrorMessage || "",
    latencyMs: Number(prev?.latencyMs) || 0,
    consecutiveFailures: Number(prev?.consecutiveFailures) || 0,
    // 各线路子状态：本轮未探测时原样带过上次的，供面板继续展示
    targets: Array.isArray(prev?.targets) ? prev.targets : [],
    source: null,
    // 本轮探测走的通道：native（本地 host）/ fetch（浏览器）。未探则保留上次的。
    probeVia: prev?.probeVia || null,
  };

  if (!probeResult) return base;

  const now = Date.now();
  base.lastCheckedAt = now;
  base.latencyMs = Number(probeResult.latencyMs) || 0;
  base.source = source === "manual" ? "manual" : "auto";
  base.probeVia = probeResult.probeVia === "native" ? "native" : "fetch";

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

// 探测单个模型：发一个最小请求到该线路的 /v1/messages，判断该模型是否真的在响应。
const probeModel = async (config, target, model) => {
  const url = UsageQuota.buildProbeUrl(target.baseUrl);
  const headers = UsageQuota.buildProbeHeaders(config);
  const body = UsageQuota.buildProbeBody(model);

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

    // 先读文本再尝试解析，便于在非 2xx 时把响应体原文带进错误信息（如 400「模型名不被接受」）
    const raw = await response.text().catch(() => "");
    let payload = null;
    try {
      payload = raw ? JSON.parse(raw) : null;
    } catch {
      payload = null;
    }

    // ① 响应体是 JSON 错误：new-api 把「上游不可用」包成 {"type":"error","error":{message}}，
    //    且常以 429（甚至 200）返回——这恰是「opus 实测用不了」的信号，优先级高于状态码。
    //    （实测主站/直连不可用时即回 429 + {"message":"Service Unavailable"}；429 绝不能当「可用」。）
    const jsonErr =
      typeof payload?.error === "string" ? payload.error : payload?.error?.message;
    if (jsonErr) {
      return { success: false, latencyMs, errorMessage: `HTTP ${response.status}：${jsonErr}` };
    }

    // ② 非 2xx 且无法解析出错误详情：带状态码与响应体片段报失败（从严）。
    if (!response.ok) {
      const detail = raw.slice(0, 120).trim();
      const msg = detail ? `HTTP ${response.status}：${detail}` : `HTTP ${response.status}`;
      return { success: false, latencyMs, errorMessage: msg };
    }

    // ③ 探测用 stream:true，2xx 的正常响应体是 SSE 流。若流里夹了 error 事件
    //    （活通道先回 200、上游随后挂掉），也判失败——成功的 "hi" 回复不会含此 JSON 片段。
    if (/"type"\s*:\s*"error"/.test(raw)) {
      return { success: false, latencyMs, errorMessage: "上游在流中返回 error 事件" };
    }

    // ④ 2xx 且全程无 error → 活通道真的在吐 opus-4-8，可用。
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
const probeAi = async (config) => {
  const targets = UsageQuota.PROBE_TARGETS;

  if (!UsageQuota.hasValidApiToken(config)) {
    return {
      success: false,
      latencyMs: 0,
      errorMessage: "缺少 API Key",
      targets: targets.map((t) => ({
        key: t.key,
        name: t.name,
        baseUrl: t.baseUrl,
        success: false,
        latencyMs: 0,
        errorMessage: "缺少 API Key",
      })),
    };
  }

  const results = await Promise.all(
    targets.map(async (t) => {
      const r = await probeModel(config, t, UsageQuota.PROBE_TARGET_MODEL);
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

  return { ...UsageQuota.aggregateProbeTargets(results), probeVia: "fetch" };
};

// 本地探测：把请求规格交给原生 host（PowerShell + curl）执行。host 能带上 fetch 改不了的
// User-Agent 等头，使请求与真实 Claude Code 一致、命中活通道——根治浏览器 fetch 的假 429。
// host 未装 / 不可达 / 返回异常时返回 null，由调用方回退到 probeAi（fetch）。
const probeViaNative = (config) =>
  new Promise((resolve) => {
    if (!UsageQuota.hasValidApiToken(config)) {
      resolve(null);
      return;
    }
    const spec = UsageQuota.buildProbeNativeSpec(config);
    try {
      chrome.runtime.sendNativeMessage(UsageQuota.NATIVE_HOST_NAME, spec, (resp) => {
        const err = chrome.runtime.lastError;
        if (err) {
          // 未装 host / 未注册 / host 崩溃：静默回退（不当探测失败，避免误报红）
          console.info("native probe unavailable, fallback to fetch:", err.message);
          resolve(null);
          return;
        }
        if (!resp || resp.ok !== true || !Array.isArray(resp.targets)) {
          console.warn("native probe bad response, fallback to fetch:", resp && resp.error);
          resolve(null);
          return;
        }
        // host 只回各线路结果，聚合复用与 fetch 同一套口径
        const targets = resp.targets.map((t) => ({
          key: t.key,
          name: t.name,
          baseUrl: t.baseUrl,
          success: Boolean(t.success),
          latencyMs: Number(t.latencyMs) || 0,
          errorMessage: t.errorMessage || "",
        }));
        resolve({ ...UsageQuota.aggregateProbeTargets(targets), probeVia: "native" });
      });
    } catch (e) {
      console.info("native probe threw, fallback to fetch:", e?.message);
      resolve(null);
    }
  });

// 探测入口：优先本地 host（准确），不可用则回退浏览器 fetch（今日行为）。
const probeAiPreferNative = async (config) =>
  (await probeViaNative(config)) || (await probeAi(config));

// 仅在 healthy/unknown ↔ unhealthy 之间翻转时弹通知，避免每次刷新重复打扰
const maybeNotifyHealth = async (prevHealth, nextHealth) => {
  if (!nextHealth) return;
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

// 每个刷新周期：并发拉取已使用额度（计费 usage 接口）与两条线路的 opus 探测。
// 用量只需 API Key（Bearer）；探测用 x-api-key。两者用同一个 API Key。
const fetchUsage = async ({ forceProbe = false } = {}) => {
  const config = await getConfig();
  const previous = await getSnapshot();
  const probeSource = forceProbe ? "manual" : "auto";

  if (!UsageQuota.hasValidApiToken(config)) {
    return setSnapshot({
      state: "unconfigured",
      updatedAt: null,
      errorMessage: "请配置 API Key",
    });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const billingHeaders = UsageQuota.buildBillingHeaders(config);
    const usageUrl = UsageQuota.buildBillingUsageUrl();

    const failedFetch = { response: { ok: false, status: 0 }, body: null };
    const [usageRes, probeResult] = await Promise.all([
      fetchJson(usageUrl, billingHeaders, controller.signal).catch(() => failedFetch),
      probeAiPreferNative(config),
    ]);

    // 健康（探测结果）。health 顶层冗余存一份：用量失败导致 data 为空时，图标/通知仍能据此反映 AI 状态。
    const probeState = mergeProbeState(previous?.probeState, probeResult, probeSource);
    const health = UsageQuota.computeHealth(probeState, config);
    await maybeNotifyHealth(previous?.health || previous?.data?.health, health);

    // 已使用额度（计费接口）：令牌为无限额度时拿不到剩余余额，故展示已用。失败不当 0（见 extractUsed）。
    const usage = UsageQuota.extractUsed(usageRes.body, Boolean(usageRes.response?.ok));

    let result;
    if (usage.isValid) {
      result = await setSnapshot({
        state: "ready",
        updatedAt: Date.now(),
        errorMessage: "",
        data: { ...usage, health },
        health,
        probeState,
      });
    } else {
      // 用量拿不到：保留上次用量展示为 stale，但健康按本轮探测更新（AI 异常仍能正确告警染红）
      const staleData = previous?.data ? { ...previous.data, health } : null;
      result = await setSnapshot({
        state: staleData ? "stale" : "error",
        updatedAt: previous?.updatedAt || null,
        failedAt: Date.now(),
        errorMessage: usage.invalidMessage || "用量查询失败",
        data: staleData,
        health,
        probeState,
      });
    }

    await rescheduleIfNeeded(previous, probeState);
    return result;
  } catch (error) {
    const message =
      error?.name === "AbortError" ? "请求超时，请检查网络" : error?.message || "查询失败";
    const staleData = previous?.data || null;
    return setSnapshot(
      {
        state: staleData ? "stale" : "error",
        updatedAt: previous?.updatedAt || null,
        failedAt: Date.now(),
        errorMessage: message,
        data: staleData,
        health: previous?.health || previous?.data?.health || null,
        probeState: previous?.probeState || {},
      },
      { renderActionState: true }
    );
  } finally {
    clearTimeout(timeout);
  }
};

chrome.runtime.onInstalled.addListener(async () => {
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
  await fetchUsage();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "refreshUsage") {
    // 来自弹窗刷新按钮的请求带 forceProbe，强制探测一次
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
