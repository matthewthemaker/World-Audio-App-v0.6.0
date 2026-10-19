const $ = (id) => document.getElementById(id);
const statusEl = $("status");
const turn = $("turn"), lock = $("lock"), push = $("push"), autoBox = $("auto"), spread = $("spread");
const roomSel = $("room"), reverb = $("reverb"), volume = $("volume"), sway = $("sway");
const sAngle = $("sAngle"), sDist = $("sDist"), sVol = $("sVol");
const COLORS = {bass: "#e8738a", body: "#f0a35e", voice: "#8b93ff", presence: "#5ed1c0", air: "#c58bff", ambience: "#8aa0b8"};

// Display catalog (the audio engine in offscreen.js is what actually defines each scene and room).
const SCENES_UI = [
  {id: "living", name: "Living room", room: "living", desc: "The band is playing in your living room, a few steps away."},
  {id: "hall", name: "Concert hall", room: "hall", desc: "Front-row seat. The stage is ahead of you, the hall rings around you."},
  {id: "club", name: "Small club", room: "club", desc: "Up close at a club show. Tight room, short echo, loud and near."},
  {id: "studio", name: "Studio", room: "studio", desc: "You're standing in the recording room, with the players in a ring around you."},
  {id: "free", name: "Free", room: "none", desc: "No room. The AI follows the video's stereo picture, or you place everything."}
];
const ROOM_NAMES = {none: "No room (dry)", studio: "Recording studio", living: "Living room", club: "Small club", hall: "Concert hall", cathedral: "Cathedral"};

let state = null, selected = "voice", busyUntil = 0, synced = false;
let uiScene = "living", uiRoom = "living";

// ---------- bridge to the YouTube page (via the Android app) ----------
let nextCall = 1;
const pending = new Map();
window.__resolve = (id, raw) => {
  const done = pending.get(id);
  if (!done) return;
  pending.delete(id);
  let value = null;
  try { value = raw ? JSON.parse(raw) : null; } catch {}
  done(value);
};
const send = (msg) => new Promise((resolve) => {
  if (!window.Android) { resolve(null); return; }
  const id = nextCall++;
  pending.set(id, resolve);
  Android.call(id, JSON.stringify(msg));
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve(null); } }, 2500);
});

// ---------- status line ----------
let flashText = "", flashUntil = 0, lastAwake = null, lastBoot = null, wantOn = false;
function say(text, ms = 6000) { flashText = text; flashUntil = Date.now() + ms; renderStatus(); }
function statusText() {
  if (Date.now() < flashUntil) return flashText;
  if (!state) return "Waiting for the YouTube page to load…";
  const s = state.status || {};
  if (s.error) return s.error;
  if (!state.active) return "Ready. Open a video or song, then press Start World Audio.";
  if (s.drm) return "This stream is copy-protected, so it can't be placed in a world. It plays normally.";
  if (!s.hasMedia) return "World Audio is on. Waiting for a video or song, so press play.";
  if (s.ctx === "suspended") return "Android paused the audio engine. Tap Start World Audio again.";
  const name = SCENES_UI.find(x => x.id === state.world.scene)?.name || "";
  return `World Audio is on in the ${name.toLowerCase()} scene. Drag yourself on the map or use the pad to walk.`;
}
function renderStatus() { statusEl.textContent = statusText(); }
const busy = () => { busyUntil = Date.now() + 350; };

