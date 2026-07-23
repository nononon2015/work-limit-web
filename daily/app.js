const $ = (id) => document.getElementById(id);
const STORAGE_KEY = "stopwork-daily-v2";
const OLD_STORAGE_KEY = "stopwork-sessions";
const DEFAULT_LIMIT = 8 * 60 * 60;

let store = loadStore();
let activeDate = dateKey();
let calendarCursor = new Date();
let tickerTimer;

function dateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function loadStore() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (parsed?.records) return parsed;
  } catch (_) {
    // Start with a clean device-local store if saved data is invalid.
  }
  return { version: 2, records: {}, migrated: false };
}

function saveStore() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
}

function preferredLimit() {
  if (Number.isFinite(store.lastLimitSeconds) && store.lastLimitSeconds >= 60) {
    return store.lastLimitSeconds;
  }
  const latestKey = Object.keys(store.records).sort().reverse().find(
    (key) => Number.isFinite(store.records[key]?.limitSeconds) && store.records[key].limitSeconds >= 60
  );
  return latestKey ? store.records[latestKey].limitSeconds : DEFAULT_LIMIT;
}

function getRecord(key = activeDate) {
  if (!store.records[key]) {
    store.records[key] = {
      workedSeconds: 0,
      limitSeconds: preferredLimit(),
      runningSince: null,
      reminders: []
    };
  }
  return store.records[key];
}

function migrateOldSessions() {
  if (store.migrated) return;
  try {
    const oldSessions = JSON.parse(localStorage.getItem(OLD_STORAGE_KEY) || "[]");
    oldSessions.forEach((session) => {
      if (!session.finishedAt || !Number.isFinite(Number(session.minutes))) return;
      const key = dateKey(new Date(session.finishedAt));
      const record = getRecord(key);
      record.workedSeconds += Math.max(0, Number(session.minutes) * 60);
    });
  } catch (_) {
    // Old data is optional; a failed migration must not stop the timer.
  }
  store.migrated = true;
  saveStore();
}

function workedSeconds(record = getRecord()) {
  const live = record.runningSince ? Math.max(0, (Date.now() - record.runningSince) / 1000) : 0;
  return Math.floor(record.workedSeconds + live);
}

