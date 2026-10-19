/* Trang thử: điện thoại đóng vai gateway hiện trường (gia tốc kế + nghiêng). */
(function () {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const KEY_STORE = "shm_test_gw_key", QUEUE_STORE = "shm_test_queue";
  const st = {
    running: false, buf: [], t0: null, lastTilt: null, tiltTimer: null, flushTimer: null,
    queue: [], fsEst: null,
  };

  // ---------------------------------------------------------------- tiện ích
  function log(msg, bad) {
    const el = $("#log");
    const line = `${new Date().toLocaleTimeString("vi-VN", { hour12: false })}  ${msg}\n`;
    el.textContent = line + el.textContent.slice(0, 8000);
    if (bad) console.warn(msg);
  }
  const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
  function store(k, v) { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) {} }
  function load(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function saveQueue() {
    $("#queue").textContent = st.queue.length;
    // chỉ lưu bản ghi nghiêng (nhỏ); đoạn dao động giữ trong bộ nhớ
    store(QUEUE_STORE, JSON.stringify(st.queue.filter((q) => q.kind === "ingest")));
  }
  const key = () => $("#key").value.trim();

  // ---------------------------------------------------------------- gửi
  async function post(path, body, apiKey) {
    const res = await window.oseFetch(path, {
      method: "POST", headers: { "Content-Type": "application/json", "X-API-Key": apiKey || key() },
      body: JSON.stringify(body),
    });
    let data = null;
    try { data = await res.json(); } catch (e) {}
    return { res, data };
  }

  function enqueue(item) { st.queue.push(item); saveQueue(); flush(); }

  async function flush() {
    if ($("#offline").checked || st.flushing || !st.queue.length) return;
    st.flushing = true;
    try {
      while (st.queue.length && !$("#offline").checked) {
        const item = st.queue[0];
        let r;
        try { r = await post(item.path, item.body); }
        catch (e) { log(`Mất kết nối (${e.message}); giữ ${st.queue.length} mục, thử lại sau 30 giây`, true); break; }
        const s = r.res.status;
        if (s === 200) {
          st.queue.shift(); saveQueue();
          const d = r.data || {};
          if (item.kind === "waveform") {
            const f = d.features || {};
            log(`Đoạn dao động ${d.stored ? "đã lưu" : "trùng, bỏ qua"} · freq ${f.freq ? f.freq.toFixed(2) + " Hz" : "không rõ đỉnh"} · rms ${f.rms ? f.rms.toFixed(4) : "–"}`
              + (d.freq_change_percent !== undefined ? ` · so với nền ${d.freq_change_percent.toFixed(1)}%` : ""));
          } else {
            log(`Đã gửi ${d.received} bản ghi: nhận ${d.accepted}, trùng ${d.duplicates}, loại ${d.rejected}`
              + ((d.errors || []).length ? " · " + d.errors.map((x) => x.detail).join("; ") : ""), d.rejected > 0);
          }
        } else if (s === 401) {
          log("401: khoá API sai hoặc đã thu hồi — dừng gửi, kiểm tra khoá", true); break;
        } else if (s === 422) {
          st.queue.shift(); saveQueue();
          log(`422: dữ liệu bị từ chối — ${JSON.stringify((r.data || {}).detail)}`, true);
        } else if (s === 429 || s >= 500) {
          const ra = Number(r.res.headers.get("Retry-After")) || 30;
          log(`${s}: máy chủ ${s === 429 ? "báo gửi quá dày" : "chính đang mất / dự phòng"}; giữ ${st.queue.length} mục, thử lại sau ${ra} giây`, true);
          break;
        } else {
          st.queue.shift(); saveQueue();
          log(`HTTP ${s}: ${JSON.stringify(r.data)}`, true);
        }
      }
    } finally { st.flushing = false; }
  }

  // ---------------------------------------------------------------- cảm biến
  function onMotion(e) {
    const a = e.accelerationIncludingGravity || e.acceleration;
    if (!a || a.z === null) return;
    const now = performance.now();
    if (!st.buf.length) st.t0 = Date.now();
    st.buf.push([now, a.z]);
    const n = Number($("#nSamples").value);
    if (st.buf.length % 15 === 0) {
      $("#az").textContent = a.z.toFixed(3);
      $("#prog").style.width = `${Math.min(100, st.buf.length / n * 100)}%`;
    }
    if (st.buf.length >= n) {
      const b = st.buf; st.buf = [];
      const fs = (b.length - 1) / ((b[b.length - 1][0] - b[0][0]) / 1000);
      st.fsEst = fs;
      $("#fs").textContent = `${fs.toFixed(1)} Hz`;
      enqueue({ kind: "waveform", path: "/api/ingest/waveform", body: {
        sensor: $("#accCode").value.trim(), axis: "z", ts: iso(st.t0), fs: Math.round(fs * 100) / 100,
        unit: "m/s2", fmin: 0.5, fmax: Math.min(25, fs / 2 - 0.5), samples: b.map((x) => Math.round(x[1] * 1e5) / 1e5),
      } });
    }
  }

  function onOrient(e) {
    if (e.beta === null) return;
    st.lastTilt = { x: e.beta, y: e.gamma };
    $("#tilt").textContent = `${e.beta.toFixed(1)} / ${e.gamma.toFixed(1)}`;
  }

  function sendTilt(override) {
    const t = override || st.lastTilt;
    if (!t) { log("Chưa có số liệu nghiêng (thiết bị không hỗ trợ hoặc chưa cấp quyền)"); return; }
    const ts = iso(Date.now()), code = $("#tltCode").value.trim();
    enqueue({ kind: "ingest", path: "/api/ingest", body: { records: [
      { sensor: code, channel: "x", ts, value: Math.round(t.x * 1000) / 1000 },
      { sensor: code, channel: "y", ts, value: Math.round(t.y * 1000) / 1000 },
    ] } });
  }

  async function askPermission() {
    const asks = [];
    if (window.DeviceMotionEvent && typeof DeviceMotionEvent.requestPermission === "function") asks.push(DeviceMotionEvent.requestPermission());
    if (window.DeviceOrientationEvent && typeof DeviceOrientationEvent.requestPermission === "function") asks.push(DeviceOrientationEvent.requestPermission());
    const res = await Promise.all(asks);
    return res.every((r) => r === "granted");
  }

  // ---------------------------------------------------------------- điều khiển
  async function start() {
    if (!key()) { log("Nhập khoá API trước", true); return; }
    if ($("#remember").checked) store(KEY_STORE, key()); else store(KEY_STORE, null);
    if (!window.DeviceMotionEvent) { log("Trình duyệt này không có gia tốc kế; chỉ dùng được nút gửi thủ công", true); }
    try {
      if (!(await askPermission())) { log("Chưa được cấp quyền cảm biến chuyển động (Cài đặt › Safari › Chuyển động & hướng)", true); return; }
    } catch (e) { log(`Không xin được quyền cảm biến: ${e.message}`, true); return; }
    st.running = true; st.buf = [];
    window.addEventListener("devicemotion", onMotion);
    window.addEventListener("deviceorientation", onOrient);
    const every = Math.max(10, Number($("#tltEvery").value) || 60) * 1000;
    st.tiltTimer = setInterval(() => sendTilt(), every);
    st.flushTimer = setInterval(flush, 30000);
    setTimeout(() => sendTilt(), 3000);
    $("#start").disabled = true; $("#stop").disabled = false;
    log(`Bắt đầu: đoạn dao động ${$("#nSamples").value} mẫu, nghiêng mỗi ${every / 1000} giây`);
  }

  function stop() {
    st.running = false;
    window.removeEventListener("devicemotion", onMotion);
    window.removeEventListener("deviceorientation", onOrient);
    clearInterval(st.tiltTimer); clearInterval(st.flushTimer);
    $("#start").disabled = false; $("#stop").disabled = true;
    $("#prog").style.width = "0";
    log(`Dừng. Còn ${st.queue.length} mục trong bộ đệm.`);
  }

  // ---------------------------------------------------------------- khởi tạo
  const saved = load(KEY_STORE);
  if (saved) { $("#key").value = saved; $("#remember").checked = true; }
  try { st.queue = JSON.parse(load(QUEUE_STORE) || "[]"); } catch (e) { st.queue = []; }
  saveQueue();
  $("#start").onclick = start;
  $("#stop").onclick = stop;
  $("#offline").onchange = (e) => {
    log(e.target.checked ? "Giả lập mất mạng: số liệu sẽ giữ trong bộ đệm" : "Có mạng lại: gửi bù bộ đệm");
    if (!e.target.checked) flush();
  };
  $("#spike").onclick = () => { if (!key()) return log("Nhập khoá API trước", true); sendTilt({ x: 5, y: (st.lastTilt || { y: 0 }).y }); log("Đã xếp bản ghi nghiêng x = 5° để thử ngưỡng"); };
  $("#badkey").onclick = async () => {
    try {
      const r = await post("/api/ingest", { records: [] }, "shm_00000000.sai");
      log(`Khoá sai → HTTP ${r.res.status} (đúng là 401)`, r.res.status !== 401);
    } catch (e) { log(`Lỗi kết nối: ${e.message}`, true); }
  };
  if (st.queue.length) log(`Còn ${st.queue.length} mục chờ gửi từ lần trước`);
  window.addEventListener("online", flush);
})();