// ---------- scenes ----------
const sceneGrid = $("scenes");
for (const sc of SCENES_UI) {
  const b = document.createElement("button");
  b.dataset.scene = sc.id; b.textContent = sc.name;
  sceneGrid.appendChild(b);
}
for (const [id, name] of Object.entries(ROOM_NAMES)) {
  const o = document.createElement("option");
  o.value = id; o.textContent = name;
  roomSel.appendChild(o);
}
function updateScene() {
  for (const b of sceneGrid.children) b.classList.toggle("on", b.dataset.scene === uiScene);
  $("sceneDesc").textContent = SCENES_UI.find(s => s.id === uiScene)?.desc || "";
  roomSel.value = uiRoom;
}
sceneGrid.addEventListener("click", (e) => {
  const b = e.target.closest("button[data-scene]");
  if (!b) return;
  uiScene = b.dataset.scene;
  uiRoom = SCENES_UI.find(s => s.id === uiScene).room;
  updateScene();
  if (state) {
    state.world.scene = uiScene; state.world.room = uiRoom;
    state.stems.forEach(s => { s.manual = false; });
  }
  send({type: "SET_WORLD", patch: {scene: uiScene, room: uiRoom}});
  render();
});
roomSel.addEventListener("input", () => {
  uiRoom = roomSel.value;
  if (state) state.world.room = uiRoom;
  send({type: "SET_WORLD", patch: {room: uiRoom}});
  render();
});

// ---------- master controls ----------
function updateWorldLabels() {
  $("turnVal").textContent = `${turn.value}°`;
  $("pushVal").textContent = `+${Number(push.value).toFixed(1)} m`;
  $("lockText").textContent = lock.checked ? "ON" : "OFF";
  $("autoText").textContent = autoBox.checked ? "ON" : "OFF";
  $("swayText").textContent = sway.checked ? "ON" : "OFF";
  $("spreadVal").textContent = `${spread.value}%`;
  $("reverbVal").textContent = `${reverb.value}%`;
  $("volumeVal").textContent = `${volume.value}%`;
}
function sendWorld() {
  updateWorldLabels();
  send({type: "SET_WORLD", patch: {
    listenerYaw: Number(turn.value), worldLock: lock.checked,
    distanceOffset: Number(push.value), auto: autoBox.checked, spread: Number(spread.value) / 100,
    reverb: Number(reverb.value) / 100, volume: Number(volume.value) / 100, sway: sway.checked,
    scene: uiScene, room: uiRoom
  }});
}
["turn", "lock", "push", "auto", "spread", "reverb", "volume", "sway"].forEach(id => $(id).addEventListener("input", sendWorld));

function syncMaster() {
  const w = state.world;
  turn.value = w.listenerYaw; lock.checked = w.worldLock; push.value = w.distanceOffset;
  autoBox.checked = w.auto; spread.value = Math.round(w.spread * 100);
  reverb.value = Math.round(w.reverb * 100); volume.value = Math.round(w.volume * 100); sway.checked = w.sway;
  uiScene = w.scene; uiRoom = w.room;
  updateWorldLabels(); updateScene();
}

// ---------- start / stop / reset ----------
$("start").addEventListener("click", async () => {
  say("Starting World Audio…", 3000);
  const result = await send({type: "START_WORLD_AUDIO"});
  if (result?.ok) {
    wantOn = true;
    flashUntil = 0;
    sendWorld();
    if (result.state) state = result.state;
    renderStatus();
  } else if (!result) {
    say("The YouTube page isn't ready yet. Wait for it to load, then try again.");
  } else {
    say(result.error || "Could not start World Audio.");
  }
});
$("stop").addEventListener("click", async () => {
  wantOn = false;
  await send({type: "STOP_WORLD_AUDIO"});
  say("World Audio stopped. The video is playing normally again.");
});
$("reset").addEventListener("click", async () => {
  turn.value = 0; push.value = 0; lock.checked = true; autoBox.checked = true; spread.value = 50;
  reverb.value = 100; volume.value = 100; sway.checked = true;
  uiScene = "living"; uiRoom = "living";
  updateWorldLabels(); updateScene();
  await send({type: "RESET_WORLD"});
  synced = false;
  say("World reset to the living room. AI auto-placement is on and every sound is back under its control.");
});

