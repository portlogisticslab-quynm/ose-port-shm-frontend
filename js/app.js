/* port-shm frontend — HTML/JS tĩnh. Mọi lệnh gọi backend đi qua apiCall → window.oseFetch. */
(function () {
  "use strict";

  // ============================================================ tiện ích
  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmtNum = (v, d = 3) => (v === null || v === undefined || Number.isNaN(v)) ? "–"
    : Number(v).toLocaleString("vi-VN", { maximumFractionDigits: d });
  const fmtTime = (iso) => iso ? new Date(iso).toLocaleString("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh", hour12: false, year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "–";
  const fmtDate = (iso) => iso ? new Date(iso).toLocaleDateString("vi-VN") : "–";
  const UNIT = { degC: "°C", deg: "°", ue: "µε", uA: "µA", "m/s2": "m/s²" };
  const unitLabel = (u) => UNIT[u] ?? u ?? "";
  const LEVEL = ["Bình thường", "Chú ý", "Cảnh báo", "Hành động"];
  const lv = (n) => `<span class="lv lv-${Number(n) || 0}">${LEVEL[Number(n) || 0]}</span>`;
  const STATUS = { open: "Đang mở", acknowledged: "Đã xem", closed: "Đã đóng",
                   proposed: "Đề xuất", confirmed: "Đã xác nhận", rejected: "Không chấp nhận" };
  const ROLE = { admin: "Quản trị", engineer: "Kỹ sư", operator: "Khai thác", viewer: "Xem", guest: "Khách xem" };
  const RANK = { guest: -1, viewer: 0, operator: 1, engineer: 2, admin: 3 };
  const GUEST_TABS = ["dashboard", "overview", "wharf", "breakwater", "alerts", "berthing"];
  const isGuest = () => !!state.user && state.user.role === "guest";

  const state = { token: null, user: null, catalog: null, tab: "overview", sub: {},
                  structures: [], timer: null };

  function toast(msg, isError = false) {
    const t = $("#toast");
    t.textContent = msg;
    t.className = "toast" + (isError ? " error" : "");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.add("hidden"), isError ? 7000 : 3500);
  }
  const can = (role) => state.user && RANK[state.user.role] >= RANK[role];
  const canApprove = () => state.user && (state.user.can_approve || state.user.role === "admin");

  // ============================================================ API (Phụ lục C + đăng nhập)
  async function apiCall(path, method = "GET", body, raw = false) {
    const opts = { method, headers: {} };
    if (state.token) opts.headers.Authorization = "Bearer " + state.token;
    if (body instanceof FormData) opts.body = body;
    else if (body !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    const res = window.oseFetch
      ? await window.oseFetch(path, opts)
      : await fetch(String(window.OSE_API_BASE || "").replace(/\/+$/, "") + path, opts);
    if (raw && res.ok) return res;
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch {
      throw new Error(`Máy chủ trả về phản hồi không hợp lệ (HTTP ${res.status})`);
    }
    if (res.status === 503 && data.mode === "degraded") showDegraded(true);
    if (res.status === 401 && state.token) { logout(); throw new Error("Phiên đăng nhập hết hạn, hãy đăng nhập lại"); }
    if (!res.ok) {
      const d = data.detail;
      const msg = typeof d === "string" ? d : Array.isArray(d)
        ? d.map((e) => `${(e.loc || []).slice(1).join(".")}: ${e.msg}`).join("; ")
        : JSON.stringify(d || "Lỗi máy chủ");
      throw new Error(msg);
    }
    return data;
  }

  async function backendLabel() {
    const base = String(await window.OSE_API_READY || window.OSE_API_BASE || "");
    return base.includes("onrender.com")
      ? "Đang chạy trên Render dự phòng (lần đầu có thể mất 30–60 giây)" : "Máy chủ chính";
  }

  function showDegraded(on) { $("#degraded").classList.toggle("hidden", !on); }

  async function download(path, filename) {
    try {
      const res = await apiCall(path, "GET", undefined, true);
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    } catch (e) { toast(e.message, true); }
  }

  // ============================================================ đăng nhập
  function loadSession() {
    try {
      const s = JSON.parse(sessionStorage.getItem("shm_session"));
      if (s && s.token) { state.token = s.token; state.user = s.user; }
    } catch {}
  }
  function saveSession() {
    try { sessionStorage.setItem("shm_session", JSON.stringify({ token: state.token, user: state.user })); } catch {}
  }
  function logout() {
    state.token = null; state.user = null;
    try { sessionStorage.removeItem("shm_session"); } catch {}
    clearInterval(state.timer);
    stopBerthing();
    if (typeof stopLive === "function") stopLive();
    if (state.publicView) startGuest(); else renderLogin();
  }

  // Khách xem: không đăng nhập, chỉ đọc (máy chủ bật PUBLIC_VIEW)
  async function startGuest() {
    state.token = null;
    state.user = { id: 0, email: "Khách", full_name: "Khách", role: "guest", can_approve: false };
    await startApp();
  }

  function renderLogin() {
    $("#tabs").classList.add("hidden");
    $("#logout").classList.add("hidden");
    $("#who").textContent = "";
    $("#view").innerHTML = `
      <form class="panel login" id="loginForm">
        <h2>Đăng nhập</h2>
        <p class="muted small">Dùng tài khoản do quản trị hệ thống cấp.</p>
        <label>Email<input name="email" type="email" autocomplete="username" required></label>
        <label>Mật khẩu<input name="password" type="password" autocomplete="current-password" required></label>
        <div class="actions"><button class="primary" type="submit">Đăng nhập</button>
          ${state.publicView ? `<button type="button" id="asGuest">Xem không cần đăng nhập</button>` : ""}</div>
      </form>`;
    const g = $("#asGuest");
    if (g) g.onclick = () => startGuest();
    $("#loginForm").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const f = new FormData(ev.target);
      const btn = ev.target.querySelector("button");
      btn.disabled = true;
      try {
        const r = await apiCall("/api/auth/login", "POST",
          { email: f.get("email"), password: f.get("password") });
        state.token = r.access_token; state.user = r.user; saveSession();
        await startApp();
      } catch (e) { toast(e.message, true); } finally { btn.disabled = false; }
    });
  }

  // ============================================================ khung tab
  const TABS = [
    ["dashboard", "Dashboard trực tuyến"], ["overview", "Tổng quan cảng"], ["wharf", "Công trình bến"], ["breakwater", "Đê chắn sóng"],
    ["sensors", "Cảm biến & thiết bị"], ["alerts", "Cảnh báo & khuyến cáo"],
    ["berthing", "Dự báo cập tàu (mô phỏng)"],
    ["surveys", "Khảo sát định kỳ"], ["rules", "Ngưỡng & quy tắc"],
    ["reports", "Báo cáo & hồ sơ"], ["admin", "Quản trị"],
  ];

  function renderTabs() {
    const nav = $("#tabs");
    nav.innerHTML = TABS.filter(([k]) => (k !== "admin" || can("admin")) && (!isGuest() || GUEST_TABS.includes(k))).map(([k, name]) =>
      `<button role="tab" type="button" data-tab="${k}" aria-selected="${state.tab === k}">${esc(name)}</button>`).join("");
    nav.classList.remove("hidden");
    nav.onclick = (ev) => {
      const b = ev.target.closest("button[data-tab]");
      if (!b) return;
      state.tab = b.dataset.tab;
      try { localStorage.setItem("shm_tab", state.tab); } catch {}
      renderTabs(); route();
    };
  }

  async function startApp() {
    $("#logout").classList.remove("hidden");
    $("#logout").textContent = isGuest() ? "Đăng nhập" : "Đăng xuất";
    $("#who").textContent = isGuest() ? "Khách xem · chỉ đọc" : `${state.user.email} · ${ROLE[state.user.role] || state.user.role}`;
    try { state.tab = localStorage.getItem("shm_tab") || "dashboard"; } catch {}
    if (isGuest() && !GUEST_TABS.includes(state.tab)) state.tab = "dashboard";
    try {
      state.catalog = await apiCall("/api/catalog");
      state.structures = await apiCall("/api/structures");
    } catch (e) { toast(e.message, true); }
    renderTabs();
    route();
    clearInterval(state.timer);
    state.timer = setInterval(() => {   // polling 60 giây cho các màn hình trạng thái
      if (["overview", "wharf", "breakwater", "alerts"].includes(state.tab) && !document.hidden) route(true);
    }, 60000);
  }

  async function route(silent = false) {
    if (state.tab !== "dashboard") stopLive();
    if (state.tab !== "berthing") stopBerthing();
    const v = $("#view");
    if (!silent) v.innerHTML = `<p class="muted">Đang tải…</p>`;
    try {
      const fn = { dashboard: viewDashboard, overview: viewOverview, wharf: () => viewGroup("wharf"),
                   breakwater: () => viewGroup("breakwater"), sensors: viewSensors,
                   alerts: viewAlerts, surveys: viewSurveys, rules: viewRules,
                   reports: viewReports, admin: viewAdmin, berthing: viewBerthingForecast }[state.tab] || viewOverview;
      await fn(v, silent);
    } catch (e) {
      if (!silent) v.innerHTML = `<div class="panel"><h3>Không tải được dữ liệu</h3><p>${esc(e.message)}</p>
        <button type="button" id="retry">Tải lại</button></div>`;
      const r = $("#retry"); if (r) r.onclick = () => route();
    }
  }

  // ============================================================ Live Berthing AI predictions
  // Simulation-only stream: NEVER mix into operational sensor alerts.
  let berthingTimer = null, berthingTick = null;
  document.addEventListener("visibilitychange", () => { if (!document.hidden && state.tab === "berthing" && berthingTick) berthingTick(true); });
  function stopBerthing() {
    if (berthingTimer) clearTimeout(berthingTimer);
    berthingTimer = null;
  }
  const BERTHING_LEVELS = { Normal: "Bình thường", Caution: "Chú ý", Warning: "Cảnh báo", Critical: "Nguy hiểm" };
  const BERTHING_COLORS = { Normal: "#15803d", Caution: "#a16207", Warning: "#c2410c", Critical: "#b91c1c" };
  const BERTHING_OUTCOME = { warned: "Đã cảnh báo trước khi chạm bến", missed: "KHÔNG cảnh báo kịp (phát hiện khi chạm bến)",
    false_alarm: "Cảnh báo thừa (chạm bến an toàn)", ok: "Chạm bến bình thường" };
  const bLevel = (l) => `<span style="font-weight:700;color:${BERTHING_COLORS[l] || "#334155"}">${esc(BERTHING_LEVELS[l] || l || "—")}</span>`;
  const pct = (x) => (x === undefined || x === null || x === "") ? "—" : fmtNum(Number(x) * 100, 1) + " %";
  function berthingChart(entries, contact) {
    const items = [...entries].sort((a,b) => Number(a.elapsed_s)-Number(b.elapsed_s));
    if (!items.length) return '<p class="muted">Chưa có dữ liệu dự báo gửi từ Berthing AI.</p>';
    const W=950,H=310,L=62,R=24,T=25,B=42;
    const end=Math.max(1,...items.map(e=>Number(e.elapsed_s)||0), contact ? Number(contact.elapsed_s)||0 : 0);
    const cdx = contact ? Math.abs(Number(contact.measured_dx_mm ?? contact.displacement_mm) || 0) : 0;
    const ymax=Math.max(1, cdx, ...items.flatMap(e=>[Number(e.displacement_p50_mm)||0,Number(e.displacement_p90_mm)||0,Number(e.displacement_limit_mm)||0]))*1.12;
    const x=t=>L+(W-L-R)*t/end;
    const y=v=>H-B-(H-T-B)*v/ymax;
    const path=k=>items.map((e,i)=>(i?'L':'M')+x(Number(e.elapsed_s)||0).toFixed(1)+','+y(Number(e[k])||0).toFixed(1)).join(' ');
    const ticks=[0,.25,.5,.75,1].map(t=>`<line x1="${L}" y1="${y(t*ymax)}" x2="${W-R}" y2="${y(t*ymax)}" stroke="#e2e8f0"/><text x="${L-10}" y="${y(t*ymax)+4}" text-anchor="end" font-size="12" fill="#475569">${fmtNum(t*ymax,1)}</text>`).join('');
    // background bands = alert level that was issued
    const bands = items.map((e,i)=>{ const x0=x(Number(e.elapsed_s)||0), x1=i+1<items.length?x(Number(items[i+1].elapsed_s)||0):x(end);
      const col={Caution:'#fef9c3',Warning:'#ffedd5',Critical:'#fee2e2'}[e.alert_level]; return col?`<rect x="${x0}" y="${T}" width="${Math.max(1,x1-x0)}" height="${H-T-B}" fill="${col}"/>`:''; }).join('');
    const mark = contact ? `<circle cx="${x(Number(contact.elapsed_s)||end)}" cy="${y(cdx)}" r="6" fill="${BERTHING_COLORS[contact.actual_level]||'#0f172a'}"/>
      <text x="${x(Number(contact.elapsed_s)||end)-8}" y="${y(cdx)-10}" text-anchor="end" font-size="12" fill="#0f172a">chạm bến: ${fmtNum(cdx,1)} mm</text>` : '';
    const last=items[items.length-1];
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Dự báo chuyển vị P50 và P90 theo thời gian mô phỏng" style="width:100%;height:auto;max-height:360px">
      ${bands}${ticks}<line x1="${L}" y1="${H-B}" x2="${W-R}" y2="${H-B}" stroke="#94a3b8"/>
      <path d="${path('displacement_limit_mm')}" stroke="#dc2626" stroke-width="2" stroke-dasharray="7 5" fill="none"/>
      <path d="${path('displacement_p90_mm')}" stroke="#d97706" stroke-width="2.5" fill="none"/>
      <path d="${path('displacement_p50_mm')}" stroke="#2563eb" stroke-width="2.5" fill="none"/>${mark}
      <text x="${L}" y="${H-8}" font-size="12" fill="#64748b">0 s</text><text x="${W-R}" y="${H-8}" text-anchor="end" font-size="12" fill="#64748b">${fmtNum(end,0)} s</text>
      <text x="${L}" y="15" font-size="13" fill="#475569">Chuyển vị (mm)</text>
      <text x="${W-R}" y="15" text-anchor="end" font-size="12" fill="#475569">Thời gian sự kiện (s) · nền màu = mức cảnh báo đã phát</text>
      <title>Gần nhất: P50 ${fmtNum(last.displacement_p50_mm,2)} mm; P90 ${fmtNum(last.displacement_p90_mm,2)} mm</title></svg>`;
  }
  function simAlertTable(rows, withAck) {
    if (!rows.length) return '<p class="muted small">Không có cảnh báo mô phỏng.</p>';
    return `<div class="table-wrap"><table><thead><tr><th>Cảnh báo</th><th>Mức đã phát</th><th>Mở lúc (t / khoảng cách)</th><th>Kết quả chạm bến</th><th>Trạng thái</th>${withAck ? "<th></th>" : ""}</tr></thead><tbody>${rows.map((a) =>
      `<tr><td><strong>${esc(a.title)}</strong><br><span class="small muted">${esc(a.message)}</span></td><td>${bLevel(a.level)}</td>
        <td class="num">${esc(a.first_elapsed_s ?? "—")} s · ${fmtNum(a.first_distance_m, 0)} m<br><span class="small muted">${esc(fmtTime(a.opened_at))}</span></td>
        <td>${a.actual_level ? bLevel(a.actual_level) + "<br><span class='small'>" + esc(BERTHING_OUTCOME[a.outcome] || a.outcome || "") + "</span>" : "<span class='muted small'>chưa chạm bến</span>"}</td>
        <td>${a.status === "open" ? '<span class="tag warn">Đang mở</span>' : '<span class="tag">Đã xem</span>'}</td>
        ${withAck ? `<td>${a.status === "open" && can("operator") ? `<button type="button" data-simack="${a.id}">Đã xem</button>` : ""}</td>` : ""}</tr>`).join("")}</tbody></table></div>`;
  }
  function bindSimAck(root, after) {
    root.querySelectorAll("[data-simack]").forEach((b) => b.onclick = async () => {
      b.disabled = true;
      try { await apiCall(`/api/berthing/alerts/${b.dataset.simack}/ack`, "POST"); toast("Đã xác nhận cảnh báo mô phỏng"); after(); }
      catch (e) { toast(e.message, true); b.disabled = false; }
    });
  }
  // Theo dõi trực tuyến: chỉ tải phần bản tin mới (after_id), 1 s/lần khi phiên đang nhận dữ liệu, 10 s/lần khi rảnh.
  async function viewBerthingForecast(v) {
    stopBerthing();
    v.innerHTML=`<div class="panel"><h2>Dự báo cập tàu từ Berthing AI</h2>
      <p><strong style="color:#9a3412">DỮ LIỆU MÔ PHỎNG – KHÔNG PHẢI QUAN TRẮC THỰC TẾ</strong></p>
      <p class="muted">Bản tin dự báo P10–P90 chỉ phục vụ thử nghiệm. Cảnh báo mô phỏng nằm trong bảng riêng, không kích hoạt cảnh báo vận hành, không thay thế số đo cảm biến thực.</p>
      <div class="actions"><label>Sự kiện <select id="btEvent" style="max-width:200px"><option value="">Tất cả</option></select></label>
      <label>Phiên <select id="btSession" style="max-width:420px"><option value="">Phiên mới nhất (tự động theo dõi)</option></select></label>
      <button id="btRefresh" type="button">Làm mới</button><span id="btStatus" class="muted" aria-live="polite">Đang tải…</span></div>
      <div id="btContent"></div></div>`;
    const root=v, evSel=root.querySelector('#btEvent'), sesSel=root.querySelector('#btSession');
    const st={sessions:[], sessionsAt:0, key:'', frames:new Map(), contact:null, lastId:0, alerts:[], alertsSig:'', dirty:true, lastRx:null};
    const fmtClock=(d)=>d?new Date(d).toLocaleTimeString('vi-VN'):'—';
    function fillSelects(){
      const events=[...new Set(st.sessions.map(x=>x.event_id))];
      const ev=evSel.value, ses=sesSel.value;
      evSel.innerHTML='<option value="">Tất cả</option>'+events.map(e=>`<option value="${esc(e)}">${esc(e)}</option>`).join('');
      evSel.value=events.includes(ev)?ev:'';
      const list=st.sessions.filter(x=>!evSel.value||x.event_id===evSel.value);
      sesSel.innerHTML='<option value="">Phiên mới nhất (tự động theo dõi)</option>'+list.map(x=>
        `<option value="${esc(x.session_id)}">${esc(x.event_id)} · ${esc(fmtClock(x.first_received_at))} · ${esc(BERTHING_LEVELS[x.sim_alert||x.alert_level]||x.alert_level||'')} · ${x.frames} bản tin${x.has_contact?' · đã chạm bến':''} · ${esc(x.session_id)}</option>`).join('');
      sesSel.value=list.some(x=>x.session_id===ses)?ses:'';
    }
    function target(){
      if(sesSel.value) return st.sessions.find(x=>x.session_id===sesSel.value)||{session_id:sesSel.value};
      return st.sessions.find(x=>!evSel.value||x.event_id===evSel.value)||null;
    }
    function render(){
      const box=root.querySelector('#btContent'); if(!box) return;
      const frames=[...st.frames.values()].sort((a,b)=>b.elapsed_s-a.elapsed_s), contact=st.contact, alerts=st.alerts;
      if(!frames.length&&!contact){box.innerHTML='<p class="muted">Chưa nhận bản tin dự báo. Kiểm tra Berthing AI relay và backend ingest.</p>';return;}
      const f=frames[0]||{}, ref=f.session_id?f:contact;
      const card=(label,value,sub='')=>`<div class="panel" style="min-width:170px"><div class="small muted">${label}</div><strong style="font-size:1.15rem">${value}</strong>${sub?`<div class="small muted">${sub}</div>`:''}</div>`;
      const contactBox=contact?`<div class="panel" style="border-left:5px solid ${BERTHING_COLORS[contact.actual_level]||'#334155'}"><h3>Kết quả khi chạm bến (giá trị "đo" mô phỏng)</h3>
        <div class="actions">${card('Mức thực tế',bLevel(contact.actual_level),'mức đã cảnh báo trước: '+esc(BERTHING_LEVELS[contact.alert_level_issued]||contact.alert_level_issued||'—'))}
        ${card('Vận tốc / góc cập',`${fmtNum(contact.contact_velocity_cms,1)} cm/s · ${fmtNum(contact.contact_angle_deg,1)}°`)}
        ${card('Năng lượng va',`${fmtNum(contact.energy_kj,0)} kJ`,`${pct(contact.energy_ratio)} năng lượng định mức đệm`)}
        ${card('Phản lực đệm',`${fmtNum(contact.measured_reaction_kn ?? contact.reaction_kn,0)} kN`,`tính toán ${fmtNum(contact.reaction_kn,0)} kN`)}
        ${card('Chuyển vị bến (đo)',`${fmtNum(contact.measured_dx_mm ?? contact.displacement_mm,2)} mm`,`giới hạn ${fmtNum(contact.displacement_limit_mm,0)} mm`)}</div>
        ${alerts[0]?.outcome?`<p><strong>Đánh giá cảnh báo:</strong> ${esc(BERTHING_OUTCOME[alerts[0].outcome]||alerts[0].outcome)}</p>`:''}
        <p class="small muted">${esc(contact.vessel||'')} ${contact.scenario?'· kịch bản '+esc(contact.scenario):''}</p></div>`:'<p class="muted small">Chưa có kết quả chạm bến cho phiên này.</p>';
      box.innerHTML=`<div class="actions"><strong>Sự kiện: ${esc(ref.event_id)}</strong><span>Phiên: ${esc(ref.session_id)}</span>
          <span>Mức đã phát: ${bLevel(f.alert_level||contact?.alert_level_issued)} (mô phỏng)</span>${f.sensors?`<span class="muted small">${esc(f.sensors)}</span>`:''}</div>
        <div class="actions">${card('Khoảng cách tàu – bến',`${fmtNum(f.distance_m,1)} m`,`t = ${esc(f.elapsed_s ?? '—')} s`)}
          ${card('Chuyển vị bến P50 / P90',`${fmtNum(f.displacement_p50_mm,2)} / ${fmtNum(f.displacement_p90_mm,2)} mm`,`giới hạn ${fmtNum(f.displacement_limit_mm,0)} mm`)}
          ${card('P(chuyển vị ≥ giới hạn)',pct(f.probability_exceedance))}
          ${card('Năng lượng va P90',f.energy_p90_kj!==undefined?`${fmtNum(f.energy_p90_kj,0)} kJ`:'—',f.energy_ratio_p90!==undefined?`${pct(f.energy_ratio_p90)} Er · P(E ≥ Er) ${pct(f.prob_energy_critical)}`:'')}
          ${card('Phản lực đệm P90',f.reaction_p90_kn!==undefined?`${fmtNum(f.reaction_p90_kn,0)} kN`:'—')}
          ${card('Vận tốc cập P50 / P90',f.velocity_p50_cms!==undefined?`${fmtNum(f.velocity_p50_cms,1)} / ${fmtNum(f.velocity_p90_cms,1)} cm/s`:'—')}</div>
        ${contactBox}
        <div class="panel"><h3>Cảnh báo mô phỏng của phiên</h3>${simAlertTable(alerts,true)}</div>
        <div class="panel"><h3>Đồ thị dự báo chuyển vị P50/P90</h3>
          <p class="small" style="color:#2563eb">━━ P50 (mm)　<span style="color:#d97706">━━ P90 (mm)</span>　<span style="color:#dc2626">┄┄ Giới hạn</span>　● chuyển vị đo khi chạm bến</p>
          ${berthingChart(frames,contact)}
          <p class="small muted">Lưu ý: với đệm loại buckling, phản lực đạt gần định mức từ sớm nên chuyển vị dự báo thay đổi ít; năng lượng va và P(E ≥ Er) là chỉ báo nhạy hơn.</p></div>
        <div class="table-wrap"><table><thead><tr><th>t (s)</th><th>Khoảng cách (m)</th><th>P50 / P90 (mm)</th><th>P(δ ≥ giới hạn)</th><th>E P90 (kJ)</th><th>P(E ≥ Er)</th><th>Mức đã phát</th><th>Nhận lúc</th></tr></thead>
        <tbody>${frames.slice(0,60).map(e=>`<tr><td class="num">${esc(e.elapsed_s)}</td><td class="num">${fmtNum(e.distance_m,1)}</td><td class="num">${fmtNum(e.displacement_p50_mm,2)} / ${fmtNum(e.displacement_p90_mm,2)}</td><td class="num">${pct(e.probability_exceedance)}</td><td class="num">${e.energy_p90_kj!==undefined?fmtNum(e.energy_p90_kj,0):'—'}</td><td class="num">${pct(e.prob_energy_critical)}</td><td>${bLevel(e.alert_level)}</td><td class="small">${esc(fmtClock(e.received_at))}</td></tr>`).join('')}</tbody></table></div>`;
      bindSimAck(box, ()=>{st.alertsSig='';tick(true);});
    }
    let running=false;
    async function tick(force=false){
      if(state.tab!=="berthing"||!root.isConnected) return;
      stopBerthing();
      if(running){berthingTimer=setTimeout(tick,500);return;}
      running=true;
      let delay=10000;
      try{
        if(document.hidden&&!force) return;
        const now=Date.now();
        if(force||!st.sessions.length||now-st.sessionsAt>4000||(st.lastRx&&now-st.lastRx<30000&&now-st.sessionsAt>2000)){
          st.sessions=await apiCall('/api/berthing/sessions?limit=30'); st.sessionsAt=now; fillSelects();
        }
        const t=target();
        if(!t){render();root.querySelector('#btStatus').textContent=`Chưa có phiên nào · kiểm tra lúc ${fmtClock(now)}`;return;}
        if(t.session_id!==st.key){st.key=t.session_id;st.frames=new Map();st.contact=null;st.lastId=0;st.alerts=[];st.alertsSig='';st.dirty=true;}
        const q=new URLSearchParams({session_id:st.key,limit:'1000'}); if(st.lastId) q.set('after_id',String(st.lastId));
        const [rows,alerts]=await Promise.all([apiCall('/api/berthing/forecasts?'+q),
          apiCall('/api/berthing/alerts?status=all&session_id='+encodeURIComponent(st.key))]);
        if(state.tab!=="berthing"||!root.isConnected) return;
        for(const r of rows){
          st.lastId=Math.max(st.lastId,Number(r.id)||0);
          if(r.frame_type==='contact') st.contact=r; else st.frames.set(Number(r.elapsed_s),r);
          const rx=Date.parse(r.received_at); if(!st.lastRx||rx>st.lastRx) st.lastRx=rx;
        }
        const sig=JSON.stringify(alerts.map(a=>[a.id,a.level,a.status,a.outcome,a.updated_at]));
        if(rows.length||sig!==st.alertsSig||st.dirty){st.alerts=alerts;st.alertsSig=sig;st.dirty=false;render();}
        const live=st.lastRx&&Date.now()-st.lastRx<30000;
        delay=live?1000:10000;
        const ago=st.lastRx?Math.max(0,(Date.now()-st.lastRx)/1000):null;
        root.querySelector('#btStatus').textContent=`${st.frames.size+(st.contact?1:0)} bản tin · bản tin mới nhất nhận lúc ${fmtClock(st.lastRx)}${ago!==null?` (cách đây ${ago<10?ago.toFixed(1):Math.round(ago)} s)`:''} · ${live?'đang theo dõi trực tuyến (1 s)':'chờ phiên mới (10 s)'}`;
      }catch(e){ const status=root.querySelector('#btStatus');if(status)status.textContent='Lỗi đọc dự báo: '+e.message; delay=5000; }
      finally{ running=false; if(state.tab==="berthing"&&root.isConnected) berthingTimer=setTimeout(tick,delay); }
    }
    berthingTick=tick;
    root.querySelector('#btRefresh').onclick=()=>tick(true);
    evSel.addEventListener('change',()=>{fillSelects();st.key='';tick(true);});
    sesSel.addEventListener('change',()=>{st.key='';tick(true);});
    await tick(true);
  }

  // ============================================================ hình mặt cắt kết cấu
  function sectionArt(type, level) {
    const shapes = {
      bw_caisson: `<polygon class="seabed" points="0,64 112,64 112,52 0,52"/>
        <polygon class="body" points="30,52 82,52 74,43 38,43"/>
        <rect class="body" x="42" y="13" width="28" height="30"/>`,
      bw_rubble: `<polygon class="seabed" points="0,64 112,64 112,52 0,52"/>
        <polygon class="body" points="16,52 96,52 66,14 46,14"/>`,
      wharf_piled: `<polygon class="seabed" points="0,64 112,64 112,22 92,22 60,58 0,58"/>
        <rect class="body" x="24" y="16" width="72" height="6"/>
        <path class="body" d="M34 22v34M50 22v34M66 22v30M82 22v18" fill="none"/>`,
      wharf_sheetpile: `<polygon class="seabed" points="0,64 112,64 112,18 58,18 58,56 0,56"/>
        <rect class="body" x="54" y="12" width="5" height="50"/>
        <path class="body" d="M59 24L96 30" fill="none"/><rect class="body" x="94" y="26" width="6" height="12"/>`,
      wharf_caisson: `<polygon class="seabed" points="0,64 112,64 112,16 78,16 78,54 0,54"/>
        <polygon class="body" points="44,54 84,54 80,50 48,50"/>
        <rect class="body" x="50" y="14" width="28" height="36"/>`,
    };
    return `<svg class="section-art lv-${level || 0}" viewBox="0 0 112 64" aria-hidden="true">
      <rect class="water" x="0" y="20" width="112" height="44"/>${shapes[type] || ""}</svg>`;
  }

  const typeName = (t) => state.catalog?.structure_types?.[t]?.name || t;

  // ============================================================ biểu đồ SVG
  function niceTicks(lo, hi, n) {
    const span = hi - lo, raw = span / Math.max(1, n - 1);
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((k) => k >= raw) || 10 * mag;
    const out = [];
    for (let v = Math.floor(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Number(v.toFixed(10)));
    if (out[out.length - 1] < hi) out.push(out[out.length - 1] + step);
    return out;
  }
  function dateInput(offsetDays) {
    const d = new Date(Date.now() + offsetDays * 86400000);
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(d).map((x) => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day}`;
  }
  function localDayIso(day, endOfDay = false) {
    return new Date(`${day}T${endOfDay ? "23:59:59" : "00:00:00"}+07:00`).toISOString();
  }
  function shortTime(t) {
    const p = Object.fromEntries(new Intl.DateTimeFormat("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", day: "2-digit",
      month: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    return `${p.day}/${p.month} ${p.hour}:${p.minute}`;
  }
  function lineChart(el, data) {
    const W = Math.max(320, el.clientWidth || 640), H = 280, m = { l: 56, r: 12, t: 12, b: 32 };
    const pts = (data.points || []).filter((p) => p.value !== null && p.value !== undefined);
    if (!pts.length) {
      el.innerHTML = `<svg class="chart" viewBox="0 0 ${W} ${H}"><text class="empty" x="${W / 2}" y="${H / 2}" text-anchor="middle">Chưa có số liệu trong khoảng thời gian này</text></svg>`;
      return;
    }
    const xs = pts.map((p) => Date.parse(p.ts));
    const fc = (data.forecast || []).filter((f) => f.mean !== null && f.mean !== undefined);
    const fxs = fc.map((f) => Date.parse(f.ts));
    const vals = pts.flatMap((p) => [p.value, p.min ?? p.value, p.max ?? p.value])
      .concat(fc.flatMap((f) => [f.lo, f.hi]));
    const ths = [];
    (data.thresholds || []).forEach((t) => {
      if (t.kind !== "absolute") return;
      [["watch", 1], ["warning", 2], ["action", 3]].forEach(([k, l]) => {
        if (t[k] !== null && t[k] !== undefined) {
          ths.push({ v: t[k], l });
          if (t.direction === "abs") ths.push({ v: -t[k], l });
        }
      });
    });
    let lo = Math.min(...vals), hi = Math.max(...vals);
    // Hiện ngưỡng nằm trong dải số liệu + ngưỡng gần nhất phía dưới và phía trên (mức đang vượt / mức kế tiếp)
    const thVals = [...new Set(ths.map((t) => t.v))].sort((a, b) => a - b);
    const below = thVals.filter((v) => v < lo).pop();
    const above = thVals.find((v) => v > hi);
    if (below !== undefined) lo = below;
    if (above !== undefined) hi = above;
    if (hi === lo) { hi += 1; lo -= 1; }
    const ticks = niceTicks(lo, hi, 5);
    lo = Math.min(lo, ticks[0]); hi = Math.max(hi, ticks[ticks.length - 1]);
    const allX = xs.concat(fxs);
    const x0 = Math.min(...allX), x1 = Math.max(...allX) === x0 ? x0 + 1 : Math.max(...allX);
    const X = (t) => m.l + (t - x0) / (x1 - x0) * (W - m.l - m.r);
    const Y = (v) => m.t + (hi - v) / (hi - lo) * (H - m.t - m.b);
    let g = "";
    ticks.forEach((v) => {
      g += `<line class="grid-line" x1="${m.l}" x2="${W - m.r}" y1="${Y(v)}" y2="${Y(v)}"/>
        <text x="${m.l - 6}" y="${Y(v) + 4}" text-anchor="end">${esc(fmtNum(v, 4))}</text>`;
    });
    for (let i = 0; i <= 4; i++) {
      const t = x0 + (x1 - x0) * i / 4;
      const anchor = i === 0 ? "start" : i === 4 ? "end" : "middle";
      g += `<text x="${X(t)}" y="${H - 10}" text-anchor="${anchor}">${esc(shortTime(t))}</text>`;
    }
    let band = "";
    if (pts[0].min !== undefined) {
      const up = pts.map((p, i) => `${X(xs[i])},${Y(p.max)}`).join(" ");
      const dn = pts.map((p, i) => `${X(xs[i])},${Y(p.min)}`).reverse().join(" ");
      band = `<polygon class="band" points="${up} ${dn}"/>`;
    }
    const line = `<polyline class="series" points="${pts.map((p, i) => `${X(xs[i])},${Y(p.value)}`).join(" ")}"/>`;
    const thl = ths.filter((t) => t.v >= lo && t.v <= hi).map((t) =>
      `<line class="th th-${t.l}" x1="${m.l}" x2="${W - m.r}" y1="${Y(t.v)}" y2="${Y(t.v)}"><title>${LEVEL[t.l]}: ${t.v}</title></line>`).join("");
    const qc = pts.map((p, i) => p.qc > 0 ? `<circle class="qc-${p.qc}" cx="${X(xs[i])}" cy="${Y(p.value)}" r="3"><title>${p.qc === 1 ? "Nghi ngờ" : "Hỏng"}</title></circle>` : "").join("");
    let fcast = "";
    if (fc.length) {
      const up = fc.map((f, i) => `${X(fxs[i])},${Y(f.hi)}`).join(" ");
      const dn = fc.map((f, i) => `${X(fxs[i])},${Y(f.lo)}`).reverse().join(" ");
      fcast = `<polygon class="fband" points="${up} ${dn}"/><polyline class="fline" points="${fc.map((f, i) => `${X(fxs[i])},${Y(f.mean)}`).join(" ")}"/>
        <line class="now" x1="${X(fxs[0])}" x2="${X(fxs[0])}" y1="${m.t}" y2="${H - m.b}"/>`;
    }
    el.innerHTML = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Diễn biến ${esc(data.sensor)}/${esc(data.channel)}">
      <g class="axis">${g}</g>${band}${fcast}${thl}${line}${qc}</svg>`;
  }

  // ============================================================ DASHBOARD TRỰC TUYẾN
  const live = { timer: null, sparkTimer: null, since: null, channels: new Map(), spark: {}, filter: "", alerts: [] };

  function stopLive() {
    clearInterval(live.timer); clearInterval(live.sparkTimer);
    live.timer = live.sparkTimer = null;
  }

  function sparkSvg(series, levelCls) {
    if (!series || series.length < 2) return `<svg class="spark" viewBox="0 0 120 28" aria-hidden="true"></svg>`;
    const vs = series.map((p) => p[1]);
    let lo = Math.min(...vs), hi = Math.max(...vs);
    if (hi === lo) { hi += 1; lo -= 1; }
    const pts = vs.map((v, i) => `${(i / (vs.length - 1) * 118 + 1).toFixed(1)},${(26 - (v - lo) / (hi - lo) * 24).toFixed(1)}`).join(" ");
    return `<svg class="spark ${levelCls}" viewBox="0 0 120 28" aria-hidden="true"><polyline points="${pts}"/></svg>`;
  }

  function ago(iso) {
    if (!iso) return "chưa có số liệu";
    const s = (Date.now() - Date.parse(iso)) / 1000;
    if (s < 90) return "vừa xong";
    if (s < 3600) return `${Math.round(s / 60)} phút trước`;
    if (s < 86400 * 2) return `${Math.round(s / 3600)} giờ trước`;
    return `${Math.round(s / 86400)} ngày trước`;
  }

  function tileHtml(c) {
    const lvl = c.has_threshold ? c.level : -1;
    const evt = !c.interval_s;   // cảm biến theo sự kiện (cập tàu, va đệm…): không có nhịp gửi cố định
    const cls = c.stale ? "tile stale" : `tile tl-${lvl}${evt ? " evt" : ""}`;
    return `<button type="button" class="${cls}" data-tile="${c.channel_id}" title="${esc(c.sensor)}/${esc(c.channel)} — ${c.has_threshold ? LEVEL[c.level] : "không có ngưỡng"}">
      <span class="tile-head"><span>${esc(c.sensor)}</span><span>${esc(c.channel)}</span></span>
      <span class="tile-val num">${esc(fmtNum(c.value, c.value === null ? 0 : Math.abs(c.value) >= 100 ? 1 : Math.abs(c.value) >= 10 ? 2 : 3))}<small> ${esc(unitLabel(c.unit))}</small></span>
      ${sparkSvg(live.spark[c.channel_id], c.has_threshold ? `sl-${c.level}` : "")}
      <span class="tile-foot">${c.stale ? "Mất tín hiệu · " : evt ? "Theo sự kiện · lần cuối " : ""}${esc(ago(c.ts))}${c.qc ? " · số liệu nghi ngờ" : ""}</span>
    </button>`;
  }

  function renderLiveGrid() {
    const box = $("#liveGrid");
    if (!box) return;
    const groups = new Map();
    for (const c of live.channels.values()) {
      if (live.filter && String(c.structure_id) !== live.filter) continue;
      if (!groups.has(c.structure_id)) groups.set(c.structure_id, { name: c.structure, type: c.structure_type, items: [] });
      groups.get(c.structure_id).items.push(c);
    }
    box.innerHTML = [...groups.values()].map((g) => {
      const lvl = Math.max(0, ...g.items.filter((c) => c.has_threshold).map((c) => c.level));
      return `<section class="live-group"><h3>${sectionArt(g.type, lvl).replace('class="section-art', 'class="section-art mini')} ${esc(g.name)} ${lv(lvl)}</h3>
        <div class="tiles">${g.items.map(tileHtml).join("")}</div></section>`;
    }).join("") || `<p class="muted">Chưa có cảm biến nào gửi số liệu.</p>`;
    const all = [...live.channels.values()].filter((c) => !live.filter || String(c.structure_id) === live.filter);
    const n = (f) => all.filter(f).length;
    $("#liveCounts").innerHTML = `<span><b class="num">${all.length}</b> kênh</span>
      <span class="lv lv-3"><b class="num">${n((c) => c.has_threshold && c.level === 3)}</b>&nbsp;Hành động</span>
      <span class="lv lv-2"><b class="num">${n((c) => c.has_threshold && c.level === 2)}</b>&nbsp;Cảnh báo</span>
      <span class="lv lv-1"><b class="num">${n((c) => c.has_threshold && c.level === 1)}</b>&nbsp;Chú ý</span>
      <span><b class="num">${n((c) => c.stale)}</b> mất tín hiệu</span>`;
    box.querySelectorAll("[data-tile]").forEach((b) => b.onclick = () => {
      const c = live.channels.get(Number(b.dataset.tile));
      if (!c) return;
      state.tab = c.group;
      state.sub[c.group] = { type: c.structure_type, id: c.structure_id, channel: c.channel_id };
      renderTabs(); route();
    });
  }

  function renderTicker(alertsCount) {
    const t = $("#liveAlerts");
    if (!t) return;
    $("#liveAlertCount").textContent = alertsCount;
    t.innerHTML = live.alerts.slice(0, 15).map((a) => `<li>${lv(a.current_level)} <span>${esc(a.title)}</span>
      <span class="muted small">${esc(ago(a.updated_at))}</span></li>`).join("") || `<li class="muted">Không có cảnh báo đang mở.</li>`;
  }

  async function pollLive(full = false) {
    try {
      const q = new URLSearchParams();
      if (!full && live.since) q.set("since", live.since);
      const r = await apiCall(`/api/live?${q}`);
      if (r.full) live.channels.clear();
      const changed = [];
      r.channels.forEach((c) => {
        const old = live.channels.get(c.channel_id);
        if (old && old.ts !== c.ts) changed.push(c.channel_id);
        live.channels.set(c.channel_id, c);
      });
      if (r.full) live.alerts = r.alerts;
      else if (r.alerts.length) {
        const ids = new Set(r.alerts.map((a) => a.id));
        live.alerts = r.alerts.concat(live.alerts.filter((a) => !ids.has(a.id)));
      }
      // cập nhật cờ mất tín hiệu theo thời gian thực
      for (const c of live.channels.values()) {
        if (c.interval_s && c.ts) c.stale = (Date.now() - Date.parse(c.ts)) / 1000 > 2 * c.interval_s;
      }
      live.since = r.server_time;
      renderLiveGrid();
      renderTicker(r.active_alerts);
      changed.forEach((id) => { const el = document.querySelector(`[data-tile="${id}"]`); if (el) el.classList.add("fresh"); });
      $("#liveClock").textContent = `Cập nhật ${new Date().toLocaleTimeString("vi-VN", { hour12: false })}`;
      $("#liveDot").classList.remove("off");
    } catch (e) {
      const dot = $("#liveDot"); if (dot) dot.classList.add("off");
      const clk = $("#liveClock"); if (clk) clk.textContent = "Mất kết nối, đang thử lại…";
    }
  }

  async function loadSpark() {
    try { live.spark = (await apiCall("/api/live/spark?hours=24")).series; renderLiveGrid(); } catch {}
  }

  async function viewDashboard(v) {
    stopLive();
    v.innerHTML = `
      <div class="live-bar">
        <span class="live-status"><span id="liveDot" class="dot"></span><span id="liveClock" class="small">Đang kết nối…</span></span>
        <span id="liveCounts" class="live-counts"></span>
        <span class="spacer"></span>
        <select id="liveFilter" aria-label="Lọc công trình" style="width:auto"><option value="">Tất cả công trình</option>
          ${state.structures.map((x) => `<option value="${x.id}" ${String(x.id) === live.filter ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select>
        <button type="button" id="liveFull">Toàn màn hình</button>
      </div>
      <div class="live-layout">
        <div id="liveGrid"></div>
        <aside class="panel live-side"><h3>Cảnh báo đang mở <span id="liveAlertCount" class="tag"></span></h3><ul id="liveAlerts" class="ticker"></ul></aside>
      </div>
      <p class="small muted">Ô màu theo mức ngưỡng hiện tại của kênh (xám nhạt = kênh không có ngưỡng; viền đứt = mất tín hiệu; viền chấm, nền sọc = cảm biến theo sự kiện, chỉ có số liệu khi xảy ra sự kiện như tàu cập bến). Đường nhỏ: trung bình giờ 24 giờ qua. Tự cập nhật ${isGuest() ? 30 : 10} giây/lần; bấm một ô để xem biểu đồ.</p>`;
    $("#liveFilter").onchange = (e) => { live.filter = e.target.value; renderLiveGrid(); };
    $("#liveFull").onclick = () => {
      const el = document.documentElement;
      if (document.fullscreenElement) document.exitFullscreen(); else if (el.requestFullscreen) el.requestFullscreen();
    };
    live.since = null;
    await Promise.all([pollLive(true), loadSpark()]);
    let tick = 0;   // 10 giây/lần lấy phần thay đổi; mỗi phút lấy lại toàn bộ (mức ngưỡng, số liệu gửi bù)
    // khách: 30 giây/lần (tiết kiệm lượt gọi qua Worker dùng chung), người đăng nhập: 10 giây/lần
    const every = isGuest() ? 30000 : 10000, fullEvery = isGuest() ? 2 : 6;
    live.timer = setInterval(() => { if (!document.hidden && state.tab === "dashboard") pollLive(++tick % fullEvery === 0); }, every);
    live.sparkTimer = setInterval(() => { if (!document.hidden && state.tab === "dashboard") loadSpark(); }, 300000);
  }

  // ============================================================ TỔNG QUAN
  async function viewOverview(v) {
    const o = await apiCall("/api/overview");
    const env = o.environment.map((e) => `<dt>${esc(e.sensor)} ${esc(e.channel)}</dt>
      <dd class="num">${esc(fmtNum(e.value, 2))} ${esc(unitLabel(e.unit))} <span class="muted small">${esc(fmtTime(e.ts))}</span></dd>`).join("");
    const groupBlock = (g, title) => {
      const items = o.groups[g] || [];
      if (!items.length) return `<div class="panel"><h3>${title}</h3><p class="muted">Chưa khai báo công trình. Kỹ sư thêm công trình ở tab “Cảm biến & thiết bị”.</p></div>`;
      return `<h3>${title}</h3><div class="grid cols">${items.map((s) => `
        <div class="panel structure-card" data-go="${esc(g)}" data-id="${s.structure_id}" tabindex="0" role="button" aria-label="Mở ${esc(s.name)}">
          ${sectionArt(s.structure_type, s.level)}
          <div><strong>${esc(s.name)}</strong><br><span class="muted small">${esc(s.type_name || "")}</span><br>
          ${lv(s.level)} <span class="small muted">${s.open_alerts} cảnh báo mở</span><br>
          <span class="small">Cấp <span class="grade ${s.confirmed_grade ? "" : "suggested"}">${esc(s.confirmed_grade || s.suggested_grade)}</span>
          · cảm biến ${s.sensors_online}/${s.sensors_total} online</span></div>
        </div>`).join("")}</div>`;
    };
    v.innerHTML = `
      <div class="grid two">
        <div>
          <div class="panel"><h3>Điều kiện hiện tại</h3>${env ? `<dl class="kv">${env}</dl>` : `<p class="muted small">Chưa có trạm sóng/gió/mực nước.</p>`}</div>
          <div class="panel"><h3>Cảm biến</h3><dl class="kv">
            <dt>Tổng</dt><dd class="num">${o.sensors.total}</dd>
            <dt>Online</dt><dd class="num">${o.sensors.online}</dd>
            <dt>Mất tín hiệu</dt><dd class="num">${o.sensors.offline}</dd></dl></div>
          <div class="panel"><h3>Cảnh báo đang mở</h3>${o.active_alerts.length ? `<ul class="small" style="padding-left:1rem">${o.active_alerts.map((a) =>
            `<li>${lv(a.current_level)} ${esc(a.title)}</li>`).join("")}</ul>` : `<p class="muted small">Không có cảnh báo đang mở.</p>`}</div>
        </div>
        <div>${groupBlock("wharf", "Công trình bến")}${groupBlock("breakwater", "Đê chắn sóng")}</div>
      </div>
      <p class="disclaimer">${esc(o.disclaimer)} Cập nhật ${esc(fmtTime(o.generated_at))}.</p>`;
    v.querySelectorAll(".structure-card").forEach((c) => {
      const go = () => {
        const s = state.structures.find((x) => x.id === Number(c.dataset.id));
        state.tab = c.dataset.go;
        state.sub[c.dataset.go] = { type: s?.structure_type, id: Number(c.dataset.id) };
        renderTabs(); route();
      };
      c.onclick = go;
      c.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } };
    });
  }

  // ============================================================ BẾN / ĐÊ
  async function viewGroup(group, el, silent) {
    const v = el || $("#view");
    state.structures = await apiCall("/api/structures");
    const types = Object.entries(state.catalog.structure_types).filter(([, t]) => t.group === group);
    const sub = state.sub[group] || (state.sub[group] = { type: types[0][0] });
    const list = state.structures.filter((s) => s.structure_type === sub.type);
    if (!list.find((s) => s.id === sub.id)) sub.id = list[0]?.id;
    if (silent && sub.channel) return;   // không vẽ lại khi đang xem biểu đồ
    v.innerHTML = `
      <div class="subtabs" role="group" aria-label="Loại kết cấu">${types.map(([k, t]) =>
        `<button type="button" data-type="${k}" aria-pressed="${k === sub.type}">${esc(t.name)}</button>`).join("")}</div>
      <div class="grid two">
        <div class="panel"><h3>Công trình</h3>${list.length ? `<table><tbody>${list.map((s) =>
          `<tr class="clickable ${s.id === sub.id ? "selected" : ""}" data-id="${s.id}"><td>${esc(s.name)}<br><span class="muted small">${esc(s.code)}</span></td></tr>`).join("")}</tbody></table>`
          : `<p class="muted small">Chưa có công trình loại này.</p>`}</div>
        <div id="structureDetail"></div>
      </div>`;
    v.querySelectorAll("[data-type]").forEach((b) => b.onclick = () => {
      sub.type = b.dataset.type; sub.id = null; sub.channel = null; viewGroup(group);
    });
    v.querySelectorAll("tr[data-id]").forEach((r) => r.onclick = () => {
      sub.id = Number(r.dataset.id); sub.channel = null; viewGroup(group);
    });
    if (sub.id) await structureDetail($("#structureDetail"), sub.id, sub, group);
  }

  async function structureDetail(el, id, sub, group) {
    const [st, sensors, alerts, recs] = await Promise.all([
      apiCall(`/api/structures/${id}/status`), apiCall(`/api/sensors?structure_id=${id}`),
      apiCall(`/api/alerts?status=active&structure_id=${id}`),
      apiCall(`/api/recommendations?structure_id=${id}&status=proposed`)]);
    const nodeName = Object.fromEntries(st.nodes.map((n) => [n.id, n.name]));
    el.innerHTML = `
      <div class="panel">
        <div class="structure-card" style="cursor:default">${sectionArt(st.structure_type, st.level)}
          <div><h2>${esc(st.name)}</h2>
          <div>${lv(st.level)} · ${st.open_alerts} cảnh báo mở (${st.unacknowledged} chưa xem) ·
          cảm biến ${st.sensors_online}/${st.sensors_total} online</div>
          <div class="small">Cấp công trình (TCVN 13330): gợi ý <span class="grade suggested">${esc(st.suggested_grade)}</span>
          ${st.confirmed_grade ? ` · đã xác nhận <span class="grade">${esc(st.confirmed_grade)}</span>` : " · chưa xác nhận"}</div></div>
        </div>
        ${st.chains.map((c) => `<p class="chain">${esc(c)}</p>`).join("")}
        <p class="muted small">${esc(st.grade_note)}</p>
      </div>
      <div class="panel"><h3>Đơn vị kết cấu</h3><div class="table-wrap"><table>
        <thead><tr><th>Đơn vị</th><th>Mức</th><th>Cấp gợi ý</th><th>Cấp xác nhận</th>${canApprove() ? "<th></th>" : ""}</tr></thead>
        <tbody>${st.nodes.map((n) => `<tr><td>${esc(n.name)} <span class="muted small">${esc(n.code)}</span></td>
          <td>${lv(n.level)}</td><td><span class="grade suggested">${esc(n.suggested_grade)}</span></td>
          <td>${n.confirmed_grade ? `<span class="grade">${esc(n.confirmed_grade)}</span> <span class="muted small">${esc(fmtDate(n.confirmed_at))}</span>` : "–"}</td>
          ${canApprove() ? `<td><button type="button" data-grade="${n.id}" data-sug="${esc(n.suggested_grade)}">Xác nhận cấp</button></td>` : ""}</tr>`).join("")}
        </tbody></table></div>
        ${canApprove() ? `<div class="actions"><button type="button" data-grade="${st.structure_id}" data-sug="${esc(st.suggested_grade)}" data-structure="1">Xác nhận cấp công trình</button></div>` : ""}
      </div>
      <div class="panel"><h3>Cảnh báo đang mở</h3>${alertTable(alerts)}</div>
      ${recs.length ? `<div class="panel"><h3>Khuyến cáo chờ xác nhận</h3>${recTable(recs)}</div>` : ""}
      <div class="panel"><h3>Cảm biến</h3><div class="table-wrap"><table>
        <thead><tr><th>Cảm biến</th><th>Vị trí</th><th>Kênh – giá trị mới nhất</th><th>Nhận lúc</th></tr></thead>
        <tbody>${sensors.map((s) => `<tr><td>${esc(s.code)}<br><span class="muted small">${esc(state.catalog.sensor_types[s.sensor_type]?.name || s.sensor_type)}</span></td>
          <td class="small">${esc(nodeName[s.node_id] || "")} ${esc(s.location)}</td>
          <td>${s.channels.map((c) => `<button type="button" class="small" data-ch="${c.id}">${esc(c.name)}: <span class="num">${esc(fmtNum(c.last_value))}</span> ${esc(unitLabel(c.unit))}${c.last_qc ? " ⚠" : ""}</button>`).join(" ")}</td>
          <td class="small">${esc(fmtTime(s.last_seen_at))}${s.sensor_type === "accelerometer" ? `<br><button type="button" class="small" data-spec="${s.id}">Phổ tần số</button>` : ""}</td></tr>`).join("") || `<tr><td colspan="4" class="muted">Chưa gắn cảm biến.</td></tr>`}</tbody></table></div></div>
      <div class="panel ${sub.channel ? "" : "hidden"}" id="chartPanel"></div>
      <div class="panel hidden" id="specPanel"></div>`;
    bindAlertActions(el, () => viewGroup(group));
    el.querySelectorAll("[data-ch]").forEach((b) => b.onclick = () => {
      sub.channel = Number(b.dataset.ch); showChannel($("#chartPanel"), sub.channel, sub);
    });
    el.querySelectorAll("[data-grade]").forEach((b) => b.onclick = () => gradeDialog(b, () => viewGroup(group)));
    el.querySelectorAll("[data-spec]").forEach((b) => b.onclick = () => { sub.waveform = null; showSpectrum($("#specPanel"), Number(b.dataset.spec), sub); });
    sub.group = group;
    if (sub.channel) showChannel($("#chartPanel"), sub.channel, sub);
  }

  function forecastSummary(f, unit) {
    const cr = (f.crossings || []).filter((c) => c.eta || (c.prob_exceed_at_horizon || 0) >= 0.05);
    return `<div class="panel" style="margin-top:.6rem"><h3>Dự báo ${esc(f.days)} ngày</h3>
      <p class="small">Mô hình: ${esc((f.terms || []).join(", "))} · ${f.n} điểm trong ${esc(fmtNum(f.span_days, 1))} ngày ·
        R² ${esc(fmtNum(f.r2, 2))} · xu thế ${esc(fmtNum(f.slope_per_day, 4))} ${esc(unitLabel(unit))}/ngày.
        Nét đứt và dải mờ trên biểu đồ là trung bình dự báo và khoảng tin cậy 95%.</p>
      ${cr.length ? `<ul class="small">${cr.map((c) => `<li>${lv(c.level)} (${esc(fmtNum(c.bound))} ${esc(unitLabel(unit))}):
        ${c.eta ? `dự kiến chạm khoảng <strong>${esc(fmtTime(c.eta))}</strong>` : "chưa chạm trong khoảng dự báo"}${c.prob_exceed_at_horizon !== null ? ` · xác suất vượt ở cuối kỳ ≈ ${esc(fmtNum(c.prob_exceed_at_horizon * 100, 0))}%` : ""}</li>`).join("")}</ul>`
        : `<p class="small muted">Không dự báo vượt ngưỡng trong ${esc(f.days)} ngày.</p>`}
      <p class="small muted">${esc((f.notes || []).join(" "))}</p></div>`;
  }

  function stormForm(box, chId, unit) {
    box.innerHTML = `<form class="panel" id="stormForm" style="margin-top:.6rem"><h3>Kịch bản bão</h3>
      <p class="small muted">Ước lượng gia tăng của kênh này theo Hs đỉnh, từ đáp ứng thực tế qua các trận bão đã quan trắc.</p>
      <div class="form-row"><label>Hs đỉnh dự báo (m)<input name="hs" required value="6"></label>
        <label>Ngưỡng Hs xác định trận bão (m)<input name="ev" value="3"></label></div>
      <div class="actions"><button class="primary" type="submit">Tính kịch bản</button></div><div id="stormRes"></div></form>`;
    $("#stormForm").onsubmit = async (ev) => {
      ev.preventDefault();
      const f = new FormData(ev.target);
      try {
        const r = await apiCall(`/api/channels/${chId}/storm-scenario`, "POST",
          { hs_peak: Number(String(f.get("hs")).replace(",", ".")), hs_event: Number(String(f.get("ev")).replace(",", ".")) });
        const sc = r.scenario || {};
        $("#stormRes").innerHTML = `<div class="table-wrap"><table><thead><tr><th>Trận bão</th><th>Hs đỉnh (m)</th><th>Thay đổi (${esc(unitLabel(unit))})</th></tr></thead><tbody>
          ${r.response.events.map((e) => `<tr><td>${esc(fmtTime(e.start))}</td><td class="num">${esc(fmtNum(e.hs_peak, 2))}</td><td class="num">${esc(fmtNum(e.delta))}</td></tr>`).join("") || `<tr><td colspan="3" class="muted">Chưa có trận bão nào vượt ngưỡng Hs.</td></tr>`}</tbody></table></div>
          ${sc.ok ? `<p>Hiện tại <strong>${esc(fmtNum(r.current))}</strong> → dự kiến sau bão <strong>${esc(fmtNum(sc.expected_value))}</strong> ${esc(unitLabel(unit))}
            (tăng ${esc(fmtNum(sc.expected_increment))}${sc.range_95 ? `, khoảng 95%: ${esc(fmtNum(sc.range_95[0]))} – ${esc(fmtNum(sc.range_95[1]))}` : ""}).</p>
            ${(sc.levels || []).map((l) => `<span class="tag ${l.exceeded ? "warn" : ""}">${esc(l.level_name)} ${esc(fmtNum(l.bound))}: ${l.exceeded ? "vượt" : "chưa vượt"}</span>`).join(" ")}`
            : `<p class="small">${esc(sc.detail || "Chưa ước lượng được.")}</p>`}
          <p class="small muted">${esc((r.response.notes || []).join(" "))}</p>`;
      } catch (e) { toast(e.message, true); }
    };
  }

  // ============================================================ phổ tần số
  function spectrumChart(el, sp) {
    const W = Math.max(320, el.clientWidth || 640), H = 260, m = { l: 56, r: 12, t: 12, b: 32 };
    const lg = (v) => Math.log10(Math.max(v, 1e-30));
    const ys = sp.psd.map(lg).concat(sp.baseline ? sp.baseline.psd.map(lg) : []);
    let lo = Math.floor(Math.min(...ys)), hi = Math.ceil(Math.max(...ys));
    if (hi - lo < 2) hi = lo + 2;
    const fmax = Math.max(...sp.freqs);
    const X = (f) => m.l + f / fmax * (W - m.l - m.r);
    const Y = (v) => m.t + (hi - v) / (hi - lo) * (H - m.t - m.b);
    let g = "";
    for (let e = lo; e <= hi; e++) g += `<line class="grid-line" x1="${m.l}" x2="${W - m.r}" y1="${Y(e)}" y2="${Y(e)}"/><text x="${m.l - 6}" y="${Y(e) + 4}" text-anchor="end">1e${e}</text>`;
    niceTicks(0, fmax, 6).filter((f) => f <= fmax).forEach((f) => g += `<text x="${X(f)}" y="${H - 10}" text-anchor="middle">${esc(fmtNum(f, 2))} Hz</text>`);
    const path = (fr, ps, cls) => `<polyline class="${cls}" points="${fr.map((f, i) => `${X(f)},${Y(lg(ps[i]))}`).join(" ")}"/>`;
    const peaks = (sp.features.peaks || []).map((p) => `<line class="th th-2" x1="${X(p.freq)}" x2="${X(p.freq)}" y1="${m.t}" y2="${H - m.b}"><title>${esc(fmtNum(p.freq, 3))} Hz</title></line>
      <text x="${X(p.freq) + 3}" y="${m.t + 10}" class="peak-label">${esc(fmtNum(p.freq, 2))}</text>`).join("");
    el.innerHTML = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Phổ công suất">
      <g class="axis">${g}</g>${sp.baseline ? path(sp.baseline.freqs, sp.baseline.psd, "fline") : ""}${path(sp.freqs, sp.psd, "series")}${peaks}</svg>`;
  }

  async function showSpectrum(panel, sensorId, sub) {
    panel.classList.remove("hidden");
    panel.innerHTML = `<p class="muted">Đang tải phân tích tần số…</p>`;
    try {
      const [trend, list] = await Promise.all([apiCall(`/api/sensors/${sensorId}/frequency-trend?days=30`),
        apiCall(`/api/sensors/${sensorId}/waveforms?limit=50`)]);
      if (!list.length) { panel.innerHTML = `<h3>Phân tích tần số</h3><p class="muted">Chưa có đoạn dao động thô. Gateway gửi qua POST /api/ingest/waveform.</p>`; return; }
      const wid = sub.waveform || list[0].id;
      const sp = await apiCall(`/api/waveforms/${wid}/spectrum`);
      const f = sp.features || {};
      panel.innerHTML = `<h3>Phân tích tần số — ${esc(sp.sensor)} (trục ${esc(sp.axis)})</h3>
        <div class="form-row"><label>Đoạn dao động<select id="wfSel">${list.map((w) => `<option value="${w.id}" ${w.id === wid ? "selected" : ""}>${esc(fmtTime(w.ts))} · ${esc(fmtNum(w.freq, 3))} Hz</option>`).join("")}</select></label></div>
        <div id="specBox"></div>
        <p class="small muted">Phổ công suất Welch (thang log). Đường xanh liền: đoạn đang xem; nét đứt: phổ nền${sp.baseline ? ` (${esc(fmtTime(sp.baseline.ts))})` : " (chưa đặt)"}; vạch cam: các đỉnh.</p>
        <div class="table-wrap"><table><thead><tr><th>Đỉnh</th><th>Tần số (Hz)</th><th>Tỷ số so với nền phổ</th><th>Cản ước lượng</th></tr></thead><tbody>
          ${(f.peaks || []).map((p, i) => `<tr><td>${i + 1}</td><td class="num">${esc(fmtNum(p.freq, 3))}</td><td class="num">${esc(fmtNum(p.ratio_to_floor, 1))}</td><td class="num">${p.damping ? esc(fmtNum(p.damping * 100, 2)) + " %" : "–"}</td></tr>`).join("")}</tbody></table></div>
        <dl class="kv"><dt>RMS / đỉnh</dt><dd class="num">${esc(fmtNum(f.rms, 4))} / ${esc(fmtNum(f.peak, 4))} ${esc(unitLabel(sp.unit))}</dd>
          <dt>Lấy mẫu</dt><dd>${esc(fmtNum(sp.fs))} Hz · ${sp.n} mẫu · độ phân giải ${esc(fmtNum(f.df, 4))} Hz</dd>
          <dt>Tần số nền</dt><dd>${trend.baseline_freq ? esc(fmtNum(trend.baseline_freq, 3)) + " Hz" : "chưa đặt"}</dd></dl>
        ${can("engineer") ? `<div class="actions"><button type="button" id="setBase">Đặt đoạn này làm phổ nền</button></div>` : ""}
        <h3 style="margin-top:1rem">Tần số trội 30 ngày</h3><div id="trendBox"></div>
        <p class="small muted">${esc(trend.note)}</p>`;
      spectrumChart($("#specBox"), sp);
      const tr = { sensor: sp.sensor, channel: "freq", points: trend.points.filter((p) => p.freq).map((p) => ({ ts: p.ts, value: p.freq })),
        thresholds: trend.baseline_freq ? [{ kind: "absolute", direction: "below", watch: trend.baseline_freq }] : [] };
      lineChart($("#trendBox"), tr);
      $("#wfSel").onchange = (e) => { sub.waveform = Number(e.target.value); showSpectrum(panel, sensorId, sub); };
      const sbase = $("#setBase");
      if (sbase) sbase.onclick = async () => {
        if (!confirm("Đặt đoạn dao động này làm phổ nền để so sánh về sau?")) return;
        try { await apiCall(`/api/waveforms/${wid}/set-baseline`, "POST"); toast("Đã đặt phổ nền"); showSpectrum(panel, sensorId, sub); }
        catch (e) { toast(e.message, true); }
      };
      panel.scrollIntoView({ block: "nearest" });
    } catch (e) { panel.innerHTML = `<p>${esc(e.message)}</p>`; }
  }

  async function gradeDialog(btn, done) {
    const isStructure = !!btn.dataset.structure;
    const allowed = isStructure ? "A, B, C, D" : "a, b, c, d";
    const grade = prompt(`Cấp hiện trạng theo TCVN 13330 (${allowed}). Gợi ý của app: ${btn.dataset.sug}`, btn.dataset.sug);
    if (!grade) return;
    const note = prompt("Căn cứ xác nhận (khảo sát, kiểm định…)", "") || "";
    try {
      await apiCall("/api/grades", "POST", { node_id: Number(btn.dataset.grade), grade: grade.trim(), note });
      toast("Đã xác nhận cấp hiện trạng"); done();
    } catch (e) { toast(e.message, true); }
  }

  async function showChannel(panel, chId, sub) {
    panel.classList.remove("hidden");
    const days = sub.days || 7;
    const to = new Date(), from = new Date(to - days * 86400000);
    panel.innerHTML = `<p class="muted">Đang tải biểu đồ…</p>`;
    try {
      const q = `from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`;
      const [d, an] = await Promise.all([apiCall(`/api/channels/${chId}/data?${q}`),
                                         apiCall(`/api/channels/${chId}/analytics?${q}`)]);
      const eta = (an.eta || []).filter((e) => e.eta).map((e) =>
        `<li>Chạm mức ${esc({ watch: "Chú ý", warning: "Cảnh báo", action: "Hành động" }[e.level])} (${esc(fmtNum(e.target))} ${esc(unitLabel(d.unit))}) dự kiến ${esc(fmtTime(e.eta))}</li>`).join("");
      panel.innerHTML = `
        <div class="actions" style="justify-content:space-between"><h3>${esc(d.sensor)} / ${esc(d.channel)} (${esc(unitLabel(d.unit))})</h3>
          <span>${[1, 7, 30, 90, 365].map((n) => `<button type="button" data-days="${n}" aria-pressed="${n === days}">${n} ngày</button>`).join(" ")}</span></div>
        <div id="chartBox"></div>
        <p class="small muted">${d.agg === "raw" ? "Số liệu gốc" : d.agg === "hour" ? "Trung bình theo giờ (dải mờ = min–max)" : "Trung bình theo ngày (dải mờ = min–max)"} ·
          đường đứt nét: ngưỡng tuyệt đối · chấm vàng/đỏ: số liệu nghi ngờ/hỏng.</p>
        <dl class="kv">
          <dt>Số điểm</dt><dd class="num">${an.n}</dd>
          <dt>Nhỏ nhất / lớn nhất</dt><dd class="num">${esc(fmtNum(an.stats.min))} / ${esc(fmtNum(an.stats.max))}</dd>
          <dt>Xu thế</dt><dd class="num">${an.trend.slope_per_day === null ? "–" : esc(fmtNum(an.trend.slope_per_day, 4)) + " " + esc(d.unit) + "/ngày"}
            ${an.trend.r2 !== null ? ` (R² ${esc(fmtNum(an.trend.r2, 2))})` : ""}</dd>
        </dl>
        ${eta ? `<ul class="small">${eta}</ul>` : ""}
        <p class="small muted">${esc((an.trend.notes || []).join(" "))}</p>
        <div class="actions"><button type="button" id="fcBtn" aria-pressed="${!!sub.forecast}">Dự báo 7 ngày</button>
          ${sub.group === "breakwater" && !isGuest() ? `<button type="button" id="stormBtn">Kịch bản bão</button>` : ""}</div>
        <div id="fcBox"></div><div id="stormBox"></div>`;
      if (sub.forecast) {
        try {
          const f = await apiCall(`/api/channels/${chId}/forecast?days=7&window_days=30`);
          d.forecast = f.forecast;
          $("#fcBox").innerHTML = forecastSummary(f, d.unit);
        } catch (e) { $("#fcBox").innerHTML = `<p class="small">${esc(e.message)}</p>`; }
      }
      lineChart($("#chartBox"), d);
      $("#fcBtn").onclick = () => { sub.forecast = !sub.forecast; showChannel(panel, chId, sub); };
      const sb = $("#stormBtn");
      if (sb) sb.onclick = () => stormForm($("#stormBox"), chId, d.unit);
      panel.querySelectorAll("[data-days]").forEach((b) => b.onclick = () => {
        sub.days = Number(b.dataset.days); showChannel(panel, chId, sub);
      });
      panel.scrollIntoView({ block: "nearest" });
    } catch (e) { panel.innerHTML = `<p>${esc(e.message)}</p>`; }
  }

  // ============================================================ cảnh báo, khuyến cáo
  function alertTable(alerts, withStructure = false) {
    if (!alerts.length) return `<p class="muted small">Không có cảnh báo.</p>`;
    const sname = (id) => state.structures.find((s) => s.id === id)?.name || id;
    return `<div class="table-wrap"><table><thead><tr><th>Mức hiện tại</th><th>Cao nhất</th>
      ${withStructure ? "<th>Công trình</th>" : ""}<th>Nội dung</th><th>Trạng thái</th><th></th></tr></thead><tbody>
      ${alerts.map((a) => `<tr><td>${lv(a.current_level)}</td><td>${lv(a.level)}</td>
        ${withStructure ? `<td class="small">${esc(sname(a.structure_id))}</td>` : ""}
        <td><strong>${esc(a.title)}</strong><br><span class="small">${esc(a.message).replace(/\n/g, "<br>")}</span>
          ${a.note ? `<br><span class="small muted">${esc(a.note).replace(/\n/g, "<br>")}</span>` : ""}
          <br><span class="small muted">Mở ${esc(fmtTime(a.opened_at))} · cập nhật ${esc(fmtTime(a.updated_at))}</span></td>
        <td>${esc(STATUS[a.status] || a.status)}</td>
        <td><div class="actions">
          ${a.status === "open" && can("operator") ? `<button type="button" data-ack="${a.id}">Đã xem</button>` : ""}
          ${a.status !== "closed" && can("engineer") ? `<button type="button" data-close="${a.id}" ${a.current_level > 0 && ["threshold", "rule"].includes(a.kind) ? "disabled title=\"Còn đang vượt ngưỡng\"" : ""}>Đóng</button>` : ""}
        </div></td></tr>`).join("")}</tbody></table></div>`;
  }

  function recTable(recs) {
    return `<div class="table-wrap"><table><thead><tr><th>Mức</th><th>Khuyến cáo</th><th>Trạng thái</th><th></th></tr></thead><tbody>
      ${recs.map((r) => `<tr><td>${lv(r.level)}</td><td class="small">${esc(r.text).replace(/\n/g, "<br>")}
          ${r.requires_authorized ? `<br><span class="tag warn">Cần kỹ sư có thẩm quyền</span>` : ""}
          ${r.decision_note ? `<br><span class="muted">Ghi chú: ${esc(r.decision_note)}</span>` : ""}</td>
        <td>${esc(STATUS[r.status] || r.status)}<br><span class="small muted">${esc(fmtTime(r.decided_at || r.created_at))}</span></td>
        <td>${r.status === "proposed" && can("engineer") && (!r.requires_authorized || canApprove()) ? `<div class="actions">
          <button type="button" class="primary" data-decide="${r.id}" data-d="confirmed">Xác nhận</button>
          <button type="button" data-decide="${r.id}" data-d="rejected">Không chấp nhận</button></div>` : ""}</td></tr>`).join("")}</tbody></table></div>`;
  }

  function bindAlertActions(root, refresh) {
    root.querySelectorAll("[data-ack]").forEach((b) => b.onclick = async () => {
      const note = prompt("Ghi chú (không bắt buộc)", "") ?? null;
      if (note === null) return;
      try { await apiCall(`/api/alerts/${b.dataset.ack}/ack`, "POST", { note }); toast("Đã ghi nhận"); refresh(); }
      catch (e) { toast(e.message, true); }
    });
    root.querySelectorAll("[data-close]").forEach((b) => b.onclick = async () => {
      const note = prompt("Lý do đóng cảnh báo (bắt buộc)", "");
      if (!note) return;
      try { await apiCall(`/api/alerts/${b.dataset.close}/close`, "POST", { note }); toast("Đã đóng cảnh báo"); refresh(); }
      catch (e) { toast(e.message, true); }
    });
    root.querySelectorAll("[data-decide]").forEach((b) => b.onclick = async () => {
      const note = prompt(b.dataset.d === "confirmed" ? "Ghi chú xác nhận (biện pháp, phạm vi áp dụng)" : "Lý do không chấp nhận", "");
      if (note === null) return;
      try { await apiCall(`/api/recommendations/${b.dataset.decide}/decide`, "POST", { decision: b.dataset.d, note });
        toast(b.dataset.d === "confirmed" ? "Đã xác nhận khuyến cáo" : "Đã ghi nhận không chấp nhận"); refresh(); }
      catch (e) { toast(e.message, true); }
    });
  }

  async function viewAlerts(v) {
    const sub = state.sub.alerts || (state.sub.alerts = { status: "active" });
    const [alerts, recs] = await Promise.all([
      apiCall(`/api/alerts?status=${sub.status}`), apiCall(`/api/recommendations?limit=100`)]);
    let simAlerts = [];
    if (sub.status === "active") { try { simAlerts = await apiCall("/api/berthing/alerts?status=open&limit=20"); } catch { simAlerts = []; } }
    v.innerHTML = `
      <div class="subtabs" role="group" aria-label="Lọc cảnh báo">${[["active", "Đang mở"], ["closed", "Đã đóng"]].map(([k, n]) =>
        `<button type="button" data-st="${k}" aria-pressed="${sub.status === k}">${n}</button>`).join("")}</div>
      <div class="panel"><h3>Cảnh báo</h3>${alertTable(alerts, true)}</div>
      ${simAlerts.length ? `<div class="panel" style="border-left:5px solid #c2410c"><h3>Cảnh báo cập tàu – MÔ PHỎNG từ Berthing AI (đang mở)</h3>
        <p class="small muted">Không phải quan trắc thực; không tham gia ngưỡng, quy tắc hay cấp hiện trạng. Xem chi tiết ở tab "Dự báo cập tàu (mô phỏng)".</p>${simAlertTable(simAlerts, true)}</div>` : ""}
      <div class="panel"><h3>Khuyến cáo khai thác</h3>${recs.length ? recTable(recs) : `<p class="muted small">Chưa có khuyến cáo.</p>`}
        <p class="disclaimer">${esc(state.catalog.disclaimer)}</p></div>`;
    v.querySelectorAll("[data-st]").forEach((b) => b.onclick = () => { sub.status = b.dataset.st; route(); });
    bindAlertActions(v, () => route());
    bindSimAck(v, () => route());
  }

  // ============================================================ CẢM BIẾN & CÔNG TRÌNH
  function excelReport(rep) {
    const list = (arr) => arr.length ? `<div class="table-wrap"><table><thead><tr><th>Sheet</th><th>Dòng</th><th>Lỗi</th></tr></thead><tbody>${arr.map((e) =>
      `<tr><td>${esc(e.sheet)}</td><td class="num">${esc(e.row ?? "")}</td><td>${esc(e.detail)}</td></tr>`).join("")}</tbody></table></div>` : "";
    const ing = rep.ingest;
    return `<div class="panel" style="margin-top:.8rem">
      <h3>${rep.dry_run ? "Kết quả kiểm tra thử" : "Kết quả nhập"}: ${rep.ok ? "đạt" : "có lỗi"}</h3>
      <p>${esc(rep.message || "")}</p>
      <dl class="kv">
        <dt>Cảm biến tạo mới</dt><dd>${rep.sensors_created.length ? esc(rep.sensors_created.join(", ")) : "0"}</dd>
        <dt>Cảm biến cập nhật</dt><dd class="num">${rep.sensors_updated.length}</dd>
        <dt>Kênh tạo mới / cập nhật</dt><dd class="num">${rep.channels_created} / ${rep.channels_updated}</dd>
        <dt>Dòng số liệu hợp lệ</dt><dd class="num">${rep.data_valid} / ${rep.data_rows}</dd>
        ${ing ? `<dt>Số liệu đã ghi</dt><dd class="num">${ing.accepted} mới · ${ing.duplicates} trùng (bỏ qua) · ${ing.rejected} bị loại · ${ing.late} gửi bù</dd>` : ""}
      </dl>
      ${list(rep.errors)}
      ${rep.data_errors.length ? `<p class="small muted">Dòng số liệu bị bỏ (tối đa 200 dòng đầu):</p>${list(rep.data_errors)}` : ""}
      ${ing && ing.errors.length ? `<p class="small muted">Số liệu bị loại khi ghi:</p>${list(ing.errors)}` : ""}
      ${rep.dry_run && rep.ok ? `<div class="actions"><button type="button" class="primary" id="xlConfirm">Xác nhận nhập vào hệ thống</button>
        <button type="button" id="xlCancel">Huỷ</button></div>` : ""}
    </div>`;
  }

  function bindExcel(v) {
    $("#xlExport").onclick = async () => {
      const sid = $("#xlStructure").value, days = $("#xlDays").value;
      const p = new URLSearchParams({ days, include_data: days !== "0" });
      if (sid) p.set("structure_id", sid);
      const btn = $("#xlExport"); btn.disabled = true; btn.textContent = "Đang xuất…";
      try { await download(`/api/sensors/export?${p}`, `bo-so-lieu-thiet-bi-${new Date().toISOString().slice(0, 10)}.xlsx`); }
      finally { btn.disabled = false; btn.textContent = "Xuất Excel"; }
    };
    const input = $("#xlFile");
    if (!input) return;
    const send = async (file, dryRun) => {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("dry_run", dryRun ? "true" : "false");
      return apiCall("/api/sensors/import", "POST", fd);
    };
    input.onchange = async () => {
      const file = input.files[0];
      if (!file) return;
      const box = $("#xlReport");
      box.innerHTML = `<p class="muted">Đang kiểm tra ${esc(file.name)}…</p>`;
      try {
        const rep = await send(file, true);
        box.innerHTML = excelReport(rep);
        const ok = $("#xlConfirm");
        if (ok) ok.onclick = async () => {
          ok.disabled = true; ok.textContent = "Đang nhập…";
          try {
            const res = await send(file, false);
            box.innerHTML = excelReport(res);
            toast(res.ok ? "Đã nhập bộ số liệu thiết bị" : "Nhập không thành công", !res.ok);
            if (res.ok) setTimeout(() => route(), 2500);
          } catch (e) { toast(e.message, true); ok.disabled = false; ok.textContent = "Xác nhận nhập vào hệ thống"; }
        };
        const cancel = $("#xlCancel");
        if (cancel) cancel.onclick = () => { box.innerHTML = ""; };
      } catch (e) { box.innerHTML = ""; toast(e.message, true); }
      input.value = "";
    };
  }

  async function viewSensors(v) {
    const [sensors, nodes, gws] = await Promise.all([apiCall("/api/sensors"), apiCall("/api/nodes"),
      can("engineer") ? apiCall("/api/gateways") : Promise.resolve([])]);
    const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
    const pathOf = (id) => { const p = []; let n = byId[id]; while (n) { p.unshift(n.name); n = byId[n.parent_id]; } return p.join(" › "); };
    const st = state.catalog.sensor_types;
    v.innerHTML = `
      <div class="panel" id="xlPanel"><h3>Bộ số liệu thiết bị (Excel)</h3>
        <p class="small muted">Một tệp gồm các sheet CamBien (danh mục), Kenh (hiệu chuẩn), SoLieu (số liệu đo, giờ Việt Nam) và DanhMuc. Xuất ra để lưu hồ sơ hoặc chỉnh sửa, rồi nhập lại.</p>
        <div class="form-row">
          <label>Công trình<select id="xlStructure"><option value="">Tất cả công trình</option>${state.structures.map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join("")}</select></label>
          <label>Số liệu đo kèm theo<select id="xlDays"><option value="0">Chỉ danh mục (không kèm số liệu)</option><option value="1">1 ngày gần nhất</option><option value="7" selected>7 ngày gần nhất</option><option value="30">30 ngày gần nhất</option></select></label>
        </div>
        <div class="actions"><button type="button" class="primary" id="xlExport">Xuất Excel</button>
          ${can("engineer") ? `<label class="btn" style="margin:0">Nhập từ Excel<input type="file" id="xlFile" accept=".xlsx" class="hidden"></label>` : ""}</div>
        <div id="xlReport"></div>
      </div>
      <div class="panel"><h3>Danh mục cảm biến</h3><div class="table-wrap"><table>
        <thead><tr><th>Mã</th><th>Loại</th><th>Vị trí trên công trình</th><th>Chu kỳ gửi</th><th>Lần nhận cuối</th><th>Kênh (hiệu chỉnh)</th></tr></thead>
        <tbody>${sensors.map((s) => `<tr><td>${esc(s.code)}${s.active ? "" : ` <span class="tag">tắt</span>`}</td>
          <td class="small">${esc(st[s.sensor_type]?.name || s.sensor_type)}</td><td class="small">${esc(pathOf(s.node_id))}</td>
          <td class="num small">${s.expected_interval_s ? s.expected_interval_s / 60 + " phút" : "theo sự kiện"}</td>
          <td class="small">${esc(fmtTime(s.last_seen_at))}</td>
          <td class="small">${s.channels.map((c) => `${can("engineer") ? `<button type="button" class="small" data-edit-ch="${c.id}">${esc(c.name)}</button>` : esc(c.name)}
            <span class="muted">${esc(unitLabel(c.unit))} ×${esc(fmtNum(c.factor))} ${c.offset ? "+" + esc(fmtNum(c.offset)) : ""}${c.temp_coeff ? " bù nhiệt" : ""}</span>`).join("<br>")}</td></tr>`).join("")
          || `<tr><td colspan="6" class="muted">Chưa có cảm biến.</td></tr>`}</tbody></table></div></div>
      ${can("engineer") ? `
      <div class="grid cols">
        <form class="panel" id="nodeForm"><h3>Thêm công trình / đơn vị</h3>
          <label>Loại nút<select name="kind"><option value="port">Cảng</option><option value="structure">Công trình</option>
            <option value="unit">Đơn vị kết cấu</option><option value="element">Cấu kiện</option></select></label>
          <label>Thuộc<select name="parent_id"><option value="">(gốc)</option>${nodes.map((n) => `<option value="${n.id}">${esc(pathOf(n.id))}</option>`).join("")}</select></label>
          <label>Loại kết cấu (khi là công trình)<select name="structure_type"><option value=""></option>${Object.entries(state.catalog.structure_types).map(([k, t]) => `<option value="${k}">${esc(t.name)}</option>`).join("")}</select></label>
          <div class="form-row"><label>Mã<input name="code" required pattern="[A-Za-z0-9._-]+"></label><label>Tên<input name="name" required></label></div>
          <div class="actions"><button class="primary" type="submit">Thêm</button></div></form>
        <form class="panel" id="sensorForm"><h3>Thêm cảm biến</h3>
          <div class="form-row"><label>Mã cảm biến<input name="code" required pattern="[A-Za-z0-9._-]+"></label>
          <label>Loại<select name="sensor_type">${Object.entries(st).map(([k, t]) => `<option value="${k}">${esc(t.name)}</option>`).join("")}</select></label></div>
          <label>Gắn tại<select name="node_id" required>${nodes.filter((n) => n.kind !== "port").map((n) => `<option value="${n.id}">${esc(pathOf(n.id))}</option>`).join("")}</select></label>
          <div class="form-row"><label>Gateway<select name="gateway_id"><option value="">(không)</option>${gws.map((g) => `<option value="${g.id}">${esc(g.name)}</option>`).join("")}</select></label>
          <label>Chu kỳ gửi (giây, 0 = theo sự kiện)<input name="expected_interval_s" type="number" min="0" value="600"></label></div>
          <label>Vị trí lắp đặt<input name="location"></label>
          <div class="actions"><button class="primary" type="submit">Thêm cảm biến</button></div>
          <p class="small muted">Kênh mặc định tạo theo loại cảm biến; chỉnh hiệu chuẩn sau bằng nút tên kênh.</p></form>
      </div>
      <form class="panel hidden" id="chForm"><h3>Hiệu chỉnh kênh <span id="chName"></span></h3>
        <p class="small muted">Hiệu chỉnh mới chỉ áp dụng cho số liệu nhận sau khi lưu. Dải đo theo đơn vị kênh sau hiệu chỉnh.</p>
        <div class="form-row">
          ${["unit", "factor", "offset", "baseline", "temp_coeff", "ref_temp", "temp_channel_id", "range_min", "range_max", "max_rate_per_hour", "flatline_count", "design_value"].map((k) =>
            `<label>${esc({ unit: "Đơn vị", factor: "Hệ số", offset: "Độ lệch", baseline: "Giá trị nền", temp_coeff: "Hệ số nhiệt (/°C)", ref_temp: "Nhiệt độ chuẩn (°C)", temp_channel_id: "Kênh nhiệt độ (id)", range_min: "Dải đo min", range_max: "Dải đo max", max_rate_per_hour: "Tốc độ tối đa (/giờ)", flatline_count: "Số lần đứng yên", design_value: "Giá trị thiết kế" }[k])}<input name="${k}"></label>`).join("")}
        </div>
        <div class="actions"><button class="primary" type="submit">Lưu hiệu chỉnh</button><button type="button" id="chCancel">Huỷ</button></div></form>` : ""}`;
    bindExcel(v);
    if (!can("engineer")) return;
    const numOrNull = (x) => x === "" || x === null ? null : Number(x);
    $("#nodeForm").onsubmit = async (ev) => {
      ev.preventDefault();
      const f = Object.fromEntries(new FormData(ev.target));
      const body = { kind: f.kind, code: f.code, name: f.name, parent_id: numOrNull(f.parent_id) };
      if (f.kind === "structure") body.structure_type = f.structure_type || null;
      try { await apiCall("/api/nodes", "POST", body); toast("Đã thêm"); state.structures = await apiCall("/api/structures"); route(); }
      catch (e) { toast(e.message, true); }
    };
    $("#sensorForm").onsubmit = async (ev) => {
      ev.preventDefault();
      const f = Object.fromEntries(new FormData(ev.target));
      try {
        await apiCall("/api/sensors", "POST", { code: f.code, sensor_type: f.sensor_type, node_id: Number(f.node_id),
          gateway_id: numOrNull(f.gateway_id), expected_interval_s: Number(f.expected_interval_s || 0), location: f.location });
        toast("Đã thêm cảm biến"); route();
      } catch (e) { toast(e.message, true); }
    };
    const chForm = $("#chForm");
    const chans = Object.fromEntries(sensors.flatMap((s) => s.channels.map((c) => [c.id, { ...c, sensor: s.code }])));
    v.querySelectorAll("[data-edit-ch]").forEach((b) => b.onclick = () => {
      const c = chans[b.dataset.editCh];
      chForm.dataset.id = c.id; chForm.dataset.name = c.name;
      $("#chName").textContent = `${c.sensor}/${c.name}`;
      for (const el of chForm.elements) if (el.name) el.value = c[el.name] ?? "";
      chForm.classList.remove("hidden"); chForm.scrollIntoView({ block: "nearest" });
    });
    $("#chCancel").onclick = () => chForm.classList.add("hidden");
    chForm.onsubmit = async (ev) => {
      ev.preventDefault();
      const f = Object.fromEntries(new FormData(chForm));
      const body = { name: chForm.dataset.name, unit: f.unit || null };
      ["factor", "offset", "temp_coeff"].forEach((k) => body[k] = f[k] === "" ? (k === "factor" ? 1 : 0) : Number(f[k]));
      ["baseline", "ref_temp", "temp_channel_id", "range_min", "range_max", "max_rate_per_hour", "flatline_count", "design_value"].forEach((k) => body[k] = numOrNull(f[k]));
      const old = chans[chForm.dataset.id];
      body.derive = old.derive;
      try { await apiCall(`/api/channels/${chForm.dataset.id}`, "PUT", body); toast("Đã lưu hiệu chỉnh"); route(); }
      catch (e) { toast(e.message, true); }
    };
  }

  // ============================================================ KHẢO SÁT
  const SURVEY_FIELDS = {
    armour_profile: [["Ae_m2", "Diện tích xói Ae (m²)"], ["M50_t", "Khối lượng M50 (t)"], ["rho_s", "ρs (t/m³), mặc định 2,65"], ["cot_alpha", "cotα mái, mặc định 2"]],
    ut_thickness: [["thickness_mm", "Chiều dày đo (mm)"], ["t_initial_mm", "Chiều dày ban đầu (mm)"], ["install_date", "Ngày lắp đặt (YYYY-MM-DD)"], ["t_min_mm", "Chiều dày tối thiểu (mm)"]],
    crack: [["width_mm", "Bề rộng nứt (mm)"], ["length_mm", "Chiều dài (mm)"]],
    armour_count: [["total", "Tổng số khối"], ["displaced", "Số khối dịch chuyển"], ["broken", "Số khối gãy"]],
    scour: [["depth_m", "Độ sâu đáy (m)"], ["reference_depth_m", "Độ sâu tham chiếu (m)"]],
    chloride: [["chloride_percent", "Chloride (% khối lượng xi măng)"], ["depth_mm", "Độ sâu lấy mẫu (mm)"]],
    half_cell: [["potential_mv", "Điện thế (mV)"]],
    profile: [["note_profile", "Mô tả mặt cắt"]],
    other: [["value", "Giá trị"]],
  };
  const SURVEY_NAMES = { armour_profile: "Mặt cắt lớp phủ (S)", ut_thickness: "Chiều dày UT (ăn mòn)", crack: "Vết nứt",
    armour_count: "Đếm khối phủ", scour: "Xói/độ sâu đáy", chloride: "Chloride", half_cell: "Điện thế ăn mòn", profile: "Mặt cắt khác", other: "Khác" };

  function resultText(kind, r) {
    if (!r || !Object.keys(r).length) return "";
    if (kind === "armour_profile") return `S = ${fmtNum(r.S, 2)} — ${r.stage_name} (tham khảo cotα ${r.cot_alpha_ref}: bắt đầu ${r.S_start}, phá hoại ${r.S_failure})`;
    if (kind === "ut_thickness" && r.rate_mm_per_year !== undefined) return `Tốc độ ăn mòn ${fmtNum(r.rate_mm_per_year, 3)} mm/năm; mất ${fmtNum(r.loss_percent, 1)}%` +
      (r.years_to_t_min !== undefined && r.years_to_t_min !== null ? `; còn ${fmtNum(r.years_to_t_min, 1)} năm tới chiều dày tối thiểu` : "");
    if (kind === "crack" && r.growth_mm_per_year !== undefined) return `Tốc độ mở rộng ${fmtNum(r.growth_mm_per_year, 3)} mm/năm`;
    if (kind === "armour_count") return `Hư hỏng ${fmtNum(r.damaged_percent, 1)}% số khối`;
    if (kind === "scour" && r.scour_m !== undefined) return `Xói ${fmtNum(r.scour_m, 2)} m so với tham chiếu`;
    return r.note || "";
  }

  async function viewSurveys(v) {
    const sub = state.sub.surveys || (state.sub.surveys = { structure: state.structures[0]?.id, kind: "armour_profile" });
    const rows = sub.structure ? await apiCall(`/api/surveys?structure_id=${sub.structure}`) : [];
    v.innerHTML = `
      <div class="panel"><label>Công trình<select id="svStructure">${state.structures.map((s) =>
        `<option value="${s.id}" ${s.id === sub.structure ? "selected" : ""}>${esc(s.name)}</option>`).join("")}</select></label></div>
      ${can("engineer") && sub.structure ? `<form class="panel" id="svForm"><h3>Nhập số liệu khảo sát</h3>
        <div class="form-row"><label>Loại khảo sát<select name="kind" id="svKind">${Object.keys(SURVEY_FIELDS).map((k) =>
          `<option value="${k}" ${k === sub.kind ? "selected" : ""}>${esc(SURVEY_NAMES[k])}</option>`).join("")}</select></label>
          <label>Ngày khảo sát<input name="survey_date" type="date" required></label>
          <label>Vị trí (dùng cùng tên để theo dõi qua các đợt)<input name="location"></label></div>
        <div class="form-row">${SURVEY_FIELDS[sub.kind].map(([k, n]) => `<label>${esc(n)}<input name="d_${k}"></label>`).join("")}</div>
        <label>Ghi chú<textarea name="note"></textarea></label>
        <div class="actions"><button class="primary" type="submit">Lưu và tính kết quả</button></div></form>` : ""}
      <div class="panel"><h3>Các đợt khảo sát</h3><div class="table-wrap"><table>
        <thead><tr><th>Ngày</th><th>Loại</th><th>Vị trí</th><th>Số liệu</th><th>Kết quả</th></tr></thead>
        <tbody>${rows.map((r) => `<tr><td>${esc(fmtDate(r.survey_date))}</td><td class="small">${esc(SURVEY_NAMES[r.kind] || r.kind)}</td>
          <td class="small">${esc(r.location)}</td>
          <td class="small">${Object.entries(r.data).map(([k, x]) => `${esc(k)} = ${esc(x)}`).join("<br>")}</td>
          <td class="small">${esc(resultText(r.kind, r.result))}${r.result?.note && r.kind !== "armour_count" ? `<br><span class="muted">${esc(r.result.note)}</span>` : ""}</td></tr>`).join("")
          || `<tr><td colspan="5" class="muted">Chưa có số liệu khảo sát.</td></tr>`}</tbody></table></div>
        <p class="small muted">Kết quả là chỉ số tham khảo; kết luận an toàn cần kiểm toán khả năng chịu lực/ổn định.</p></div>`;
    $("#svStructure").onchange = (e) => { sub.structure = Number(e.target.value); route(); };
    const k = $("#svKind"); if (k) k.onchange = (e) => { sub.kind = e.target.value; route(); };
    const form = $("#svForm");
    if (form) form.onsubmit = async (ev) => {
      ev.preventDefault();
      const f = Object.fromEntries(new FormData(form));
      const data = {};
      Object.entries(f).forEach(([key, val]) => {
        if (key.startsWith("d_") && val !== "") data[key.slice(2)] = /date/.test(key) || isNaN(Number(String(val).replace(",", "."))) ? val : Number(String(val).replace(",", "."));
      });
      try {
        const r = await apiCall("/api/surveys", "POST", { structure_id: sub.structure, kind: f.kind,
          survey_date: f.survey_date, location: f.location, data, note: f.note });
        toast("Đã lưu. " + resultText(r.kind, r.result)); route();
      } catch (e) { toast(e.message, true); }
    };
  }

  // ============================================================ NGƯỠNG & QUY TẮC
  async function viewRules(v) {
    const sub = state.sub.rules || (state.sub.rules = { structure: state.structures[0]?.id });
    if (!sub.structure) { v.innerHTML = `<div class="panel"><p class="muted">Chưa có công trình.</p></div>`; return; }
    const [ths, rules, sensors] = await Promise.all([apiCall(`/api/thresholds?structure_id=${sub.structure}`),
      apiCall(`/api/rules?structure_id=${sub.structure}`), apiCall(`/api/sensors?structure_id=${sub.structure}`)]);
    const chName = Object.fromEntries(sensors.flatMap((s) => s.channels.map((c) => [c.id, `${s.code}/${c.name} (${c.unit})`])));
    const SRC = { design: "Thiết kế", standard: "Tiêu chuẩn", engineer: "Kiến nghị kỹ sư", baseline: "Số liệu nền" };
    const KIND = { absolute: "Tuyệt đối", percent_design: "% thiết kế", delta_baseline: "So với nền", rate: "Tốc độ", sigma: "Thống kê σ" };
    v.innerHTML = `
      <div class="panel"><label>Công trình<select id="ruStructure">${state.structures.map((s) =>
        `<option value="${s.id}" ${s.id === sub.structure ? "selected" : ""}>${esc(s.name)}</option>`).join("")}</select></label></div>
      <div class="panel"><h3>Ngưỡng</h3><div class="table-wrap"><table>
        <thead><tr><th>ID</th><th>Kênh</th><th>Tên</th><th>Loại</th><th>Biên</th><th>Nguồn</th><th>Phê duyệt</th><th>Mức hiện tại</th></tr></thead>
        <tbody>${ths.map((t) => `<tr><td class="num">${t.id}</td><td class="small">${esc(chName[t.channel_id] || t.channel_id)}</td><td>${esc(t.name)}</td>
          <td class="small">${esc(KIND[t.kind])}</td><td class="small">${esc(t.description)}${t.hysteresis ? `<br>độ trễ ${esc(fmtNum(t.hysteresis))}` : ""}${t.min_duration > 1 ? `, duy trì ${t.min_duration} điểm` : ""}</td>
          <td class="small">${esc(SRC[t.source] || t.source)}${t.source_ref ? `<br><span class="muted">${esc(t.source_ref)}</span>` : ""}</td>
          <td class="small">${t.approved_at ? "Đã duyệt " + esc(fmtDate(t.approved_at)) : t.is_illustrative ? `<span class="tag warn">Minh hoạ – chưa duyệt</span>` : `<span class="tag warn">Chưa duyệt</span>`}
            ${!t.approved_at && canApprove() ? `<br><button type="button" data-approve="${t.id}">Phê duyệt</button>` : ""}</td>
          <td>${lv(t.current_level)}</td></tr>`).join("") || `<tr><td colspan="8" class="muted">Chưa khai báo ngưỡng.</td></tr>`}</tbody></table></div></div>
      ${can("engineer") ? `<form class="panel" id="thForm"><h3>Thêm ngưỡng</h3>
        <div class="form-row"><label>Kênh<select name="channel_id">${Object.entries(chName).map(([id, n]) => `<option value="${id}">${esc(n)}</option>`).join("")}</select></label>
          <label>Tên<input name="name"></label>
          <label>Loại<select name="kind">${Object.entries(KIND).map(([k, n]) => `<option value="${k}">${esc(n)}</option>`).join("")}</select></label>
          <label>Chiều<select name="direction"><option value="above">Lớn hơn</option><option value="below">Nhỏ hơn</option><option value="abs">Trị tuyệt đối</option></select></label></div>
        <div class="form-row"><label>Chú ý<input name="watch"></label><label>Cảnh báo<input name="warning"></label><label>Hành động<input name="action"></label>
          <label>Giá trị thiết kế (cho %)<input name="design_value"></label><label>Giá trị nền<input name="baseline"></label></div>
        <div class="form-row"><label>Cửa sổ (giờ, cho tốc độ/σ)<input name="window_hours" value="24"></label><label>Độ trễ<input name="hysteresis" value="0"></label>
          <label>Số điểm duy trì<input name="min_duration" value="1"></label>
          <label>Nguồn<select name="source">${Object.entries(SRC).map(([k, n]) => `<option value="${k}">${esc(n)}</option>`).join("")}</select></label></div>
        <label>Căn cứ (hồ sơ thiết kế, điều khoản tiêu chuẩn…)<input name="source_ref"></label>
        <div class="actions"><button class="primary" type="submit">Thêm ngưỡng</button></div>
        <p class="small muted">Ngưỡng mới chưa được phê duyệt; cảnh báo sẽ ghi chú điều này cho tới khi kỹ sư có thẩm quyền phê duyệt.</p></form>` : ""}
      <div class="panel"><h3>Quy tắc kết hợp (chuỗi cảnh báo)</h3>${rules.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Quy tắc</th><th>Điều kiện</th><th>Kết quả</th><th>Đang thoả</th></tr></thead><tbody>
        ${rules.map((r) => `<tr><td><strong>${esc(r.name)}</strong><p class="chain">${esc(r.chain)}</p></td>
          <td class="small">${r.mode === "all" ? "Tất cả" : "Ít nhất một"}:<br>${r.conditions.map((c) => {
            const t = ths.find((x) => x.id === c.threshold_id);
            return `ngưỡng ${c.threshold_id} ${esc(t ? t.name : "")} ≥ ${LEVEL[c.min_level]}`; }).join("<br>")}</td>
          <td>${lv(r.result_level)}<br><span class="small">${esc(r.recommendation)}</span></td><td>${r.fired ? "Có" : "Không"}</td></tr>`).join("")}</tbody></table></div>`
        : `<p class="muted small">Chưa có quy tắc.</p>`}</div>
      ${can("engineer") && ths.length ? `<form class="panel" id="ruForm"><h3>Thêm quy tắc kết hợp</h3>
        <div class="form-row"><label>Tên<input name="name" required></label><label>Chế độ<select name="mode"><option value="all">Tất cả điều kiện</option><option value="any">Ít nhất một</option></select></label>
          <label>Mức kết quả<select name="result_level"><option value="1">Chú ý</option><option value="2" selected>Cảnh báo</option><option value="3">Hành động</option></select></label></div>
        <fieldset class="panel"><legend class="small muted">Điều kiện: chọn ngưỡng và mức tối thiểu</legend>
          ${ths.map((t) => `<label><input type="checkbox" name="c_${t.id}"> ${esc(t.name || t.id)} (${esc(chName[t.channel_id] || "")}) ≥
            <select name="m_${t.id}" style="display:inline;width:auto"><option value="1">Chú ý</option><option value="2">Cảnh báo</option><option value="3">Hành động</option></select></label>`).join("")}
        </fieldset>
        <label>Chuỗi cảnh báo (mô tả cơ chế)<input name="chain"></label>
        <label>Khuyến cáo khi thoả<textarea name="recommendation"></textarea></label>
        <div class="actions"><button class="primary" type="submit">Thêm quy tắc</button></div></form>` : ""}`;
    $("#ruStructure").onchange = (e) => { sub.structure = Number(e.target.value); route(); };
    v.querySelectorAll("[data-approve]").forEach((b) => b.onclick = async () => {
      if (!confirm("Phê duyệt ngưỡng này? Thao tác được ghi vào nhật ký kiểm toán.")) return;
      try { await apiCall(`/api/thresholds/${b.dataset.approve}/approve`, "POST"); toast("Đã phê duyệt ngưỡng"); route(); }
      catch (e) { toast(e.message, true); }
    });
    const num = (x) => x === "" || x === undefined ? null : Number(String(x).replace(",", "."));
    const thForm = $("#thForm");
    if (thForm) thForm.onsubmit = async (ev) => {
      ev.preventDefault();
      const f = Object.fromEntries(new FormData(thForm));
      try {
        await apiCall("/api/thresholds", "POST", { channel_id: Number(f.channel_id), name: f.name, kind: f.kind, direction: f.direction,
          watch: num(f.watch), warning: num(f.warning), action: num(f.action), design_value: num(f.design_value), baseline: num(f.baseline),
          window_hours: num(f.window_hours) || 24, hysteresis: num(f.hysteresis) || 0, min_duration: Number(f.min_duration || 1),
          source: f.source, source_ref: f.source_ref });
        toast("Đã thêm ngưỡng"); route();
      } catch (e) { toast(e.message, true); }
    };
    const ruForm = $("#ruForm");
    if (ruForm) ruForm.onsubmit = async (ev) => {
      ev.preventDefault();
      const f = new FormData(ruForm);
      const conditions = ths.filter((t) => f.get(`c_${t.id}`)).map((t) => ({ threshold_id: t.id, min_level: Number(f.get(`m_${t.id}`)) }));
      try {
        await apiCall("/api/rules", "POST", { structure_id: sub.structure, name: f.get("name"), mode: f.get("mode"),
          result_level: Number(f.get("result_level")), conditions, chain: f.get("chain"), recommendation: f.get("recommendation") });
        toast("Đã thêm quy tắc"); route();
      } catch (e) { toast(e.message, true); }
    };
  }

  // ============================================================ BÁO CÁO
  async function viewReports(v) {
    const sensors = await apiCall("/api/sensors");
    const chans = sensors.flatMap((s) => s.channels.map((c) => ({ id: c.id, name: `${s.code}/${c.name}` })));
    v.innerHTML = `
      <div class="grid cols">
        <div class="panel"><h3>Hiện trạng công trình</h3><p class="small muted">Mức cảnh báo, cấp gợi ý và cấp đã xác nhận của tất cả công trình.</p>
          <button type="button" class="primary" data-dl="/api/reports/status" data-fn="hien-trang.xlsx">Tải Excel</button></div>
        <div class="panel"><h3>Nhật ký cảnh báo</h3><label>Từ ngày<input type="date" id="rFrom"></label><label>Đến ngày<input type="date" id="rTo"></label>
          <button type="button" class="primary" id="dlAlerts">Tải Excel</button></div>
        <div class="panel"><h3>Số liệu khảo sát</h3><button type="button" class="primary" data-dl="/api/reports/surveys" data-fn="khao-sat.xlsx">Tải Excel</button></div>
        <div class="panel"><h3>Số liệu đo của một kênh</h3><label>Kênh<select id="rCh">${chans.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("")}</select></label>
          <button type="button" class="primary" id="dlMeas">Tải Excel (30 ngày gần nhất)</button></div>
      </div>
      <p class="small muted">Thời gian trong tệp Excel ghi theo UTC.</p>
      <div class="grid cols">
        <form class="panel" id="pdfStruct"><h3>Báo cáo PDF định kỳ</h3>
          <label>Công trình<select name="sid">${state.structures.map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join("")}</select></label>
          <div class="form-row"><label>Từ ngày<input type="date" name="from" value="${dateInput(-30)}"></label><label>Đến ngày<input type="date" name="to" value="${dateInput(0)}"></label></div>
          <div class="actions"><button class="primary" type="submit">Tải PDF</button></div>
          <p class="small muted">Tóm tắt hiện trạng, cảnh báo, khuyến cáo, thống kê và biểu đồ các kênh có ngưỡng, cấp hiện trạng, khảo sát.</p></form>
        <form class="panel" id="pdfEvent"><h3>Báo cáo sau sự kiện (bão)</h3>
          <label>Tên sự kiện<input name="title" value="Bão"></label>
          <div class="form-row"><label>Bắt đầu<input type="datetime-local" name="from" required></label><label>Kết thúc<input type="datetime-local" name="to" required></label></div>
          <label>Phạm vi<select name="sid"><option value="">Toàn cảng</option>${state.structures.map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join("")}</select></label>
          <div class="actions"><button class="primary" type="submit">Tải PDF</button></div>
          <p class="small muted">Sóng/gió/mực nước cực trị, thay đổi trước–sau ở từng kênh (trung vị 24 giờ), cảnh báo phát sinh.</p></form>
      </div>
      <div class="panel"><h3>Lịch gửi báo cáo PDF qua email</h3><div id="schedList" class="table-wrap"></div>
        ${can("engineer") ? `<form id="schedForm"><div class="form-row">
          <label>Tên<input name="name" required value="Báo cáo tháng"></label>
          <label>Công trình<select name="sid"><option value="">Tất cả (mỗi công trình một tệp)</option>${state.structures.map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join("")}</select></label>
          <label>Chu kỳ<select name="kind"><option value="monthly">Hằng tháng (ngày 1)</option><option value="weekly">Hằng tuần (thứ Hai)</option></select></label>
          <label>Email nhận (phân tách dấu phẩy)<input name="recipients" required></label></div>
          <div class="actions"><button class="primary" type="submit">Thêm lịch</button></div>
          <p class="small muted">Cần cấu hình SMTP trong .env của backend. Báo cáo gửi cho kỳ vừa kết thúc (tháng trước / tuần trước).</p></form>` : ""}</div>`;
    v.querySelectorAll("[data-dl]").forEach((b) => b.onclick = () => download(b.dataset.dl, b.dataset.fn));
    $("#dlAlerts").onclick = () => {
      const p = new URLSearchParams();
      if ($("#rFrom").value) p.set("from", new Date($("#rFrom").value).toISOString());
      if ($("#rTo").value) p.set("to", new Date($("#rTo").value + "T23:59:59").toISOString());
      download(`/api/reports/alerts?${p}`, "canh-bao.xlsx");
    };
    $("#dlMeas").onclick = () => download(`/api/reports/measurements?channel_id=${$("#rCh").value}`, "so-lieu.xlsx");
    $("#pdfStruct").onsubmit = (ev) => {
      ev.preventDefault();
      const f = new FormData(ev.target);
      const p = new URLSearchParams({ structure_id: f.get("sid"), from: localDayIso(f.get("from")), to: localDayIso(f.get("to"), true) });
      download(`/api/reports/structure.pdf?${p}`, `bao-cao-${f.get("to")}.pdf`);
    };
    $("#pdfEvent").onsubmit = (ev) => {
      ev.preventDefault();
      const f = new FormData(ev.target);
      const p = new URLSearchParams({ from: new Date(f.get("from")).toISOString(), to: new Date(f.get("to")).toISOString(), title: f.get("title") });
      if (f.get("sid")) p.set("structure_id", f.get("sid"));
      download(`/api/reports/event.pdf?${p}`, "bao-cao-su-kien.pdf");
    };
    const loadSched = async () => {
      const rows = await apiCall("/api/report-schedules");
      const sname = (id) => id ? (state.structures.find((x) => x.id === id)?.name || id) : "Tất cả";
      $("#schedList").innerHTML = rows.length ? `<table><thead><tr><th>Tên</th><th>Công trình</th><th>Chu kỳ</th><th>Người nhận</th><th>Gửi lần cuối</th><th></th></tr></thead><tbody>
        ${rows.map((r) => `<tr><td>${esc(r.name)}${r.active ? "" : ' <span class="tag">tắt</span>'}</td><td class="small">${esc(sname(r.structure_id))}</td>
          <td>${r.kind === "monthly" ? "Hằng tháng" : "Hằng tuần"}</td><td class="small">${esc(r.recipients)}</td><td class="small">${esc(fmtTime(r.last_sent_at))}</td>
          <td>${can("engineer") ? `<button type="button" data-send="${r.id}">Gửi ngay</button>` : ""}</td></tr>`).join("")}</tbody></table>` : `<p class="muted small">Chưa có lịch.</p>`;
      $("#schedList").querySelectorAll("[data-send]").forEach((b) => b.onclick = async () => {
        b.disabled = true;
        try { const r = await apiCall(`/api/report-schedules/${b.dataset.send}/send-now`, "POST"); toast(`Đã gửi ${r.sent_files} tệp tới ${r.recipients}`); loadSched(); }
        catch (e) { toast(e.message, true); b.disabled = false; }
      });
    };
    loadSched();
    const sf = $("#schedForm");
    if (sf) sf.onsubmit = async (ev) => {
      ev.preventDefault();
      const f = new FormData(sf);
      try {
        await apiCall("/api/report-schedules", "POST", { name: f.get("name"), kind: f.get("kind"), recipients: f.get("recipients"),
          structure_id: f.get("sid") ? Number(f.get("sid")) : null });
        toast("Đã thêm lịch gửi báo cáo"); loadSched();
      } catch (e) { toast(e.message, true); }
    };
  }

  // ============================================================ QUẢN TRỊ
  async function viewAdmin(v) {
    if (!can("admin")) { v.innerHTML = `<div class="panel"><p>Chỉ quản trị viên truy cập được.</p></div>`; return; }
    const [users, gws, logs] = await Promise.all([apiCall("/api/admin/users"), apiCall("/api/admin/gateways"),
      apiCall("/api/admin/audit?limit=100")]);
    v.innerHTML = `
      <div class="panel"><h3>Người dùng</h3><div class="table-wrap"><table>
        <thead><tr><th>Email</th><th>Vai trò</th><th>Thẩm quyền xác nhận</th><th>Nhận email</th><th>Trạng thái</th><th></th></tr></thead>
        <tbody>${users.map((u) => `<tr><td>${esc(u.email)}<br><span class="muted small">${esc(u.full_name)}</span></td>
          <td>${esc(ROLE[u.role])}</td><td>${u.can_approve ? "Có" : "Không"}</td><td>${u.notify_email ? "Có" : "Không"}</td>
          <td>${u.active ? "Hoạt động" : "Đã khoá"}</td>
          <td>${u.id !== state.user.id ? `<button type="button" data-toggle-user="${u.id}" data-active="${u.active}">${u.active ? "Khoá" : "Mở khoá"}</button>` : ""}</td></tr>`).join("")}</tbody></table></div>
        <form id="userForm"><h3>Thêm người dùng</h3><div class="form-row">
          <label>Email<input name="email" type="email" required></label><label>Họ tên<input name="full_name"></label>
          <label>Vai trò<select name="role">${Object.entries(ROLE).map(([k, n]) => `<option value="${k}">${n}</option>`).join("")}</select></label>
          <label>Mật khẩu (≥10 ký tự, có chữ và số)<input name="password" type="password" minlength="10" required autocomplete="new-password"></label></div>
          <label><input type="checkbox" name="can_approve">Kỹ sư có thẩm quyền xác nhận khuyến cáo hạn chế/dừng khai thác</label>
          <label><input type="checkbox" name="notify_email">Nhận email cảnh báo mức Cảnh báo trở lên</label>
          <div class="actions"><button class="primary" type="submit">Thêm người dùng</button></div></form></div>
      <div class="panel"><h3>Gateway (khoá API thiết bị)</h3><div class="table-wrap"><table>
        <thead><tr><th>Tên</th><th>Mã khoá</th><th>Lần gửi cuối</th><th>Trạng thái</th><th></th></tr></thead>
        <tbody>${gws.map((g) => `<tr><td>${esc(g.name)}</td><td class="small">${esc(g.key_prefix)}…</td><td class="small">${esc(fmtTime(g.last_seen_at))}</td>
          <td>${g.active ? "Hoạt động" : "Đã thu hồi"}</td>
          <td><div class="actions"><button type="button" data-rotate="${g.id}">Cấp khoá mới</button>
            <button type="button" class="danger" data-gw="${g.id}" data-active="${g.active}">${g.active ? "Thu hồi" : "Kích hoạt"}</button></div></td></tr>`).join("")}</tbody></table></div>
        <form id="gwForm" class="actions"><input name="name" placeholder="Tên gateway" required style="max-width:280px">
          <button class="primary" type="submit">Tạo gateway</button></form>
        <div id="newKey"></div></div>
      <div class="panel"><h3>Nhật ký kiểm toán (100 mục gần nhất)</h3><div class="table-wrap"><table>
        <thead><tr><th>Thời điểm</th><th>Người dùng</th><th>Thao tác</th><th>Đối tượng</th></tr></thead>
        <tbody>${logs.map((l) => `<tr><td class="small">${esc(fmtTime(l.ts))}</td><td class="small">${esc(users.find((u) => u.id === l.user_id)?.email || (l.gateway_id ? "gateway " + l.gateway_id : ""))}</td>
          <td>${esc(l.action)}</td><td class="small">${esc(l.entity)} ${esc(l.entity_id)}</td></tr>`).join("")}</tbody></table></div></div>`;
    const showKey = (g) => {
      $("#newKey").innerHTML = `<p><strong>Khoá API của ${esc(g.name)}</strong> — chỉ hiển thị một lần, hãy cấu hình vào gateway ngay:</p><p class="secret">${esc(g.api_key)}</p>`;
    };
    $("#userForm").onsubmit = async (ev) => {
      ev.preventDefault();
      const f = new FormData(ev.target);
      try {
        await apiCall("/api/admin/users", "POST", { email: f.get("email"), full_name: f.get("full_name"), role: f.get("role"),
          password: f.get("password"), can_approve: !!f.get("can_approve"), notify_email: !!f.get("notify_email") });
        toast("Đã thêm người dùng"); route();
      } catch (e) { toast(e.message, true); }
    };
    v.querySelectorAll("[data-toggle-user]").forEach((b) => b.onclick = async () => {
      try { await apiCall(`/api/admin/users/${b.dataset.toggleUser}`, "PUT", { active: b.dataset.active !== "true" }); route(); }
      catch (e) { toast(e.message, true); }
    });
    $("#gwForm").onsubmit = async (ev) => {
      ev.preventDefault();
      try { const g = await apiCall("/api/admin/gateways", "POST", { name: new FormData(ev.target).get("name") });
        await route(); showKey(g); } catch (e) { toast(e.message, true); }
    };
    v.querySelectorAll("[data-rotate]").forEach((b) => b.onclick = async () => {
      if (!confirm("Cấp khoá mới? Khoá cũ ngừng hoạt động ngay, gateway phải cập nhật khoá.")) return;
      try { const g = await apiCall(`/api/admin/gateways/${b.dataset.rotate}/rotate`, "POST"); await route(); showKey(g); }
      catch (e) { toast(e.message, true); }
    });
    v.querySelectorAll("[data-gw]").forEach((b) => b.onclick = async () => {
      const on = b.dataset.active !== "true";
      if (!on && !confirm("Thu hồi khoá? Gateway sẽ không gửi được số liệu.")) return;
      try { await apiCall(`/api/admin/gateways/${b.dataset.gw}?active=${on}`, "PUT"); route(); }
      catch (e) { toast(e.message, true); }
    });
  }

  // Máy chủ chính hoạt động lại (config.js phát sự kiện) → cập nhật nhãn, ẩn băng dự phòng.
  window.addEventListener("ose-backend-change", async () => {
    $("#backend").textContent = await backendLabel();
    showDegraded(false);
    toast("Đã kết nối lại máy chủ chính");
    if (state.user && state.tab === "dashboard") pollLive(true);
  });

  // ============================================================ khởi động
  async function boot() {
    $("#logout").onclick = () => {
      if (isGuest()) { clearInterval(state.timer); if (typeof stopLive === "function") stopLive(); state.user = null; renderLogin(); }
      else logout();
    };
    $("#backend").textContent = await backendLabel();
    try {
      const h = await apiCall("/api/health");
      showDegraded(h.mode === "degraded");
      state.publicView = !!h.public_view;
    } catch (e) { $("#backend").textContent = "Không kết nối được máy chủ"; }
    loadSession();
    if (state.token) {
      try { state.user = await apiCall("/api/auth/me"); saveSession(); await startApp(); return; }
      catch { /* hết hạn → đăng nhập lại */ }
    }
    if (state.publicView) { await startGuest(); return; }
    renderLogin();
  }
  boot();
})();