function formatClock(totalSeconds) {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

function formatDuration(totalSeconds, compact = false) {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (compact) {
    if (hours && minutes) return `${hours}時${minutes}分`;
    if (hours) return `${hours}時`;
    return minutes ? `${minutes}分` : "—";
  }
  if (hours && minutes) return `${hours} 小時 ${minutes} 分鐘`;
  if (hours) return `${hours} 小時`;
  return `${minutes} 分鐘`;
}

function commitElapsed(record = getRecord()) {
  if (!record.runningSince) return;
  record.workedSeconds += Math.max(0, Math.floor((Date.now() - record.runningSince) / 1000));
  record.runningSince = null;
}

function recoverOvernightRun() {
  const runningEntry = Object.entries(store.records).find(
    ([key, record]) => key !== activeDate && record.runningSince
  );
  if (!runningEntry) return;

  let [key, record] = runningEntry;
  let cursor = Number(record.runningSince);
  const inheritedLimit = record.limitSeconds || DEFAULT_LIMIT;
  store.lastLimitSeconds = inheritedLimit;
  record.runningSince = null;

  while (key !== activeDate) {
    const boundary = new Date(cursor);
    boundary.setHours(24, 0, 0, 0);
    record.workedSeconds += Math.max(0, Math.floor((boundary.getTime() - cursor) / 1000));
    cursor = boundary.getTime();
    key = dateKey(boundary);
    record = getRecord(key);
    if (!record.limitSeconds) record.limitSeconds = inheritedLimit;
  }
  record.runningSince = cursor;
  saveStore();
}

function rollOverIfNeeded() {
  const nowKey = dateKey();
  if (nowKey === activeDate) return;

  const previous = getRecord(activeDate);
  const wasRunning = Boolean(previous.runningSince);
  if (wasRunning) {
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    previous.workedSeconds += Math.max(0, Math.floor((midnight.getTime() - previous.runningSince) / 1000));
    previous.runningSince = null;
  }

  const previousLimit = previous.limitSeconds || DEFAULT_LIMIT;
  store.lastLimitSeconds = previousLimit;
  activeDate = nowKey;
  const today = getRecord();
  if (wasRunning && !today.runningSince) {
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    today.runningSince = midnight.getTime();
  }
  saveStore();
}

function reminderCandidates(record, worked) {
  const remaining = record.limitSeconds - worked;
  const candidates = [
    { key: "third", due: worked >= record.limitSeconds / 3, text: "今天的工作時間已使用三分之一。" },
    { key: "half", due: worked >= record.limitSeconds / 2, text: "今天的工作時間已使用一半。" },
    { key: "two-thirds", due: worked >= record.limitSeconds * 2 / 3, text: "今天的工作時間已使用三分之二。" },
    { key: "30-minutes", due: remaining <= 30 * 60 && remaining > 0, text: "距離今日工作上限還有 30 分鐘，請開始收尾。" },
    { key: "10-minutes", due: remaining <= 10 * 60 && remaining > 0, text: "距離今日工作上限只剩 10 分鐘。" },
    { key: "5-minutes", due: remaining <= 5 * 60 && remaining > 0, text: "最後 5 分鐘，請保存工作並準備停止。" },
    { key: "overtime", due: remaining <= 0, text: "今天已超時工作，現在就停下來休息。" }
  ];
  return candidates.filter((item) => item.due && !record.reminders.includes(item.key));
}

function checkReminders(record, worked) {
  if (!record.runningSince) return;
  const due = reminderCandidates(record, worked);
  if (!due.length) return;

  due.forEach((item) => record.reminders.push(item.key));
  saveStore();
  const reminder = due[due.length - 1];
  broadcast(reminder.text, reminder.key === "overtime");
}

function showTicker(message, persistent = false) {
  $("ticker-text").textContent = message;
  $("ticker-copy").textContent = message;
  $("ticker").hidden = false;
  clearTimeout(tickerTimer);
  if (!persistent) {
    tickerTimer = setTimeout(() => {
      $("ticker").hidden = true;
    }, 14000);
  }
}

function broadcast(message, persistent = false) {
  showTicker(message, persistent);

  if (!store.muted) {
    navigator.vibrate?.(persistent ? [300, 140, 300, 140, 500] : [220, 100, 220]);
    if ("speechSynthesis" in window) {
      speechSynthesis.cancel();
      speechSynthesis.speak(new SpeechSynthesisUtterance(message));
    }
  }
  if ("Notification" in window && Notification.permission === "granted") {
    new Notification("到點就停", {
      body: message,
      icon: "./icon.svg",
      silent: Boolean(store.muted)
    });
  }
}

function renderMuteButton() {
  const muted = Boolean(store.muted);
  $("mute-toggle").textContent = muted ? "已靜音" : "語音開啟";
  $("mute-toggle").setAttribute("aria-pressed", String(muted));
  $("mute-toggle").title = muted ? "點擊恢復語音提醒" : "點擊關閉語音和震動";
}

async function toggleWork() {
  rollOverIfNeeded();
  const record = getRecord();
  if (record.runningSince) {
    commitElapsed(record);
  } else {
    if ("Notification" in window && Notification.permission === "default") {
      try { await Notification.requestPermission(); } catch (_) {}
    }
    record.runningSince = Date.now();
    $("limit-panel").hidden = true;
  }
  saveStore();
  render();
}

function setLimit() {
  const hours = Math.max(0, Math.min(23, Number($("limit-hours").value) || 0));
  const minutes = Math.max(0, Math.min(59, Number($("limit-minutes").value) || 0));
  const total = hours * 3600 + minutes * 60;
  if (total < 60) {
    broadcast("工作上限至少要設定 1 分鐘。");
    return;
  }
  const record = getRecord();
  record.limitSeconds = total;
  record.reminders = [];
  store.lastLimitSeconds = total;
  saveStore();
  $("limit-panel").hidden = true;
  $("edit-limit").hidden = Boolean(record.runningSince);
  render();
}

function syncLimitInputs(record = getRecord()) {
  $("limit-hours").value = Math.floor(record.limitSeconds / 3600);
  $("limit-minutes").value = Math.floor((record.limitSeconds % 3600) / 60);
}

function render() {
  rollOverIfNeeded();
  const record = getRecord();
  const worked = workedSeconds(record);
  const remaining = record.limitSeconds - worked;
  const overtime = remaining <= 0;
  const hasStarted = worked > 0 || Boolean(record.runningSince);

  checkReminders(record, worked);
  $("app").classList.toggle("is-overtime", overtime);
  $("today-worked").textContent = formatClock(worked);
  $("clock-label").textContent = overtime ? "今天已超時工作" : "今日剩餘";
  $("clock").textContent = overtime ? `+${formatClock(Math.abs(remaining))}` : formatClock(remaining);
  $("progress").style.width = `${Math.min(100, worked / record.limitSeconds * 100)}%`;
  $("state-label").textContent = record.runningSince ? (overtime ? "已超過今天的工作邊界" : "正在累計今天的工作時間") : hasStarted ? "計時已暫停，休息不會算入工作" : "為今天設定一個清楚的終點";
  $("clock-hint").textContent = `${record.runningSince ? "工作中" : hasStarted ? "已暫停" : "尚未開始"} · 上限 ${formatDuration(record.limitSeconds)}`;
  $("main-action").textContent = record.runningSince ? "暫停工作" : hasStarted ? "繼續工作" : "開始工作";
  $("main-action").classList.toggle("pause-mode", Boolean(record.runningSince));
  $("edit-limit").hidden = Boolean(record.runningSince) || !$("limit-panel").hidden;
  renderMuteButton();

  if (overtime) {
    clearTimeout(tickerTimer);
    $("ticker-text").textContent = "今天已超時工作，請保存手上的內容，現在就停止工作。";
    $("ticker-copy").textContent = $("ticker-text").textContent;
    $("ticker").hidden = false;
  }

  if ($("calendar-dialog").open) renderCalendar();
}

function monthRecords(year, month) {
  return Object.entries(store.records).filter(([key]) => {
    const [recordYear, recordMonth] = key.split("-").map(Number);
    return recordYear === year && recordMonth === month + 1;
  });
}

function totalForEntries(entries) {
  return entries.reduce((sum, [key, record]) => {
    return sum + (key === activeDate ? workedSeconds(record) : Math.floor(record.workedSeconds || 0));
  }, 0);
}

function renderCalendar() {
  const year = calendarCursor.getFullYear();
  const month = calendarCursor.getMonth();
  const days = new Date(year, month + 1, 0).getDate();
  const firstDay = (new Date(year, month, 1).getDay() + 6) % 7;
  const entries = monthRecords(year, month);
  const recordMap = new Map(entries);
  const yearEntries = Object.entries(store.records).filter(([key]) => Number(key.slice(0, 4)) === year);

  $("month-title").textContent = `${year} 年 ${month + 1} 月`;
  $("month-total").textContent = formatDuration(totalForEntries(entries));
  $("year-total").textContent = formatDuration(totalForEntries(yearEntries));
  $("calendar-grid").replaceChildren();

  for (let index = 0; index < firstDay; index += 1) {
    const blank = document.createElement("span");
    blank.className = "calendar-day blank";
    $("calendar-grid").append(blank);
  }

  for (let day = 1; day <= days; day += 1) {
    const key = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const record = recordMap.get(key);
    const seconds = record ? (key === activeDate ? workedSeconds(record) : record.workedSeconds || 0) : 0;
    const cell = document.createElement("div");
    cell.className = `calendar-day${key === activeDate ? " today" : ""}${seconds ? " worked" : ""}`;
    cell.innerHTML = `<span>${day}</span><strong>${formatDuration(seconds, true)}</strong>`;
    cell.title = `${key}：${formatDuration(seconds)}`;
    $("calendar-grid").append(cell);
  }
}

$("main-action").addEventListener("click", toggleWork);
$("mute-toggle").addEventListener("click", () => {
  store.muted = !store.muted;
  saveStore();
  if (store.muted) {
    window.speechSynthesis?.cancel();
    navigator.vibrate?.(0);
  }
  renderMuteButton();
  showTicker(store.muted ? "已靜音：只顯示文字和無聲通知。" : "語音提醒已恢復。");
});
$("save-limit").addEventListener("click", setLimit);
$("edit-limit").addEventListener("click", () => {
  syncLimitInputs();
  $("limit-panel").hidden = false;
  $("edit-limit").hidden = true;
});
document.querySelectorAll("[data-limit-hours]").forEach((button) => {
  button.addEventListener("click", () => {
    $("limit-hours").value = button.dataset.limitHours;
    $("limit-minutes").value = 0;
  });
});

$("open-calendar").addEventListener("click", () => {
  calendarCursor = new Date();
  renderCalendar();
  $("calendar-dialog").showModal();
});
$("close-calendar").addEventListener("click", () => $("calendar-dialog").close());
$("calendar-dialog").addEventListener("click", (event) => {
  if (event.target === $("calendar-dialog")) $("calendar-dialog").close();
});
$("prev-month").addEventListener("click", () => {
  calendarCursor.setMonth(calendarCursor.getMonth() - 1);
  renderCalendar();
});
$("next-month").addEventListener("click", () => {
  calendarCursor.setMonth(calendarCursor.getMonth() + 1);
  renderCalendar();
});

migrateOldSessions();
recoverOvernightRun();
const initialRecord = getRecord();
syncLimitInputs(initialRecord);
$("limit-panel").hidden = workedSeconds(initialRecord) > 0 || Boolean(initialRecord.runningSince);
render();
setInterval(render, 1000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) render();
});
if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => undefined);