// ---------- sound list ----------
const list = $("stems");
function buildList() {
  list.innerHTML = "";
  for (const s of state.stems) {
    const row = document.createElement("div");
    row.className = "stem"; row.dataset.id = s.id;
    row.innerHTML = `<span class="dot" style="background:${COLORS[s.id]}"></span><span class="nm"></span>` +
      `<span class="meter"><i style="background:${COLORS[s.id]}"></i></span>` +
      `<button class="mini" data-act="mute" title="Mute">M</button>` +
      `<button class="mini" data-act="solo" title="Solo">S</button>` +
      `<button class="mini" data-act="auto" title="AI-placed, or pinned where you put it"></button>`;
    list.appendChild(row);
  }
}
list.addEventListener("click", (e) => {
  const row = e.target.closest(".stem");
  if (!row || !state) return;
  const id = row.dataset.id, st = state.stems.find(s => s.id === id);
  const act = e.target.dataset?.act;
  if (act === "mute") { st.mute = !st.mute; send({type: "SET_STEM", id, patch: {mute: st.mute}}); }
  else if (act === "solo") { st.solo = !st.solo; send({type: "SET_STEM", id, patch: {solo: st.solo}}); }
  else if (act === "auto") { st.manual = !st.manual; send({type: "SET_STEM", id, patch: {manual: st.manual}}); }
  else { selected = id; busyUntil = 0; }
  render();
});

// ---------- selected sound sliders ----------
function sendStem(patch) {
  busy();
  const st = state?.stems.find(s => s.id === selected);
  if (st) {
    Object.assign(st, patch);
    if ("azimuth" in patch || "distance" in patch) st.manual = true;
  }
  send({type: "SET_STEM", id: selected, patch});
  render();
}
sAngle.addEventListener("input", () => sendStem({azimuth: Number(sAngle.value)}));
sDist.addEventListener("input", () => sendStem({distance: Number(sDist.value)}));
sVol.addEventListener("input", () => sendStem({volume: Number(sVol.value) / 100}));

// ---------- radar ----------
const cv = $("radar"), g = cv.getContext("2d");
let W = 298, H = 260;
const dpr = window.devicePixelRatio || 1;
function resizeRadar() {
  W = Math.max(200, Math.round(cv.clientWidth || 298));
  H = Math.round(cv.clientHeight || 260);
  cv.width = W * dpr; cv.height = H * dpr;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
}
resizeRadar();
window.addEventListener("resize", () => { resizeRadar(); render(); });
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
let dots = {}, youPos = null, dragStem = null, dragYou = false, dragPos = null;

// World coordinates: x = right, z = back (the stage is at negative z). The map is zoomed to fit the room.
function view() {
  const gm = state?.roomGeom;
  if (gm && gm.w > 0) return {s: clamp(Math.min((W - 24) / gm.w, (H - 24) / gm.h), 6, 28), zc: (1 - 2 * gm.ly) * gm.h / 2};
  return {s: (Math.min(W, H) / 2 - 14) / 12, zc: 0};
}
const toScr = (x, z, v) => ({x: W / 2 + x * v.s, y: H / 2 + (z - v.zc) * v.s});
const fromScr = (px, py, v) => ({x: (px - W / 2) / v.s, z: (py - H / 2) / v.s + v.zc});
function clampPos(x, z) {
  const gm = state?.roomGeom;
  if (gm && gm.w > 0) return {x: clamp(x, -gm.w / 2 + .3, gm.w / 2 - .3), z: clamp(z, -gm.ly * gm.h + .3, (1 - gm.ly) * gm.h - .3)};
  return {x: clamp(x, -12, 12), z: clamp(z, -12, 12)};
}
function effD(st) { return Math.max(1, st.distance + (state.world.distanceOffset || 0)); }
function stemWorld(st) {
  const a = st.azimuth * Math.PI / 180, d = effD(st);
  return {x: Math.sin(a) * d, z: -Math.cos(a) * d};
}
function ensureLock() {
  if (lock.checked) return;
  lock.checked = true;
  sendWorld();
  say("World Lock turned on so you can walk around.");
}

