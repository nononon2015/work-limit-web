const $ = (id) => document.getElementById(id);
const state = { duration:45, phase:"idle", remaining:2700, overtime:0, endAt:null, pausedRemaining:0, announced:false };
let sessions = JSON.parse(localStorage.getItem("stopwork-sessions") || "[]");
const labels = { idle:"保护你的下班时间", running:"专注进行中", paused:"暂时暂停", overtime:"已经超时" };

function formatClock(seconds) {
  const value = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(value / 60)).padStart(2,"0")}:${String(value % 60).padStart(2,"0")}`;
}
function todaySessions() {
  const today = new Date().toLocaleDateString("zh-CN");
  return sessions.filter((item) => new Date(item.finishedAt).toLocaleDateString("zh-CN") === today);
}
function renderStats() {
  const today = todaySessions();
  const minutes = today.reduce((sum,item) => sum + item.minutes, 0);
  $("today-minutes").textContent = minutes;
  $("session-count").textContent = today.length;
  $("work-minutes").textContent = minutes;
  $("overtime-minutes").textContent = today.reduce((sum,item) => sum + item.overtime, 0);
}
function render() {
  const active = ["running","paused","overtime"].includes(state.phase);
  $("app").classList.toggle("is-overtime", state.phase === "overtime");
  $("state-label").textContent = labels[state.phase] || "这一段结束了";
  $("duration-picker").hidden = active || state.phase === "finished";
  $("pause").hidden = !["running","paused"].includes(state.phase);
  $("pause").textContent = state.phase === "paused" ? "继续" : "暂停";
  $("main-action").textContent = state.phase === "idle" ? "开始工作" : state.phase === "finished" ? "开始下一段" : "结束工作";
  $("main-action").classList.toggle("danger", state.phase === "overtime");
  const progress = state.phase === "idle" ? 0 : Math.min(1, 1 - state.remaining / (state.duration * 60));
  $("progress").style.width = `${progress * 100}%`;
  if (state.phase === "finished") return;
  $("clock-label").textContent = state.phase === "overtime" ? "超时" : "剩余";
  $("clock").textContent = state.phase === "overtime" ? `+${formatClock(state.overtime)}` : formatClock(state.remaining);
  $("clock-hint").textContent = state.phase === "idle" ? `准备开始 ${state.duration} 分钟的工作` : state.phase === "overtime" ? "请结束手上的工作" : state.phase === "paused" ? "计时已暂停" : "专心做这一件事";
}
async function start() {
  if ("Notification" in window && Notification.permission === "default") await Notification.requestPermission();
  state.phase = "running"; state.remaining = state.duration * 60; state.overtime = 0; state.endAt = Date.now() + state.remaining * 1000; state.announced = false;
  $("notice").hidden = true; render();
}
function finish() {
  const worked = Math.max(1, Math.round((state.duration * 60 - state.remaining + state.overtime) / 60));
  sessions.unshift({ id:Date.now(), minutes:worked, overtime:Math.ceil(state.overtime / 60), finishedAt:new Date().toISOString() });
  sessions = sessions.slice(0,30); localStorage.setItem("stopwork-sessions",JSON.stringify(sessions));
  state.endAt = null; state.phase = "finished";
  $("timer-state").innerHTML = `<div class="finish-state"><span>✓</span><h2>这一段结束了</h2><p>${state.overtime ? `本次超时 ${Math.ceil(state.overtime / 60)} 分钟。下次到点就停。` : "做得好。现在离开工作，认真休息。"}</p></div>`;
  renderStats(); render();
}
function reset() { location.reload(); }

document.querySelectorAll("[data-minutes]").forEach((button) => button.addEventListener("click", () => {
  state.duration = Number(button.dataset.minutes); state.remaining = state.duration * 60;
  document.querySelectorAll("[data-minutes]").forEach((item) => item.classList.toggle("selected", item === button)); render();
}));
$("main-action").addEventListener("click", () => state.phase === "idle" ? start() : state.phase === "finished" ? reset() : finish());
$("pause").addEventListener("click", () => {
  if (state.phase === "running") { state.pausedRemaining = state.remaining; state.endAt = null; state.phase = "paused"; }
  else { state.endAt = Date.now() + state.pausedRemaining * 1000; state.phase = "running"; }
  render();
});
setInterval(() => {
  if (!state.endAt || !["running","overtime"].includes(state.phase)) return;
  const delta = Math.ceil((state.endAt - Date.now()) / 1000);
  if (delta > 0) state.remaining = delta;
  else {
    state.remaining = 0; state.overtime = Math.abs(delta); state.phase = "overtime";
    if (!state.announced) {
      state.announced = true; $("notice").textContent = "工作时间到了。保存精力，现在就停下来休息。"; $("notice").hidden = false;
      navigator.vibrate?.([250,120,250]);
      if ("Notification" in window && Notification.permission === "granted") new Notification("工作时间到了",{body:"请停止工作，给自己留出恢复时间。"});
    }
  }
  render();
},250);
renderStats(); render();
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => undefined);
