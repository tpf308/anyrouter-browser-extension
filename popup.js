const $ = (id) => document.getElementById(id);

const el = {
  alertBox:       $("alertBox"),
  apiKeyInput:    $("apiKeyInput"),
  autoRefreshToggle: $("autoRefreshToggle"),
  cancelKeyBtn:   $("cancelKeyBtn"),
  configForm:     $("configForm"),
  emptyState:     $("emptyState"),
  healthCard:     $("healthCard"),
  healthTargets:  $("healthTargets"),
  probeVia:       $("probeVia"),
  keyModal:       $("keyModal"),
  openKeyBtn:     $("openKeyBtn"),
  refreshButton:  $("refreshButton"),
  statusLabel:    $("statusLabel"),
  statusNote:     $("statusNote"),
  summaryView:    $("summaryView"),
};

const storageGet = (keys) =>
  new Promise((resolve) => chrome.storage.local.get(keys, resolve));

const storageSet = (items) =>
  new Promise((resolve) => chrome.storage.local.set(items, resolve));

const sendMessage = (message) =>
  new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const err = chrome.runtime.lastError;
      if (err) { reject(new Error(err.message)); return; }
      resolve(response);
    });
  });

const set = (element, value) => { element.textContent = value ?? "-"; };

const showAlert = (message) => {
  el.alertBox.hidden = !message;
  el.alertBox.textContent = message || "";
};

// 顶栏状态文字后面的内联失败原因
const setStatusNote = (message) => {
  el.statusNote.hidden = !message;
  el.statusNote.textContent = message || "";
};

// 注意：用 classList 切换而非整体覆盖 className，避免清掉 modal-open（弹窗撑高用）等非 tone 类
const TONE_CLASSES = [
  "tone-good", "tone-warn", "tone-partial", "tone-danger", "tone-error",
  "tone-stale", "tone-idle", "tone-loading", "tone-unknown",
];
const setTone = (tone) => {
  document.body.classList.remove(...TONE_CLASSES);
  document.body.classList.add(`tone-${tone || "idle"}`);
};

const openKeyModal = async () => {
  const result = await storageGet(UsageQuota.CONFIG_KEY);
  const config = result[UsageQuota.CONFIG_KEY] || {};
  // 兼容旧配置：apiToken 优先，回退到旧的 accessToken
  el.apiKeyInput.value = config.apiToken || config.accessToken || "";
  el.keyModal.hidden = false;
  document.body.classList.add("modal-open"); // 撑高弹窗，让凭据浮层有空间居中
  el.apiKeyInput.focus();
  el.apiKeyInput.select();
};

const closeKeyModal = () => {
  el.keyModal.hidden = true;
  document.body.classList.remove("modal-open");
};

const renderUnconfigured = (message) => {
  setTone("idle");
  set(el.statusLabel, "未配置");
  setStatusNote("");
  el.summaryView.hidden = true;
  el.emptyState.hidden = false;
  showAlert(message || "");
};

// 渲染 AI 健康卡片：逐条线路（主站 / 大陆直连）各一行；卡片整体 data-state 取聚合 health（两条都挂才红框）。
// health.targets 为空（缺令牌 / 旧快照）时回退成单行聚合状态。
const renderHealthTargets = (health) => {
  const card = el.healthCard;
  const container = el.healthTargets;
  if (!card || !container) return;

  const agg = health || { state: "unknown", label: "未检测", description: "", metaText: "-" };
  card.dataset.state = agg.state || "unknown";
  container.replaceChildren();

  const rows =
    Array.isArray(agg.targets) && agg.targets.length > 0
      ? agg.targets
      : [{ ...agg, name: "AI 探测", host: "" }]; // 回退：无分线路数据时显示单行聚合状态

  for (const row of rows) {
    const routeEl = document.createElement("div");
    routeEl.className = "health-route";
    routeEl.dataset.state = row.state || "unknown";

    const top = document.createElement("div");
    top.className = "health-route-top";

    const dot = document.createElement("span");
    dot.className = "health-pulse";
    top.appendChild(dot);

    const name = document.createElement("span");
    name.className = "health-route-name";
    name.textContent = row.name || "AI 探测";
    top.appendChild(name);

    const label = document.createElement("span");
    label.className = "health-route-label";
    label.textContent = row.label || "";
    top.appendChild(label);

    const meta = document.createElement("span");
    meta.className = "health-route-meta";
    meta.textContent = row.metaText || "";
    top.appendChild(meta);

    routeEl.appendChild(top);

    const desc = document.createElement("div");
    desc.className = "health-route-desc";
    const host = row.host ? `${row.host} · ` : "";
    desc.textContent = `${host}${row.description || ""}`;
    routeEl.appendChild(desc);

    container.appendChild(routeEl);
  }
};

// 顶栏自动刷新开关同步到当前持久化配置（旧配置无字段 → 默认开启）
const setAutoRefreshToggle = (config) => {
  el.autoRefreshToggle.checked = UsageQuota.isAutoRefreshEnabled(config);
};