function drawRadar() {
  g.clearRect(0, 0, W, H);
  const v = view(), gm = state?.roomGeom;
  if (state?.active && gm && gm.w > 0) {
    const tl = toScr(-gm.w / 2, -gm.ly * gm.h, v);
    g.fillStyle = "rgba(139,147,255,0.06)";
    g.strokeStyle = "#3a4562"; g.lineWidth = 1.5; g.setLineDash([5, 4]);
    g.beginPath();
    if (g.roundRect) g.roundRect(tl.x, tl.y, gm.w * v.s, gm.h * v.s, 8); else g.rect(tl.x, tl.y, gm.w * v.s, gm.h * v.s);
    g.fill(); g.stroke(); g.setLineDash([]);
    g.fillStyle = "#6f7b92"; g.font = "10px system-ui, sans-serif"; g.textAlign = "left";
    g.fillText(ROOM_NAMES[state.world.room] || "", 5, H - 3);
  }
  const o = toScr(0, 0, v);
  g.strokeStyle = "#262d3d"; g.lineWidth = 1;
  for (const m of [4, 8, 12]) { g.beginPath(); g.arc(o.x, o.y, m * v.s, 0, Math.PI * 2); g.stroke(); }
  g.fillStyle = "#6f7b92"; g.font = "10px system-ui, sans-serif"; g.textAlign = "center";
  g.fillText("front", W / 2, 10);
  g.textAlign = "left"; g.fillText("L", 4, H / 2 - 4); g.textAlign = "right"; g.fillText("R", W - 4, H / 2 - 4);

  if (!state || !state.active) {
    g.fillStyle = "#8a96ab"; g.font = "12px system-ui, sans-serif"; g.textAlign = "center";
    g.fillText("Start World Audio to see the sounds", W / 2, H / 2 + 4);
    dots = {}; youPos = null;
    return;
  }

  dots = {};
  for (const st of state.stems) {
    const w = stemWorld(st), p = toScr(w.x, w.z, v);
    dots[st.id] = p;
    const rad = 5 + Math.min(1, Math.sqrt(st.level) * 2.2) * 6;
    const silent = st.mute || (state.stems.some(s => s.solo) && !st.solo);
    g.globalAlpha = silent ? 0.3 : 1;
    g.fillStyle = COLORS[st.id];
    g.beginPath(); g.arc(p.x, p.y, rad, 0, Math.PI * 2); g.fill();
    if (st.manual || st.id === selected) {
      g.lineWidth = st.id === selected ? 2.5 : 1.5;
      g.strokeStyle = st.id === selected ? "#ffffff" : "#e6c46e";
      g.beginPath(); g.arc(p.x, p.y, rad + 2, 0, Math.PI * 2); g.stroke();
    }
    g.globalAlpha = 1;
  }

  // you: the white arrow (position + which way you face)
  const lockOn = state.world.worldLock;
  const lx = lockOn ? state.world.listenerX : 0, lz = lockOn ? state.world.listenerZ : 0;
  youPos = toScr(lx, lz, v);
  g.save(); g.translate(youPos.x, youPos.y);
  g.rotate((lockOn ? state.world.listenerYaw : 0) * Math.PI / 180);
  g.fillStyle = "#f2f4f8"; g.strokeStyle = "#10131a"; g.lineWidth = 1.5;
  g.beginPath(); g.moveTo(0, -10); g.lineTo(7, 7); g.lineTo(0, 3.5); g.lineTo(-7, 7); g.closePath(); g.stroke(); g.fill();
  g.restore();
}

