import { S, get, post, loadHistory } from "../store.js";
import { $, $$, esc, fmt, icon, toast, ago, load, save, confirmDialog } from "../ui.js";
import { METHOD_ICON } from "./common.js";

let view = null;
let tab = load("log.tab", "history");


function stamp(t) {
  const d = new Date(t * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function historyHTML() {
  if (!S.history.length) return `<div class="empty">${icon("clock")}<h3>还没有操作记录</h3><p>做出修改后，这里会按时间记录每一步，并支持撤销货币类修改。</p></div>`;
  return `<div class="card pad"><div class="feed">${S.history.map((h) => `
    <div class="feed-item ${h.ok ? "" : "bad"}">
      <div class="fi">${icon(h.ok ? METHOD_ICON[h.method] || "check" : "alert")}</div>
      <div style="min-width:0;flex:1"><div class="ft">${esc(h.title || h.method)} ${h.undone ? '<span class="badge" style="margin-left:6px">已撤销</span>' : ""}</div><div class="fs">${esc(h.summary || "")}</div></div>
      <div class="fw" title="${stamp(h.time)}">${ago(h.time)}</div>
      ${h.undo && !h.undone ? `<button class="btn sm" data-undo="${h.id}">${icon("undo")}撤销</button>` : ""}
    </div>`).join("")}</div></div>`;
}

async function backupsHTML() {
  const r = await get("/api/backups");
  if (!r.ok) return `<div class="empty">${icon("alert")}<h3>读取失败</h3><p>${esc(r.error.message)}</p></div>`;
  return `
    <div class="callout info" style="margin-bottom:16px">${icon("info")}<div>每次修改存档（货币、解锁、等级）之前，修改器会自动备份你的存档文件（至多每 10 分钟一份，保留最近 30 份）。游戏自己还会保留 <span class="mono">.bak1/.bak2</span>。</div></div>
    <div class="card pad" style="margin-bottom:16px">
      <div class="row wrap"><div style="min-width:0;flex:1"><div class="card-title">${icon("save")}当前存档文件</div><div class="rcode" style="margin-top:6px;word-break:break-all">${esc(r.saveFile || "未找到")}</div></div>
      <button class="btn primary" id="backup-now">${icon("save")}立即备份</button><button class="btn" id="open-backups">${icon("folder")}打开备份文件夹</button></div>
      <div class="muted" style="font-size:12.5px;margin-top:12px">还原方法：<b>先完全退出游戏</b>，把备份文件夹里的 <span class="mono">persistent_user_data.bin</span> 复制回上面的存档位置覆盖即可。游戏运行时不要还原。</div>
    </div>
    <div class="list"><div class="list-head" style="grid-template-columns:minmax(0,2fr) 1fr 1fr"><span>备份</span><span>时间</span><span>大小</span></div>
    ${r.items.map((b) => `<div class="list-row" style="grid-template-columns:minmax(0,2fr) 1fr 1fr"><div class="rcode" style="font-size:12px">${esc(b.name)}</div><div class="muted">${stamp(b.time)}</div><div class="muted num">${fmt(Math.round(b.size / 1024))} KB</div></div>`).join("") || '<div class="muted" style="padding:20px">还没有备份。第一次修改存档时会自动创建。</div>'}</div>`;
}

async function logHTML() {
  const r = await get("/api/log");
  const lines = r.ok ? r.lines : [r.error.message];
  return `<div class="row" style="margin-bottom:10px"><span class="muted">后台运行日志（最近 ${lines.length} 行）</span><div class="spacer"></div><button class="btn sm" id="log-refresh">${icon("refresh")}刷新</button></div><div class="card logbox" id="logbox">${esc(lines.join("\n")) || "（空）"}</div>`;
}

function aboutHTML() {
  return `
    <div class="card pad" style="max-width:760px">
      <div class="card-title">${icon("info")}关于跳帮修改器</div>
      <div class="stack" style="margin-top:12px;color:var(--text-2)">
        <p>本工具通过 Frida 连接正在运行的 Jump Space，直接调用游戏自己的函数完成修改（物品、货币、蓝图、舰船、无敌/锁血/无限弹药、移动速度与跳跃）。<b>不会修改游戏安装文件</b>；所有“锁定类”开关关掉就恢复原状，游戏退出后修改器的后台也会自动结束。</p>
        <p>所有名称都来自游戏内的本地化文本，因此与游戏里看到的一致。货币、等级、蓝图和舰船会写入你的<b>本机存档</b>，修改前会自动备份。</p>
        <p><b>请只在单人或自己的房间里使用。</b>在别人的房间里或联机匹配中使用可能影响他人的游戏体验，也可能让游戏状态不同步。</p>
        <p class="muted">快捷键：<span class="kbd">/</span> 在物品页聚焦搜索　<span class="kbd">Esc</span> 关闭弹窗　<span class="kbd">1</span>–<span class="kbd">7</span> 切换页面</p>
      </div>
      <div class="callout info" style="margin-top:14px">${icon("info")}<div>
        <b>关闭窗口后，后台会继续待命，直到游戏退出。</b>这是有意的：Frida 一旦从运行中的游戏断开，游戏在退出时就会崩溃或卡死
        （已实测）。待命时所有开关都是关闭的，不会改动游戏；游戏退出后后台自动结束。下次再打开修改器就能直接接上。</div></div>
      <div class="row" style="margin-top:18px;gap:10px">
        <button class="btn danger" id="quit-app">${icon("power")}关闭修改器窗口</button>
        <button class="btn" id="stop-service" title="只有游戏没在运行时才能彻底停止后台">${icon("x")}彻底退出后台</button>
      </div>
    </div>`;
}

let paintToken = 0;

async function paint() {
  const token = ++paintToken; // a slower earlier paint must not overwrite a newer tab
  $$("#log-tabs button", view).forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
  const body = $("#log-body", view);
  body.innerHTML = `<div class="skeleton" style="height:200px"></div>`;
  let html = "";
  if (tab === "history") { await loadHistory(); html = historyHTML(); }
  else if (tab === "backups") html = await backupsHTML();
  else if (tab === "log") html = await logHTML();
  else html = aboutHTML();
  if (view && token === paintToken) body.innerHTML = html;
  const box = $("#logbox", view);
  if (box) box.scrollTop = box.scrollHeight;
}

export default {
  id: "log",
  title: "记录与设置",
  sub: "操作记录、存档备份、运行日志",
  icon: "clock",
  group: "tools",

  async render(v) {
    view = v;
    view.innerHTML = `<div class="tabs" id="log-tabs"><button data-tab="history">操作记录</button><button data-tab="backups">存档备份</button><button data-tab="log">运行日志</button><button data-tab="about">关于</button></div><div id="log-body"></div>`;
    view.onclick = async (e) => {
      const t = e.target.closest("#log-tabs [data-tab]");
      if (t) { tab = t.dataset.tab; save("log.tab", tab); return paint(); }
      const u = e.target.closest("[data-undo]");
      if (u) {
        const r = await post("/api/undo", { id: Number(u.dataset.undo) });
        if (r.ok) toast("已撤销", "", "good"); else toast("撤销失败", r.error.message, "bad");
        return paint();
      }
      if (e.target.closest("#backup-now")) {
        const r = await post("/api/backup");
        if (r.ok) toast("已备份存档", r.name, "good"); else toast("备份失败", r.error.message, "bad");
        return paint();
      }
      if (e.target.closest("#open-backups")) return post("/api/open-backups");
      if (e.target.closest("#log-refresh")) return paint();
      if (e.target.closest("#quit-app")) {
        post("/api/quit");
        document.body.innerHTML = `<div class="empty" style="height:100vh"><h3>修改器窗口已关闭</h3><p>可以关闭这个窗口了。所有开关都已恢复原状；后台会继续待命，游戏退出后自动结束。</p></div>`;
      }
      if (e.target.closest("#stop-service")) {
        const ok = await confirmDialog({ title: "彻底退出后台？", message: "后台会停止，修改器完全退出。游戏正在运行时不能这样做（会让游戏退出时崩溃）；那种情况请直接关闭窗口，游戏退出后后台会自己结束。", confirmText: "彻底退出" });
        if (!ok) return;
        const r = await post("/api/stop-service");
        if (r.ok) {
          post("/api/quit");
          document.body.innerHTML = `<div class="empty" style="height:100vh"><h3>修改器已完全退出</h3><p>可以关闭这个窗口了。</p></div>`;
        } else {
          toast("现在不能彻底退出", r.error ? r.error.message : "", "warn");
        }
      }
    };
    await paint();
  },

  update() {},
};