// 探测方式提示：native（本地 host）准确；fetch（浏览器）可能假 429，提示去装本地探测。
const setProbeVia = (snapshot) => {
  if (!el.probeVia) return;
  const via = snapshot?.probeState?.probeVia;
  if (via === "native" || via === "fetch") {
    el.probeVia.hidden = false;
    el.probeVia.dataset.via = via;
    el.probeVia.textContent = via === "native" ? "本地探测 ✓" : "浏览器探测 · 装本地探测更准";
  } else {
    el.probeVia.hidden = true;
  }
};

const renderSnapshot = (snapshot, config) => {
  setAutoRefreshToggle(config);

  // 未配置 API Key
  if (!UsageQuota.hasValidApiToken(config) || snapshot?.state === "unconfigured") {
    renderUnconfigured(snapshot?.errorMessage || "");
    return;
  }

  el.emptyState.hidden = true;
  el.summaryView.hidden = false;

  // 健康状态：优先用快照里的，缺失则据 probeState 现算
  const health =
    snapshot?.data?.health ||
    snapshot?.health ||
    UsageQuota.computeHealth(snapshot?.probeState, config);

  // 顶栏状态跟随 AI 健康（与工具栏图标口径一致）
  const balanceFailed = snapshot?.state === "stale" || snapshot?.state === "error";
  let tone;
  let label;
  if (health?.state === "unhealthy") { tone = "danger"; label = "AI 异常"; }
  else if (health?.partial) { tone = "partial"; label = "单条异常"; }
  else if (health?.state === "healthy") { tone = "good"; label = "运行正常"; }
  else { tone = "idle"; label = "等待检测"; }

  setTone(tone);
  set(el.statusLabel, label);
  setStatusNote(balanceFailed ? `用量刷新失败：${snapshot.errorMessage || "请稍后重试"}` : "");
  showAlert("");

  renderHealthTargets(health);
  setProbeVia(snapshot);
};

const loadState = async () => {
  try {
    const state = await sendMessage({ type: "getUsageState" });
    renderSnapshot(state?.snapshot, state?.config || {});
  } catch (error) {
    const result = await storageGet([UsageQuota.CONFIG_KEY, UsageQuota.SNAPSHOT_KEY]);
    const config = result[UsageQuota.CONFIG_KEY] || {};
    renderSnapshot(result[UsageQuota.SNAPSHOT_KEY], config);
    showAlert(error.message || "无法连接后台，请重新打开面板。");
  }
};

const refreshUsage = async ({ forceProbe = false } = {}) => {
  el.refreshButton.disabled = true;
  el.refreshButton.classList.add("spinning");
  try {
    const snapshot = await sendMessage({ type: "refreshUsage", forceProbe });
    const result = await storageGet(UsageQuota.CONFIG_KEY);
    renderSnapshot(snapshot, result[UsageQuota.CONFIG_KEY] || {});
  } catch (error) {
    showAlert(error.message || "刷新失败");
  } finally {
    el.refreshButton.disabled = false;
    el.refreshButton.classList.remove("spinning");
  }
};

el.openKeyBtn.addEventListener("click", openKeyModal);
el.cancelKeyBtn.addEventListener("click", closeKeyModal);

el.keyModal.addEventListener("click", (e) => {
  if (e.target === el.keyModal) closeKeyModal();
});

el.configForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  // 单个 API Key 同时用作余额查询（Authorization: Bearer）与 opus 探测（x-api-key）
  const apiKey = UsageQuota.normalizeApiToken(el.apiKeyInput.value);

  if (!apiKey) {
    el.apiKeyInput.focus();
    showAlert("请填写 API Key（用于查询余额与检测 opus）。");
    return;
  }

  // 合并保存：保留 autoRefresh 等其它字段，只覆盖 apiToken
  const prevResult = await storageGet(UsageQuota.CONFIG_KEY);
  const prevConfig = prevResult[UsageQuota.CONFIG_KEY] || {};
  await storageSet({ [UsageQuota.CONFIG_KEY]: { ...prevConfig, apiToken: apiKey } });
  closeKeyModal();
  showAlert("");
  await refreshUsage();
});

// 自动刷新开关：写入配置即可——background 的 storage.onChanged 会据此重排/清除周期 alarm
el.autoRefreshToggle.addEventListener("change", async () => {
  const enabled = el.autoRefreshToggle.checked;
  const result = await storageGet(UsageQuota.CONFIG_KEY);
  const config = result[UsageQuota.CONFIG_KEY] || {};
  await storageSet({ [UsageQuota.CONFIG_KEY]: { ...config, autoRefresh: enabled } });
});

// 点刷新按钮：强制立即探测一次运行状况（不必等内置的 5 分钟周期）
el.refreshButton.addEventListener("click", () => refreshUsage({ forceProbe: true }));

loadState();