function canvasPt(e) {
  const b = cv.getBoundingClientRect();
  return {x: (e.clientX - b.left) * (W / b.width), y: (e.clientY - b.top) * (H / b.height)};
}
function moveDot(p) {
  const st = state?.stems.find(s => s.id === dragStem);
  if (!st) return;
  const w = fromScr(p.x, p.y, view());
  const az = Math.round(Math.atan2(w.x, -w.z) * 180 / Math.PI);
  const eff = clamp(Math.hypot(w.x, w.z), 1, 12);
  const dist = clamp(Math.round((eff - (state.world.distanceOffset || 0)) * 10) / 10, 1, 12);
  sendStem({azimuth: az, distance: dist});
}
function moveYou(p) {
  const w = fromScr(p.x, p.y, view());
  const c = clampPos(w.x, w.z);
  dragPos = c;
  state.world.listenerX = c.x; state.world.listenerZ = c.z;
  send({type: "SET_WORLD", patch: {listenerX: c.x, listenerZ: c.z}});
}
cv.addEventListener("pointerdown", (e) => {
  if (!state?.active) return;
  const p = canvasPt(e);
  let best = null, bd = 20, isYou = false;
  for (const [id, d] of Object.entries(dots)) {
    const dist = Math.hypot(d.x - p.x, d.y - p.y);
    if (dist < bd) { bd = dist; best = id; }
  }
  if (youPos) {
    const dy = Math.hypot(youPos.x - p.x, youPos.y - p.y) * 0.7; // slight priority for grabbing yourself
    if (dy < Math.min(bd, 16)) { isYou = true; }
  }
  if (isYou) {
    ensureLock();
    dragYou = true; cv.setPointerCapture(e.pointerId); cv.style.cursor = "grabbing"; moveYou(p);
    return;
  }
  if (!best) return;
  selected = best; dragStem = best;
  cv.setPointerCapture(e.pointerId);
  cv.style.cursor = "grabbing";
  moveDot(p);
});
cv.addEventListener("pointermove", (e) => {
  if (dragStem) moveDot(canvasPt(e));
  else if (dragYou) moveYou(canvasPt(e));
});
const endDrag = () => { dragStem = null; dragYou = false; dragPos = null; cv.style.cursor = "grab"; };
cv.addEventListener("pointerup", endDrag);
cv.addEventListener("pointercancel", endDrag);

// ---------- go-to spots ----------
const spotsEl = $("spots");
let spotsKey = "";
function renderSpots() {
  const sp = state?.spots || [];
  const key = sp.map(s => `${s.id}${s.x}${s.z}`).join("|");
  if (key === spotsKey) return;
  spotsKey = key;
  spotsEl.innerHTML = "";
  for (const s of sp) {
    const b = document.createElement("button");
    b.className = "chip"; b.dataset.id = s.id; b.textContent = s.name;
    spotsEl.appendChild(b);
  }
}
spotsEl.addEventListener("click", (e) => {
  const b = e.target.closest("button.chip");
  const s = b && state?.spots.find(x => x.id === b.dataset.id);
  if (!s) return;
  ensureLock();
  turn.value = s.yaw; updateWorldLabels();
  send({type: "SET_WORLD", patch: {listenerX: s.x, listenerZ: s.z, listenerYaw: s.yaw}});
});

// ---------- walking with the keyboard ----------
const keys = new Set();
document.addEventListener("keydown", (e) => {
  const k = e.key.toLowerCase();
  if (k.length === 1 && "wasdqe".includes(k) && e.target.tagName !== "SELECT" && !e.ctrlKey && !e.metaKey && !e.altKey) {
    keys.add(k); e.preventDefault();
  }
});
document.addEventListener("keyup", (e) => keys.delete(e.key.toLowerCase()));
window.addEventListener("blur", () => keys.clear());
const padEl = $("pad");
const padUp = (e) => { const b = e.target.closest?.("button[data-k]"); if (b) { keys.delete(b.dataset.k); b.classList.remove("down"); } };
padEl.addEventListener("pointerdown", (e) => {
  const b = e.target.closest("button[data-k]");
  if (!b) return;
  e.preventDefault();
  b.setPointerCapture(e.pointerId);
  keys.add(b.dataset.k); b.classList.add("down");
});
["pointerup", "pointercancel", "lostpointercapture"].forEach(ev => padEl.addEventListener(ev, padUp));
padEl.addEventListener("contextmenu", (e) => e.preventDefault());
let lastT = performance.now(), walk = null;
setInterval(() => {
  const now = performance.now(), dt = Math.min(0.1, (now - lastT) / 1000);
  lastT = now;
  if (!state?.active || !keys.size) { walk = null; return; }
  ensureLock();
  let yaw = Number(turn.value);
  if (keys.has("q")) yaw -= 90 * dt;
  if (keys.has("e")) yaw += 90 * dt;
  yaw = ((yaw + 540) % 360) - 180;
  const fw = (keys.has("w") ? 1 : 0) - (keys.has("s") ? 1 : 0);
  const st = (keys.has("d") ? 1 : 0) - (keys.has("a") ? 1 : 0);
  if (!walk) walk = {x: state.world.listenerX, z: state.world.listenerZ};
  const y = yaw * Math.PI / 180, speed = 1.6 * dt;
  walk.x += (Math.sin(y) * fw + Math.cos(y) * st) * speed;
  walk.z += (-Math.cos(y) * fw + Math.sin(y) * st) * speed;
  const c = clampPos(walk.x, walk.z);
  walk.x = c.x; walk.z = c.z;
  turn.value = yaw; updateWorldLabels();
  send({type: "SET_WORLD", patch: {listenerX: c.x, listenerZ: c.z, listenerYaw: yaw}});
}, 33);

