const $ = (id) => document.getElementById(id);

const el = {
  alertBox:            $("alertBox"),
  apiKeyInput:         $("apiKeyInput"),
  badgePreview:        $("badgePreview"),
  cancelKeyBtn:        $("cancelKeyBtn"),
  configForm:          $("configForm"),
  emptyState:          $("emptyState"),
  healthCard:          $("healthCard"),
  healthTargets:       $("healthTargets"),
  historyUsed:         $("historyUsed"),
  keyModal:            $("keyModal"),
  openKeyBtn:          $("openKeyBtn"),
  refreshButton:       $("refreshButton"),
  remainingValue:      $("remainingValue"),
  rpm:                 $("rpm"),
  statusLabel:         $("statusLabel"),
  statusNote:          $("statusNote"),
  summaryView:         $("summaryView"),
  todayCalls:          $("todayCalls"),
  todayTokens:         $("todayTokens"),
  todayUsed:           $("todayUsed"),
  totalRequests:       $("totalRequests"),
  totalTokens:         $("totalTokens"),
  tpm:                 $("tpm"),
  userIdInput:         $("userIdInput"),
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

// 顶栏「数据过期」后面的内联失败原因，省去独立的提示条
const setStatusNote = (message) => {
  el.statusNote.hidden = !message;
  el.statusNote.textContent = message || "";
};

const setTone = (tone) => {
  document.body.className = `tone-${tone || "idle"}`;
};

// 额度块（hero/quads/cells）整体显隐——仅探测模式下隐藏，只留 AI 健康卡片
const setQuotaVisible = (visible) => {
  document.querySelectorAll(".hero, .quads, .cells").forEach((node) => {
    node.hidden = !visible;
  });
};

const openKeyModal = async () => {
  const result = await storageGet(UsageQuota.CONFIG_KEY);
  const config = result[UsageQuota.CONFIG_KEY] || {};
  el.userIdInput.value = config.userId ? String(config.userId) : "";
  // accessToken 与 apiToken 共用同一个 API Key；展示时回退到任一已存值
  el.apiKeyInput.value = config.apiToken || config.accessToken || "";
  el.keyModal.hidden = false;
  if (!el.userIdInput.value) {
    el.userIdInput.focus();
  } else {
    el.apiKeyInput.focus();
    el.apiKeyInput.select();
  }
};

const closeKeyModal = () => {
  el.keyModal.hidden = true;
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
// health.targets 为空（缺令牌 / 已关闭 / 旧快照）时回退成单行聚合状态。
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

// 未登录（或登录失效）但配了 API 令牌：只展示 AI 站点检测卡片，隐藏额度块
const renderProbeOnly = (snapshot, config) => {
  const health =
    snapshot?.health || UsageQuota.computeHealth(snapshot?.probeState, config);
  const down = health.state === "unhealthy";
  // 区分「从未登录」与「登录已失效」（有凭据但被服务端拒绝）
  const hasCreds = UsageQuota.hasValidConfig(config);

  setTone(down ? "danger" : "idle");
  set(el.statusLabel, "仅检测");
  setStatusNote("");
  el.emptyState.hidden = true;
  el.summaryView.hidden = false;
  setQuotaVisible(false);
  showAlert(
    hasCreds
      ? "登录已失效：仅站点检测可用。请在设置中更新 API Key 以恢复额度查询。"
      : "未登录：仅站点检测可用。填写用户 ID + API Key 可查看额度。"
  );

  renderHealthTargets(health);
};

const renderSnapshot = (snapshot, config) => {
  const loggedIn = UsageQuota.hasValidConfig(config);

  // 仅探测快照（未登录或登录失效但有 API 令牌）：只展示 AI 健康卡片，隐藏额度块
  if (snapshot?.state === "probe-only") {
    renderProbeOnly(snapshot, config);
    return;
  }

  if (!loggedIn) {
    // 未登录但配了 API 令牌：即便后台还没探测，也展示检测卡片邀请手动探测
    if (UsageQuota.hasValidApiToken(config)) {
      renderProbeOnly(snapshot, config);
      return;
    }
    renderUnconfigured(snapshot?.errorMessage || "");
    return;
  }

  if (snapshot?.state === "unconfigured") {
    renderUnconfigured(snapshot.errorMessage || "");
    return;
  }

  el.emptyState.hidden = true;
  setQuotaVisible(true);

  if (!snapshot?.data) {
    setTone(snapshot?.state === "error" ? "error" : "idle");
    set(el.statusLabel, snapshot?.state === "error" ? "查询失败" : "等待刷新");
    setStatusNote("");
    el.summaryView.hidden = true;
    showAlert(snapshot?.errorMessage || "保存凭据后点击刷新，获取额度数据。");
    return;
  }

  const data = snapshot.data;
  const isStale = snapshot.state === "stale";
  const tone = isStale ? "stale" : data.status.tone;

  setTone(tone);
  set(el.statusLabel, isStale ? "数据过期" : data.status.label);
  // 刷新失败原因紧跟在「数据过期」后面，不再单独占一条提示
  setStatusNote(isStale ? `刷新失败：${snapshot.errorMessage || "请稍后重试"}` : "");
  showAlert("");

  el.summaryView.hidden = false;

  set(el.remainingValue,    data.formatted.weekRemaining);
  set(el.badgePreview,      data.badgeText);
  set(el.historyUsed,       data.formatted.totalUsed);
  set(el.todayUsed,         data.formatted.todayUsed);
  set(el.todayCalls,        data.formatted.todayCalls);
  set(el.todayTokens,       data.formatted.todayTokens);
  set(el.totalRequests,     data.formatted.totalRequests);
  set(el.totalTokens,       data.formatted.totalTokens);
  set(el.rpm,               data.formatted.rpm);
  set(el.tpm,               data.formatted.tpm);

  // 渲染 AI 健康卡片（逐条线路：主站 / 大陆直连）
  const health = data.health || { state: "unknown", label: "未检测", description: "", metaText: "-", targets: [] };
  renderHealthTargets(health);
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
  const userId = UsageQuota.normalizeUserId(el.userIdInput.value);
  // 单个 API Key 同时充当 Access Token（查额度）与 API 令牌（站点检测）
  const apiKey = UsageQuota.normalizeApiToken(el.apiKeyInput.value);

  // 必须有 API Key：缺它则既查不了额度也检测不了站点
  if (!apiKey) {
    el.apiKeyInput.focus();
    showAlert("请填写 API Key（用于查询额度与检测站点）。");
    return;
  }
  // 用户 ID 可留空：此时仅作站点检测，面板会给出「未登录」提示

  const config = {
    userId,
    accessToken: apiKey,
    apiToken: apiKey,
  };
  await storageSet({ [UsageQuota.CONFIG_KEY]: config });
  closeKeyModal();
  showAlert("");
  await refreshUsage();
});

// 点刷新按钮：强制立即探测一次运行状况（不必等内置的 5 分钟周期）
el.refreshButton.addEventListener("click", () => refreshUsage({ forceProbe: true }));

loadState();
