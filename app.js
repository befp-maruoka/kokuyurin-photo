/* 国有林 現場写真送信（試作）
 * 流れ：写真を選ぶ → まず端末内(IndexedDB)に保存 → 1枚ずつ送信 → 成功したら端末から消す
 * 電波がない・送信失敗のときは端末に残り、通信復帰・画面表示・定期タイマーで自動再送する。
 */
(function () {
  "use strict";
  const CFG = window.APP_CONFIG;
  const LS_KEY = "kokuyurin.key";
  const LS_USER = "kokuyurin.user";
  const LS_SITES = "kokuyurin.sites";
  const LS_SITE = "kokuyurin.lastSite";

  const $ = (id) => document.getElementById(id);
  const ls = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
    del(k) { try { localStorage.removeItem(k); } catch (e) {} },
  };

  // ---------- IndexedDB ----------
  let dbp = null;
  function db() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open("kokuyurin-photo", 1);
      req.onupgradeneeded = () => {
        const s = req.result.createObjectStore("queue", { keyPath: "id" });
        s.createIndex("sha256", "sha256", { unique: false });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbp;
  }
  async function tx(mode, fn) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const t = d.transaction("queue", mode);
      const store = t.objectStore("queue");
      let out;
      Promise.resolve(fn(store)).then((v) => { out = v; });
      t.oncomplete = () => resolve(out);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }
  const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const qAll = () => tx("readonly", (s) => reqP(s.getAll()));
  const qPut = (item) => tx("readwrite", (s) => { s.put(item); });
  const qDel = (id) => tx("readwrite", (s) => { s.delete(id); });
  const qHasSha = (sha) => tx("readonly", (s) => reqP(s.index("sha256").count(sha)));

  // ---------- 小物 ----------
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function batchId() {
    const d = new Date(); const p = (n) => String(n).padStart(2, "0");
    return "B" + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "-" + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }
  async function sha256(blob) {
    const buf = await blob.arrayBuffer();
    const h = await crypto.subtle.digest("SHA-256", buf);
    return Array.from(new Uint8Array(h)).map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  function toBase64(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => { const s = String(r.result); resolve(s.slice(s.indexOf(",") + 1)); };
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
  }
  function mimeOf(file) {
    if (file.type) return file.type;
    const n = file.name.toLowerCase();
    if (n.endsWith(".heic")) return "image/heic";
    if (n.endsWith(".heif")) return "image/heif";
    if (n.endsWith(".png")) return "image/png";
    return "image/jpeg";
  }
  function isImage(file) {
    return /^image\//.test(file.type) || /\.(jpe?g|png|heic|heif)$/i.test(file.name);
  }
  function mb(n) { return (n / 1024 / 1024).toFixed(1) + "MB"; }
  function show(el, cls, text) { el.innerHTML = text ? '<div class="msg ' + cls + '">' + text + "</div>" : ""; }

  // ---------- 通信 ----------
  // Apps Script はプリフライト不要な text/plain で送る（CORSで弾かれないため）
  // 電波が弱く応答が返らないときは時間切れで打ち切り、写真は端末に残す
  async function api(payload, timeoutMs) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs || 20000);
    try {
      const res = await fetch(CFG.API_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(payload),
        redirect: "follow",
        cache: "no-store",
        signal: ctl.signal,
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  // ---------- 送信キー・現場一覧 ----------
  async function loadSites() {
    const key = ls.get(LS_KEY);
    if (!key) return;
    try {
      const r = await api({ action: "sites", key });
      if (r.ok) {
        ls.set(LS_USER, r.user || "");
        ls.set(LS_SITES, JSON.stringify(r.sites || []));
        renderSites();
      } else if (r.error === "unauthorized") {
        needKey("送信キーが無効になっています。事務所に確認してください。");
      }
    } catch (e) {
      // 電波がない：前回保存した現場一覧を使う
      renderSites();
    }
  }
  function renderSites() {
    let sites = [];
    try { sites = JSON.parse(ls.get(LS_SITES) || "[]"); } catch (e) {}
    const sel = $("site-select");
    const last = ls.get(LS_SITE);
    sel.innerHTML = '<option value="">現場を選んでください</option>' +
      sites.map((s) => '<option value="' + s.id + '"' + (s.id === last ? " selected" : "") + ">" +
        escapeHtml(s.name) + (s.detail ? "（" + escapeHtml(s.detail) + "）" : "") + "</option>").join("");
    $("site-note").textContent = sites.length ? "" : "現場一覧を取得できていません。電波のある場所で一度開いてください。";
    $("user-pill").textContent = ls.get(LS_USER) ? ls.get(LS_USER) + " さん" : "未設定";
    updateSendBtn();
  }
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
  function needKey(msg) {
    $("key-card").classList.remove("hidden");
    $("send-card").classList.add("hidden");
    show($("key-msg"), "err", msg || "");
  }

  // ---------- 事務所からの過不足結果 ----------
  const LS_RESULT = "kokuyurin.result.";
  function currentSite() { return $("site-select").value || ls.get(LS_SITE) || ""; }
  async function loadResult() {
    const key = ls.get(LS_KEY), site = currentSite();
    if (!key || !site) { renderResult(null); return; }
    try {
      const r = await api({ action: "status", key, siteId: site });
      if (r.ok) ls.set(LS_RESULT + site, JSON.stringify(r.shared || null));
    } catch (e) { /* 電波なし：前回受け取った結果を表示 */ }
    let shared = null;
    try { shared = JSON.parse(ls.get(LS_RESULT + site) || "null"); } catch (e) {}
    renderResult(shared);
  }
  function renderResult(shared) {
    const card = $("result-card");
    if (!shared || !shared.summary) { card.classList.add("hidden"); return; }
    card.classList.remove("hidden");
    const s = shared.summary, d = new Date(shared.sharedAt), p2 = (n) => String(n).padStart(2, "0");
    $("result-pills").innerHTML = '<span class="pill ok">完了 ' + s.done + '</span><span class="pill off">要確認 ' + s.check + '</span><span class="pill err">不足 ' + s.short + "</span>";
    $("result-note").textContent = (d.getMonth() + 1) + "/" + d.getDate() + " " + p2(d.getHours()) + ":" + p2(d.getMinutes()) + " 時点（必要 " + s.total + "項目）" + (navigator.onLine ? "" : "・電波がないため前回の結果です");
    const need = s.items.filter((i) => i.status !== "完了");
    const byWork = [];
    need.forEach((i) => { let w = byWork.find((x) => x.work === i.work); if (!w) { w = { work: i.work, ng: [], ck: [] }; byWork.push(w); } (i.status === "不足" ? w.ng : w.ck).push(i.kubun); });
    $("result-list").innerHTML = need.length
      ? '<ul class="rl">' + byWork.map((w) =>
          "<li><span><b>" + escapeHtml(w.work) + "</b><br>" +
          (w.ng.length ? '<span class="ng">追加撮影：' + w.ng.map(escapeHtml).join("・") + "</span>" : "") +
          (w.ng.length && w.ck.length ? "<br>" : "") +
          (w.ck.length ? '<span class="ck">事務所で確認中：' + w.ck.map(escapeHtml).join("・") + "</span>" : "") + "</span></li>").join("") + "</ul>"
      : '<div class="msg ok">必要な写真はすべてそろっています。</div>';
  }

  // ---------- 写真選択・保存 ----------
  let picked = [];
  function updateSendBtn() {
    $("send-btn").disabled = !($("site-select").value && picked.length);
  }
  function onPick(e) {
    const files = Array.from(e.target.files || []);
    const msgs = [];
    let ok = files.filter(isImage);
    if (ok.length < files.length) msgs.push((files.length - ok.length) + "件は写真ではないため除きました");
    const big = ok.filter((f) => f.size > CFG.MAX_BYTES);
    if (big.length) { ok = ok.filter((f) => f.size <= CFG.MAX_BYTES); msgs.push(big.length + "枚は" + mb(CFG.MAX_BYTES) + "を超えるため除きました"); }
    if (ok.length > CFG.MAX_FILES) { msgs.push("最大" + CFG.MAX_FILES + "枚までです。先頭の" + CFG.MAX_FILES + "枚を使います"); ok = ok.slice(0, CFG.MAX_FILES); }
    picked = ok;
    const total = ok.reduce((a, f) => a + f.size, 0);
    $("pick-info").textContent = ok.length ? ok.length + "枚選択中（合計 " + mb(total) + "）" : "まだ選んでいません";
    show($("send-msg"), "warn", msgs.join("<br>"));
    updateSendBtn();
  }
  async function onSend() {
    const sel = $("site-select");
    const siteId = sel.value;
    const siteName = sel.options[sel.selectedIndex].text;
    if (!siteId || !picked.length) return;
    ls.set(LS_SITE, siteId);
    $("send-btn").disabled = true;
    show($("send-msg"), "ok", "端末に保存しています…");
    const bid = batchId();
    let added = 0, dup = 0;
    for (const f of picked) {
      const hash = await sha256(f);
      if (await qHasSha(hash)) { dup++; continue; } // 同じ写真が未送信で残っている
      // File をそのまま入れると iOS で読めなくなることがあるため Blob に複製して保存
      const blob = new Blob([await f.arrayBuffer()], { type: mimeOf(f) });
      await qPut({ id: uid(), batchId: bid, siteId, siteName, fileName: f.name, mimeType: mimeOf(f), size: f.size,
        lastModified: f.lastModified || null, sha256: hash, blob, status: "pending", attempts: 0, lastError: "", createdAt: Date.now() });
      added++;
    }
    picked = [];
    $("file-input").value = "";
    $("pick-info").textContent = "まだ選んでいません";
    show($("send-msg"), "ok", added + "枚を端末に保存しました" + (dup ? "（" + dup + "枚は未送信の写真と同じため省きました）" : "") + "。電波があれば順に送信します。");
    await refreshQueue();
    sync();
  }

  // ---------- 送信処理 ----------
  let syncing = false;
  let lastResult = null; // {saved, duplicate, failed, offline}
  async function sync() {
    if (syncing) return;
    const key = ls.get(LS_KEY);
    if (!key) return;
    const items = (await qAll()).filter((i) => i.status !== "done").sort((a, b) => a.createdAt - b.createdAt);
    if (!items.length) { await refreshQueue(); return; }
    syncing = true;
    const r = { saved: 0, duplicate: 0, failed: 0, offline: false };
    show($("sync-msg"), "ok", "送信中…");
    for (const item of items) {
      try {
        const data = await toBase64(item.blob);
        const res = await api({ action: "upload", key, batchId: item.batchId, siteId: item.siteId, fileName: item.fileName,
          mimeType: item.mimeType, size: item.size, lastModified: item.lastModified, sha256: item.sha256, data }, 180000);
        if (res.ok) {
          res.status === "duplicate" ? r.duplicate++ : r.saved++;
          await qDel(item.id);
        } else if (res.error === "unauthorized") {
          needKey("送信キーが無効です。写真は端末に残っています。");
          break;
        } else {
          item.attempts++; item.lastError = res.error || "サーバーエラー"; item.status = "error";
          await qPut(item); r.failed++;
        }
      } catch (e) {
        // 通信できない：ここで打ち切り、写真は端末に残す
        r.offline = true;
        break;
      }
      await refreshQueue();
    }
    syncing = false;
    lastResult = r;
    await refreshQueue();
  }

  async function refreshQueue() {
    const items = (await qAll()).sort((a, b) => a.createdAt - b.createdAt);
    $("pending-count").textContent = items.length + " 枚";
    $("queue-list").innerHTML = items.slice(0, 50).map((i) =>
      "<li><span>" + escapeHtml(i.fileName) + "</span><span>" + (i.status === "error" ? '<span style="color:var(--err)">再送待ち</span>' : "未送信") + "</span></li>").join("");
    const r = lastResult;
    if (syncing) return;
    if (!items.length && r && (r.saved || r.duplicate)) {
      show($("sync-msg"), "ok", "すべて送信しました（新規 " + r.saved + "枚" + (r.duplicate ? "・送信済みと同じ " + r.duplicate + "枚" : "") + "）");
    } else if (items.length && (r && r.offline || !navigator.onLine)) {
      show($("sync-msg"), "warn", "電波がないため端末に保存中です。つながると自動で送ります。");
    } else if (items.length && r && r.failed) {
      show($("sync-msg"), "err", r.failed + "枚の送信に失敗しました。自動で再送します。");
    } else if (!items.length) {
      show($("sync-msg"), "", "");
    }
  }

  function updateNet() {
    const p = $("net-pill");
    if (navigator.onLine) { p.textContent = "通信あり"; p.className = "pill"; }
    else { p.textContent = "電波なし（端末に保存）"; p.className = "pill off"; }
  }

  // ---------- 起動 ----------
  async function start() {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    }
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    updateNet();
    window.addEventListener("online", () => { updateNet(); loadSites(); sync(); loadResult(); });
    window.addEventListener("offline", () => { updateNet(); refreshQueue(); });
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") { sync(); loadResult(); } });
    setInterval(sync, CFG.RETRY_INTERVAL_MS);

    $("file-input").addEventListener("change", onPick);
    $("site-select").addEventListener("change", () => { updateSendBtn(); ls.set(LS_SITE, $("site-select").value); loadResult(); });
    $("send-btn").addEventListener("click", onSend);
    $("retry-btn").addEventListener("click", sync);
    $("key-btn").addEventListener("click", async () => {
      const k = $("key-input").value.trim();
      if (!k) return;
      show($("key-msg"), "ok", "確認しています…");
      try {
        const r = await api({ action: "sites", key: k });
        if (!r.ok) { show($("key-msg"), "err", "送信キーが違います"); return; }
        ls.set(LS_KEY, k); ls.set(LS_USER, r.user || ""); ls.set(LS_SITES, JSON.stringify(r.sites || []));
        $("key-input").value = "";
        $("key-card").classList.add("hidden"); $("send-card").classList.remove("hidden");
        renderSites(); sync();
      } catch (e) { show($("key-msg"), "err", "通信できません。電波のある場所で設定してください。"); }
    });
    $("reset-key").addEventListener("click", (e) => {
      e.preventDefault();
      ls.del(LS_KEY); ls.del(LS_USER);
      needKey(""); renderSites();
    });

    if (ls.get(LS_KEY)) { $("send-card").classList.remove("hidden"); renderSites(); loadSites(); loadResult(); }
    else needKey("");
    await refreshQueue();
    sync();
  }
  start();
})();