// ---------- render ----------
function render() {
  drawRadar();
  renderSpots();
  if (!state) return;
  if (!list.children.length) buildList();
  const anySolo = state.stems.some(s => s.solo);
  for (const row of list.children) {
    const st = state.stems.find(s => s.id === row.dataset.id);
    if (!st) continue;
    row.classList.toggle("sel", st.id === selected);
    row.querySelector(".nm").textContent = st.label;
    row.querySelector(".meter i").style.width = `${Math.min(100, Math.sqrt(st.level) * 220)}%`;
    const [m, s, a] = row.querySelectorAll("button");
    m.className = "mini" + (st.mute ? " warn" : "");
    s.className = "mini" + (st.solo ? " on" : "");
    a.className = "mini" + (st.manual ? " pin" : " on");
    a.textContent = st.manual ? "Pinned" : "AI";
    row.style.opacity = (st.mute || (anySolo && !st.solo)) ? 0.5 : 1;
  }
  const st = state.stems.find(s => s.id === selected);
  if (!st) return;
  $("detailName").textContent = st.label;
  if (Date.now() > busyUntil && !dragStem) {
    sAngle.value = Math.round(st.azimuth); sDist.value = st.distance; sVol.value = Math.round(st.volume * 100);
  }
  $("sAngleVal").textContent = `${Math.round(st.azimuth)}°`;
  $("sDistVal").textContent = `${st.distance.toFixed(1)} m`;
  $("sVolVal").textContent = `${Math.round(st.volume * 100)}%`;
}

async function poll() {
  const r = await send({type: "GET_STATE"});
  const prev = state;
  state = r?.state || null;
  if (!state) synced = false;
  const awake = !!(state && state.active);
  if (awake !== lastAwake && window.Android) { lastAwake = awake; Android.keepAwake(awake); }
  if (state && dragStem && prev) {
    // keep the dragged dot under the pointer until the audio side catches up
    const a = prev.stems.find(s => s.id === dragStem), b = state.stems.find(s => s.id === dragStem);
    if (a && b) { b.azimuth = a.azimuth; b.distance = a.distance; b.manual = true; }
  }
  if (state && dragYou && dragPos) { state.world.listenerX = dragPos.x; state.world.listenerZ = dragPos.z; }
  if (state?.status && state.status.boot !== lastBoot) {
    // A new YouTube page (reload, or switching between YouTube and YouTube Music): carry the panel's settings over.
    const first = lastBoot === null;
    lastBoot = state.status.boot;
    if (!first) {
      sendWorld();
      if (wantOn && !state.status.wantActive) send({type: "START_WORLD_AUDIO"});
      synced = true;
    }
  }
  if (state && !synced) { syncMaster(); synced = true; }
  render();
  renderStatus();
  setTimeout(poll, 100);
}
updateWorldLabels();
updateScene();
poll();
