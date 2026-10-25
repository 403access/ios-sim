export const webHtml = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>iOS Sim Bridge</title>
<style>
  :root { color-scheme: dark; --bg:#0b0d12; --panel:#151922; --line:#2a3040; --text:#e7eaf2; --muted:#8b93a7; --accent:#6ea8fe; --ok:#3ddc97; --bad:#ff6b6b; }
  * { box-sizing: border-box; }
  body { margin:0; font:14px/1.5 ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif; background:var(--bg); color:var(--text); }
  header { display:flex; gap:12px; align-items:center; padding:12px 16px; border-bottom:1px solid var(--line); background:var(--panel); position:sticky; top:0; z-index:2; flex-wrap:wrap; }
  h1 { font-size:15px; margin:0 12px 0 0; letter-spacing:.02em; }
  select, input, button { font:inherit; color:var(--text); background:#0f131b; border:1px solid var(--line); border-radius:8px; padding:7px 10px; }
  button { cursor:pointer; }
  button:hover { border-color:var(--accent); }
  button.primary { background:var(--accent); border-color:var(--accent); color:#07101f; font-weight:600; }
  main { display:grid; grid-template-columns:minmax(0,1fr) 290px; gap:16px; padding:16px; align-items:start; }
  @media (max-width: 900px) { main { grid-template-columns:1fr; } }
  .screen-wrap { background:var(--panel); border:1px solid var(--line); border-radius:14px; padding:14px; display:flex; justify-content:center; min-height:300px; }
  #screen { max-width:100%; max-height:76vh; border-radius:10px; touch-action:none; cursor:crosshair; background:#000; }
  aside { display:flex; flex-direction:column; gap:12px; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:14px; padding:14px; }
  .row { display:flex; gap:8px; align-items:center; }
  .row > * { min-width:0; }
  .row input { flex:1; }
  .muted { color:var(--muted); font-size:12px; }
  .status { display:inline-flex; gap:6px; align-items:center; }
  .dot { width:8px; height:8px; border-radius:50%; background:var(--bad); }
  .dot.on { background:var(--ok); }
  .grid { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
  #logs { max-height:180px; overflow:auto; white-space:pre-wrap; font:11px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; color:#b9c2d6; margin:8px 0 0; }
  #tokenbar { display:none; padding:10px 16px; background:#241b1b; border-bottom:1px solid #5a2e2e; gap:8px; align-items:center; }
  #tokenbar.show { display:flex; }
  .pill { font:11px ui-monospace, monospace; color:var(--muted); border:1px solid var(--line); border-radius:999px; padding:2px 8px; }
</style>
</head>
<body>
<header>
  <h1>iOS Sim Bridge</h1>
  <select id="device" aria-label="Simulator"></select>
  <button id="refresh">Refresh</button>
  <span class="status"><span class="dot" id="dot"></span><span id="status" class="muted">connecting</span></span>
  <span class="pill" id="meta">-</span>
</header>
<div id="tokenbar">
  <span>Access token</span>
  <input id="token" type="password" placeholder="token from ios-sim-host" />
  <button id="save-token">Save</button>
</div>
<main>
  <section class="screen-wrap">
    <img id="screen" alt="Simulator screen" />
  </section>
  <aside>
    <div class="card">
      <div class="row"><input id="text" placeholder="Type into the simulator" /><button id="send-text" class="primary">Send</button></div>
      <p class="muted">Click to tap, drag to swipe. Coordinates are normalised, so the stream can be any size.</p>
    </div>
    <div class="card grid">
      <button data-button="home">Home</button>
      <button data-button="lock">Lock</button>
      <button data-button="side">Side button</button>
      <button data-button="siri">Siri</button>
    </div>
    <div class="card">
      <div class="row"><button id="toggle-logs">Show logs</button><button id="reconnect">Reconnect</button></div>
      <pre id="logs" hidden></pre>
    </div>
  </aside>
</main>
<script>
  const params = new URLSearchParams(location.search);
  let token = params.get("token") || sessionStorage.getItem("ios-sim-token") || "";
  let socket;
  let currentDevice;
  let dragStart;
  let frameUrl;
  let logSource;

  const $ = (id) => document.getElementById(id);
  const status = (text, ok) => { $("status").textContent = text; $("dot").classList.toggle("on", !!ok); };

  if (params.has("token")) sessionStorage.setItem("ios-sim-token", token);
  if (!token) $("tokenbar").classList.add("show");

  function authHeaders(extra) {
    return token ? Object.assign({ authorization: "Bearer " + token }, extra || {}) : (extra || {});
  }

  async function api(path, options) {
    options = options || {};
    options.headers = authHeaders(options.headers);
    const response = await fetch(path, options);
    if (response.status === 401) {
      $("tokenbar").classList.add("show");
      throw new Error("unauthorized");
    }
    if (!response.ok) {
      const body = await response.text();
      throw new Error(body || response.statusText);
    }
    return response.status === 204 ? null : response.json();
  }

  async function refresh() {
    try {
      const [health, data] = await Promise.all([api("/v1/health"), api("/v1/devices")]);
      const select = $("device");
      const previous = currentDevice || sessionStorage.getItem("ios-sim-device");
      select.textContent = "";
      for (const device of data.devices) {
        const option = document.createElement("option");
        option.value = device.udid;
        option.textContent = device.name + " · " + device.runtime + " · " + device.state;
        select.appendChild(option);
      }
      const chosen = data.devices.find((d) => d.udid === previous) || data.devices.find((d) => d.state === "Booted") || data.devices[0];
      if (chosen) { select.value = chosen.udid; connect(chosen.udid); }
      $("meta").textContent = health.backend + " · " + (health.capabilities.input ? "input ready" : "view only");
      if (!health.capabilities.input) status("input unavailable (install idb on host)", false);
    } catch (error) {
      status(String(error.message || error), false);
    }
  }

  function connect(udid) {
    if (!udid) return;
    currentDevice = udid;
    sessionStorage.setItem("ios-sim-device", udid);
    if (socket) socket.close();
    if (logSource) { logSource.close(); logSource = undefined; }
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    let url = protocol + "//" + location.host + "/v1/devices/" + encodeURIComponent(udid) + "/stream?fps=4&format=jpeg";
    if (token) url += "&token=" + encodeURIComponent(token);
    status("connecting", false);
    socket = new WebSocket(url);
    socket.binaryType = "blob";
    socket.onopen = () => status("streaming", true);
    socket.onclose = (event) => status(event.code === 1000 ? "closed" : "disconnected", false);
    socket.onerror = () => status("connection error", false);
    socket.onmessage = (event) => {
      if (typeof event.data === "string") {
        try {
          const message = JSON.parse(event.data);
          if (message.type === "config" && message.display) {
            $("meta").textContent = message.display.widthPx + "×" + message.display.heightPx + " px · " + message.fps + " fps";
          }
        } catch (_) {}
        return;
      }
      const next = URL.createObjectURL(event.data);
      const image = $("screen");
      image.onload = () => { if (frameUrl) URL.revokeObjectURL(frameUrl); frameUrl = next; };
      image.src = next;
    };
  }

  function normalized(event) {
    const rect = $("screen").getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    const y = Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height));
    return { x, y };
  }

  async function sendInput(event) {
    if (!currentDevice) return;
    try {
      await api("/v1/devices/" + encodeURIComponent(currentDevice) + "/input", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(event)
      });
    } catch (error) {
      status("input failed: " + error.message, false);
    }
  }

  $("screen").addEventListener("pointerdown", (event) => { dragStart = normalized(event); $("screen").setPointerCapture(event.pointerId); });
  $("screen").addEventListener("pointerup", (event) => {
    if (!dragStart) return;
    const end = normalized(event);
    const dx = end.x - dragStart.x;
    const dy = end.y - dragStart.y;
    if (Math.hypot(dx, dy) > 0.02) {
      sendInput({ type: "swipe", from: dragStart, to: end, durationMs: 260 });
    } else {
      sendInput({ type: "tap", x: end.x, y: end.y });
    }
    dragStart = undefined;
  });
  $("device").addEventListener("change", (event) => connect(event.target.value));
  $("refresh").addEventListener("click", refresh);
  $("reconnect").addEventListener("click", () => connect(currentDevice));
  $("send-text").addEventListener("click", () => {
    const value = $("text").value;
    if (value) sendInput({ type: "text", text: value });
    $("text").value = "";
  });
  $("text").addEventListener("keydown", (event) => { if (event.key === "Enter") $("send-text").click(); });
  document.querySelectorAll("[data-button]").forEach((button) => button.addEventListener("click", () => sendInput({ type: "button", button: button.dataset.button })));
  $("save-token").addEventListener("click", () => {
    token = $("token").value.trim();
    sessionStorage.setItem("ios-sim-token", token);
    $("tokenbar").classList.remove("show");
    refresh();
  });
  $("toggle-logs").addEventListener("click", () => {
    const logs = $("logs");
    if (!logs.hidden) { logs.hidden = true; if (logSource) logSource.close(); logSource = undefined; return; }
    logs.hidden = false;
    logs.textContent = "";
    let url = "/v1/devices/" + encodeURIComponent(currentDevice) + "/logs?level=info";
    if (token) url += "&token=" + encodeURIComponent(token);
    logSource = new EventSource(url);
    logSource.onmessage = (event) => {
      logs.textContent += event.data + "\n";
      logs.scrollTop = logs.scrollHeight;
    };
    logSource.onerror = () => { logs.textContent += "[log stream closed]\n"; };
  });

  refresh();
</script>
</body>
</html>`;
