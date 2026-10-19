/* OSE backend selector: home server first, Render as fallback. */
(function () {
  if (window.oseFetch) return; // already loaded
  const BACKENDS = {
    home:   "https://api-port-shm.ose.vn",
    render: "https://ose-port-shm-backend.onrender.com",
    local:  "http://127.0.0.1:8017",
  };
  const CACHE_KEY = "ose_api_auto";
  const CACHE_MS = 5 * 60 * 1000;
  let auto = false;
  const set = (base) => (window.OSE_API_BASE = base);

  function remember(name) {
    try { sessionStorage.setItem(CACHE_KEY, JSON.stringify({ name, t: Date.now() })); } catch (e) {}
  }
  function recalled() {
    try {
      const c = JSON.parse(sessionStorage.getItem(CACHE_KEY));
      if (c && BACKENDS[c.name] && Date.now() - c.t < CACHE_MS) return c.name;
    } catch (e) {}
    return null;
  }
  async function alive(base, ms) {
    const c = new AbortController(); const t = setTimeout(() => c.abort(), ms);
    try { return (await fetch(base + "/api/health", { signal: c.signal, cache: "no-store" })).ok; }
    catch (e) { return false; } finally { clearTimeout(t); }
  }

  function resolve() {
    if (["localhost", "127.0.0.1"].includes(location.hostname)) return Promise.resolve(set(BACKENDS.local));
    // ?api=home | render | local (ghim)   ?api=auto (bỏ ghim)
    let forced = new URLSearchParams(location.search).get("api");
    try {
      if (forced === "auto") { localStorage.removeItem("ose_api"); forced = null; }
      else if (forced && BACKENDS[forced]) localStorage.setItem("ose_api", forced);
      else if (forced) forced = null;
      else forced = localStorage.getItem("ose_api");
    } catch (e) {}
    if (forced && BACKENDS[forced]) return Promise.resolve(set(BACKENDS[forced]));

    auto = true;
    const cached = recalled();
    if (cached) { if (cached === "render") watchHome(); return Promise.resolve(set(BACKENDS[cached])); }
    set(BACKENDS.home);
    return (async () => {
      // thử hai lần (Tunnel/Worker đôi khi chậm ở lần gọi đầu)
      if (await alive(BACKENDS.home, 8000) || await alive(BACKENDS.home, 8000)) { remember("home"); return BACKENDS.home; }
      console.warn("[OSE] Máy chủ chính không phản hồi, chuyển sang Render");
      remember("render");
      watchHome();
      return set(BACKENDS.render);
    })();
  }

  // Đang ở Render: mỗi 60 giây kiểm tra máy chủ chính, có lại thì tự quay về.
  let watching = null;
  function watchHome() {
    if (watching || !auto) return;
    watching = setInterval(async () => {
      if (document.hidden || !(await alive(BACKENDS.home, 8000))) return;
      clearInterval(watching); watching = null;
      remember("home");
      window.OSE_API_READY = Promise.resolve(set(BACKENDS.home));
      console.info("[OSE] Máy chủ chính đã hoạt động lại");
      window.dispatchEvent(new CustomEvent("ose-backend-change", { detail: { base: BACKENDS.home, name: "home" } }));
    }, 60000);
  }

  window.OSE_API_READY = resolve();

  // Dùng thay cho fetch(): oseFetch("/api/xxx", options). Home chết giữa phiên -> gửi lại sang Render.
  window.oseFetch = async function (path, options) {
    const base = await window.OSE_API_READY;
    const canFailover = auto && base === BACKENDS.home;
    try {
      const res = await fetch(base + path, options);
      if (!canFailover || ![502, 503, 504].includes(res.status)) return res;
    } catch (e) {
      if (!canFailover) throw e;
    }
    console.warn("[OSE] Máy chủ chính mất kết nối, chuyển sang Render");
    remember("render");
    window.OSE_API_READY = Promise.resolve(set(BACKENDS.render));
    watchHome();
    return fetch(BACKENDS.render + path, options);
  };
})();
