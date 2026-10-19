// World Audio Mobile 0.6 engine. Injected into the YouTube / YouTube Music page by the Android app.
// It is the 0.5 engine from the Chrome extension, with one change in where the audio comes from:
// instead of capturing a browser tab, it wraps the page's own <video>/<audio> element with Web Audio.
// Because the element's sound is routed through this graph, the original audio is replaced (not doubled).
//
// Pipeline: media element -> stereo split -> 5 frequency "stems" + 1 ambience (side) stem.
// Each stem is analysed ~20x/second (level, stereo position, stereo correlation, punch).
// The analysis labels each stem and, in Auto mode, places it in the 3D world.
// The listener has a position in the room (and a facing). Sounds stay where they are on the
// stage; what you hear is calculated relative to where you stand.
// Every scene puts the stems on a stage inside a virtual room. Each stem is HRTF-positioned,
// gets distance-based air absorption, and feeds a room reverb whose impulse response is
// generated for the chosen room (living room, studio, club, hall...).

(function () {
if (window.__WA) return;

const PI = Math.PI;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

const BANDS = [
  {id: "bass",     name: "Bass",            lo: 20,   hi: 160,   elev: -0.3, spreadDeg: 0,   sendBias: 0.3},
  {id: "body",     name: "Low instruments", lo: 160,  hi: 700,   elev: -0.1, spreadDeg: -40, sendBias: 0.8},
  {id: "voice",    name: "Voice / lead",    lo: 700,  hi: 3500,  elev: 0,    spreadDeg: 0,   sendBias: 1},
  {id: "presence", name: "Presence",        lo: 3500, hi: 8000,  elev: 0.2,  spreadDeg: 40,  sendBias: 1},
  {id: "air",      name: "Cymbals / air",   lo: 8000, hi: 20000, elev: 0.5,  spreadDeg: -70, sendBias: 1}
];
const AMBIENCE = {id: "ambience", name: "Ambience / room", elev: 0.3, spreadDeg: 0, sendBias: 1.6};

// Rooms: reverb time, pre-delay, how dark the tail gets, early-reflection taps [ms, gain].
const ROOMS = {
  none:      {name: "No room (dry)",    rt60: 0,    pre: 0,     wet: 0,    rolloff: 0.4,  damp: [0.5, 0.2],   taps: []},
  studio:    {name: "Recording studio", rt60: 0.24, pre: 0.002, wet: 0.32, rolloff: 0.25, damp: [0.55, 0.2],  taps: [[3, .5], [5, .4], [8, .3], [12, .22]]},
  living:    {name: "Living room",      rt60: 0.45, pre: 0.004, wet: 0.55, rolloff: 0.28, damp: [0.5, 0.15],  taps: [[6, .5], [9, .45], [13, .38], [18, .3], [24, .24], [33, .18]]},
  club:      {name: "Small club",       rt60: 0.9,  pre: 0.010, wet: 0.6,  rolloff: 0.22, damp: [0.45, 0.12], taps: [[11, .5], [16, .42], [23, .36], [31, .3], [42, .24]]},
  hall:      {name: "Concert hall",     rt60: 2.3,  pre: 0.032, wet: 0.7,  rolloff: 0.18, damp: [0.4, 0.08],  taps: [[24, .5], [33, .42], [46, .36], [60, .3], [78, .25], [96, .2]]},
  cathedral: {name: "Cathedral",        rt60: 4.4,  pre: 0.065, wet: 0.8,  rolloff: 0.15, damp: [0.35, 0.06], taps: [[45, .45], [62, .4], [85, .35], [110, .3]]}
};

const GEOM = {
  none: {w: 0, h: 0, ly: .5}, studio: {w: 6, h: 6, ly: .5}, living: {w: 7, h: 7, ly: .5},
  club: {w: 10, h: 10, ly: .6}, hall: {w: 20, h: 24, ly: .72}, cathedral: {w: 16, h: 30, ly: .7}
};
for (const k of Object.keys(ROOMS)) Object.assign(ROOMS[k], GEOM[k]);

// Scenes: where each stem sits (azimuth deg, distance m, elevation m). panWidth is how far
// (deg) the stem's own stereo position can pull it left/right of its anchor.
const SCENES = {
  living: {name: "Living room", room: "living", panWidth: 35, anchors: {
    bass: {az: -35, d: 2.8, elev: -0.3}, body: {az: 35, d: 2.8, elev: -0.1}, voice: {az: 0, d: 2.0, elev: 0},
    presence: {az: -14, d: 3.2, elev: 0.2}, air: {az: 18, d: 3.5, elev: 0.5}, ambience: {az: 180, d: 3.5, elev: 0.3}}},
  hall: {name: "Concert hall", room: "hall", panWidth: 30, anchors: {
    bass: {az: -30, d: 8.5, elev: -0.2}, body: {az: 30, d: 8, elev: 0}, voice: {az: 0, d: 6.5, elev: 0.1},
    presence: {az: -12, d: 8, elev: 0.3}, air: {az: 14, d: 10, elev: 0.8}, ambience: {az: 180, d: 6, elev: 0.5}}},
  club: {name: "Small club", room: "club", panWidth: 30, anchors: {
    bass: {az: -28, d: 4.5, elev: -0.2}, body: {az: 28, d: 4.2, elev: 0}, voice: {az: 0, d: 3.6, elev: 0.1},
    presence: {az: -10, d: 4.6, elev: 0.3}, air: {az: 12, d: 5.2, elev: 0.7}, ambience: {az: 180, d: 4, elev: 0.4}}},
  studio: {name: "Studio", room: "studio", panWidth: 40, anchors: {
    bass: {az: -110, d: 2.4, elev: -0.2}, body: {az: 80, d: 2.2, elev: 0}, voice: {az: 0, d: 1.4, elev: 0},
    presence: {az: -70, d: 2.0, elev: 0.1}, air: {az: 20, d: 1.6, elev: 1.4}, ambience: {az: 180, d: 3, elev: 0.3}}},
  free: {name: "Free (no room)", room: "none", panWidth: 90, anchors: null}
};

// Places you can jump to in each scene. x = metres right of the default seat, z = metres back
// (negative = toward the stage). look = the point you face when you get there.
const SPOTS = {
  living: [
    {id: "seat", name: "Your seat", x: 0, z: 0, look: [0, -5]},
    {id: "singer", name: "Next to the singer", x: 0.9, z: -1.4, look: [0, -2]},
    {id: "band", name: "Inside the band", x: 0, z: -2.7, look: [0, -6]},
    {id: "corner", name: "Back corner", x: -2.8, z: 2.8, look: [0, -2.5]}],
  hall: [
    {id: "seat", name: "Front row", x: 0, z: 0, look: [0, -8]},
    {id: "side", name: "Side of the stage", x: -7.5, z: -7, look: [0, -7.5]},
    {id: "stage", name: "On stage, facing the crowd", x: 0, z: -7.8, look: [0, 6]},
    {id: "back", name: "Back of the hall", x: 0, z: 5.5, look: [0, -7]}],
  club: [
    {id: "seat", name: "Mid-crowd", x: 0, z: 0, look: [0, -5]},
    {id: "rail", name: "Right at the stage", x: 0, z: -2.6, look: [0, -3.6]},
    {id: "drums", name: "Behind the drums", x: 1, z: -5.5, look: [0, 3]},
    {id: "bar", name: "By the bar", x: 4, z: 3, look: [0, -3.5]}],
  studio: [
    {id: "seat", name: "Middle of the room", x: 0, z: 0, look: [0, -3]},
    {id: "vocal", name: "Beside the vocalist", x: 0.8, z: -1.2, look: [0, -1.4]},
    {id: "amp", name: "Next to the bass amp", x: -1.7, z: 0.4, look: [-2.26, 0.82]},
    {id: "corner", name: "Control corner", x: 2.4, z: 2.4, look: [0, -1]}],
  free: [{id: "seat", name: "Center", x: 0, z: 0, look: [0, -5]}]
};
for (const k of Object.keys(SCENES)) SCENES[k].spots = SPOTS[k] || [];

const DEFAULT_WORLD = {
  listenerYaw: 0, listenerX: 0, listenerZ: 0, worldLock: true, distanceOffset: 0, auto: true, spread: 0.5,
  scene: "living", room: "living", reverb: 1, volume: 1, sway: true
};

let world = {...DEFAULT_WORLD};
const stems = [...BANDS, AMBIENCE].map(b => ({
  id: b.id, name: b.name, label: b.name, baseElev: b.elev, elev: b.elev, spreadDeg: b.spreadDeg, sendBias: b.sendBias,
  azimuth: 0, distance: 2, volume: 1, mute: false, solo: false, manual: false,
  level: 0, slow: 0, pan: 0, corr: 1, punch: 0, punchy: false,
  anL: null, anR: null, damp: null, panner: null, gain: null, send: null
}));
resetStems();

let audioContext = null, persistentCtx = null, master = null, limiter = null, stereo = null, splitter = null;
let reverbIn = null, convolver = null, reverbOut = null;
let allNodes = [];
let active = false, timer = null, irToken = 0;
// Page-level state. A media element can only ever be wrapped once, so the AudioContext and the
// wrapper nodes live as long as the page; "stop" simply routes the element straight to the speakers.
let wantActive = false, drm = false, lastError = "", currentEl = null, currentSrc = null;
const elSources = new WeakMap();
const BOOT = Date.now();
let walkTX = 0, walkTZ = 0; // where the listener is walking to; world.listenerX/Z glide toward it

// Keep the listener inside the room (or within 12 m when there is no room).
function clampListener(x, z) {
  const r = ROOMS[world.room];
  if (r && r.w > 0) {
    return [clamp(x, -r.w / 2 + 0.3, r.w / 2 - 0.3), clamp(z, -r.ly * r.h + 0.3, (1 - r.ly) * r.h - 0.3)];
  }
  return [clamp(x, -12, 12), clamp(z, -12, 12)];
}
function setWalkTarget(x, z, snap) {
  [walkTX, walkTZ] = clampListener(Number(x) || 0, Number(z) || 0);
  if (snap) { world.listenerX = walkTX; world.listenerZ = walkTZ; }
}

function resetStems() {
  for (const st of stems) {
    const amb = st.id === "ambience";
    st.azimuth = amb ? 180 : 0;
    st.distance = amb ? 3.5 : 2;
    st.elev = st.baseElev;
    st.volume = 1; st.mute = false; st.solo = false; st.manual = false;
    st.pan = 0; st.corr = 1; st.punch = 0; st.punchy = false; st.slow = 0; st.level = 0;
    st.label = st.name;
  }
}

function snapshot() {
  const room = ROOMS[world.room];
  const sc = SCENES[world.scene] || SCENES.free;
  return {
    active,
    status: {
      boot: BOOT, wantActive, hasMedia: !!currentEl, drm, error: lastError,
      ctx: persistentCtx ? persistentCtx.state : "none", host: location.hostname
    },
    world: {...world},
    roomGeom: {w: room.w, h: room.h, ly: room.ly},
    spots: sc.spots.map(sp => ({
      id: sp.id, name: sp.name, x: sp.x, z: sp.z,
      yaw: Math.round(Math.atan2(sp.look[0] - sp.x, -(sp.look[1] - sp.z)) * 180 / PI)
    })),
    stems: stems.map(s => ({
      id: s.id, name: s.name, label: s.label, azimuth: s.azimuth, distance: s.distance,
      volume: s.volume, mute: s.mute, solo: s.solo, manual: s.manual,
      level: s.level, pan: s.pan, corr: s.corr
    }))
  };
}

// ---------- room impulse response ----------
function makeIR(ctx, room) {
  const sr = ctx.sampleRate;
  const pre = Math.floor(room.pre * sr);
  const len = pre + Math.floor(room.rt60 * 1.15 * sr) + 64;
  const buf = ctx.createBuffer(2, len, sr);
  const ramp = Math.max(1, Math.floor(0.012 * sr));
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    // Early reflections: a few discrete bounces, slightly different per ear for width.
    for (const [ms, g] of room.taps) {
      const i = pre + Math.floor((ms + (Math.random() * 2 - 1) * 1.5) * sr / 1000);
      if (i > 0 && i < len) d[i] += g * (Math.random() < 0.5 ? -1 : 1);
    }
    // Late tail: decaying noise that gets darker over time, like real rooms.
    let lp = 0;
    for (let i = pre; i < len; i++) {
      const t = (i - pre) / sr;
      const env = Math.exp(-6.9078 * t / room.rt60);
      const k = room.damp[0] + (room.damp[1] - room.damp[0]) * Math.min(1, t / room.rt60);
      lp += ((Math.random() * 2 - 1) - lp) * k;
      d[i] += lp * env * Math.min(1, (i - pre) / ramp) * 0.6;
    }
  }
  return buf;
}

function setRoom(id, immediate) {
  if (!ROOMS[id]) return;
  world.room = id;
  setWalkTarget(walkTX, walkTZ);
  if (!audioContext || !convolver) return;
  const room = ROOMS[id];
  for (const st of stems) if (st.panner) st.panner.rolloffFactor = room.rolloff;
  if (room.wet <= 0) return; // sends drop to zero in applyStem
  const token = ++irToken, ctx = audioContext;
  if (immediate || !convolver.buffer) { convolver.buffer = makeIR(ctx, room); return; }
  // Fade the reverb out, swap the impulse response, fade back in (avoids clicks).
  reverbOut.gain.cancelScheduledValues(ctx.currentTime);
  reverbOut.gain.setTargetAtTime(0, ctx.currentTime, 0.02);
  setTimeout(() => {
    if (token !== irToken || !audioContext || audioContext !== ctx || !convolver) return;
    convolver.buffer = makeIR(ctx, ROOMS[world.room]);
    reverbOut.gain.setTargetAtTime(1, ctx.currentTime, 0.05);
  }, 90);
}

function applyScene(id) {
  const sc = SCENES[id];
  if (!sc) return;
  world.scene = id;
  setWalkTarget(0, 0);
  for (const st of stems) {
    st.manual = false;
    const a = sc.anchors?.[st.id];
    st.elev = a?.elev ?? st.baseElev;
    if (a && !world.auto) { st.azimuth = a.az; st.distance = a.d; }
  }
  setRoom(sc.room);
}

// ---------- graph building ----------
function track(node) { allNodes.push(node); return node; }

function bandChain(ctx, lo, hi) {
  const nodes = [];
  if (lo > 25) for (let i = 0; i < 2; i++) {
    const f = track(ctx.createBiquadFilter()); f.type = "highpass"; f.frequency.value = lo; f.Q.value = 0.707; nodes.push(f);
  }
  if (hi < 19000) for (let i = 0; i < 2; i++) {
    const f = track(ctx.createBiquadFilter()); f.type = "lowpass"; f.frequency.value = hi; f.Q.value = 0.707; nodes.push(f);
  }
  if (!nodes.length) nodes.push(track(ctx.createGain()));
  for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);
  return {input: nodes[0], output: nodes[nodes.length - 1]};
}

function makeAnalyser(ctx) {
  const a = track(ctx.createAnalyser());
  a.fftSize = 2048;
  a.smoothingTimeConstant = 0;
  return a;
}

function makePanner(ctx) {
  const p = track(ctx.createPanner());
  p.panningModel = "HRTF";
  p.distanceModel = "inverse";
  p.refDistance = 1;
  p.maxDistance = 50;
  p.rolloffFactor = ROOMS[world.room].rolloff;
  p.positionX.value = 0;
  p.positionY.value = 0;
  p.positionZ.value = -1;
  return p;
}

function attachOutput(ctx, st, monoNode) {
  // mono -> distance air-absorption lowpass -> HRTF panner -> stem gain -> dry master
  //                                                         \-> reverb send -> room reverb
  st.damp = track(ctx.createBiquadFilter());
  st.damp.type = "lowpass"; st.damp.frequency.value = 18000; st.damp.Q.value = 0.5;
  st.panner = makePanner(ctx);
  st.gain = track(ctx.createGain());
  st.send = track(ctx.createGain());
  st.send.gain.value = 0;
  monoNode.connect(st.damp);
  st.damp.connect(st.panner);
  st.panner.connect(st.gain);
  st.gain.connect(master);
  st.gain.connect(st.send);
  st.send.connect(reverbIn);
}

function buildGraph(ctx, splitter) {
  for (const b of BANDS) {
    const st = stems.find(s => s.id === b.id);
    const cl = bandChain(ctx, b.lo, b.hi);
    const cr = bandChain(ctx, b.lo, b.hi);
    splitter.connect(cl.input, 0);
    splitter.connect(cr.input, 1);
    st.anL = makeAnalyser(ctx); st.anR = makeAnalyser(ctx);
    cl.output.connect(st.anL); cr.output.connect(st.anR);
    const mono = track(ctx.createGain()); mono.gain.value = 0.5;
    cl.output.connect(mono); cr.output.connect(mono);
    attachOutput(ctx, st, mono);
  }
  // Ambience = the side signal (L - R): what is different between the two ears.
  const amb = stems.find(s => s.id === "ambience");
  const sl = track(ctx.createGain()); sl.gain.value = 0.7;
  const sr = track(ctx.createGain()); sr.gain.value = -0.7;
  splitter.connect(sl, 0); splitter.connect(sr, 1);
  const side = track(ctx.createGain());
  sl.connect(side); sr.connect(side);
  const hp = track(ctx.createBiquadFilter()); hp.type = "highpass"; hp.frequency.value = 200;
  side.connect(hp);
  amb.anL = makeAnalyser(ctx); amb.anR = null;
  hp.connect(amb.anL);
  attachOutput(ctx, amb, hp);
}

// ---------- applying the world ----------
function effectiveGain(st) {
  const anySolo = stems.some(s => s.solo);
  const audible = anySolo ? st.solo : !st.mute;
  return audible ? st.volume * (st.id === "ambience" ? 1.4 : 1) : 0;
}

// Tiny involuntary head movement. It makes the world feel outside your head,
// the way a real room does. Only matters while World Lock is on.
function swayDeg(t) { return 1.3 * Math.sin(t * 0.5) + 0.7 * Math.sin(t * 1.3 + 1); }

function applyStem(st, immediate) {
  if (!audioContext || !st.panner) return;
  const now = audioContext.currentTime;
  const tc = immediate ? 0.001 : 0.06;
  const room = ROOMS[world.room];
  const lock = world.worldLock;
  const sway = (world.sway && lock) ? swayDeg(now) : 0;
  const yaw = (world.listenerYaw + sway) * PI / 180;
  const az = st.azimuth * PI / 180;
  // Where the sound sits on the stage, in world coordinates (x right, z back, stage at -z).
  const dEff = Math.max(1, st.distance + (Number(world.distanceOffset) || 0));
  const wx = Math.sin(az) * dEff, wz = -Math.cos(az) * dEff;
  let rx, rz; // the same spot, relative to where you stand and which way you face
  if (lock) {
    // World Lock: sources stay fixed in the room, so walking and turning change what you hear.
    const dx = wx - world.listenerX, dz = wz - world.listenerZ;
    const c = Math.cos(yaw), s = Math.sin(yaw);
    rx = dx * c + dz * s;
    rz = -dx * s + dz * c;
  } else {
    // Sources ride along with your head (like normal headphones). Walking has no effect.
    rx = wx; rz = wz;
  }
  // Don't let a source sit inside your head when you walk right up to it.
  const flat = Math.hypot(rx, rz);
  if (flat < 0.35) {
    if (flat < 1e-6) { rx = 0; rz = -0.35; } else { rx *= 0.35 / flat; rz *= 0.35 / flat; }
  }
  const d = Math.hypot(rx, st.elev, rz);
  st.panner.positionX.setTargetAtTime(rx, now, tc);
  st.panner.positionY.setTargetAtTime(st.elev, now, tc);
  st.panner.positionZ.setTargetAtTime(rz, now, tc);
  st.gain.gain.setTargetAtTime(effectiveGain(st), now, 0.03);
  // Air soaks up treble with distance, so walking away darkens a sound.
  st.damp.frequency.setTargetAtTime(Math.max(5000, 18000 / (1 + 0.09 * (d - 1))), now, tc);
  // Further sounds are wetter: more of what you hear is the room, less is the direct sound.
  const send = room.wet > 0 ? Math.min(1.5, room.wet * world.reverb * (0.25 + 0.09 * d) * st.sendBias) : 0;
  st.send.gain.setTargetAtTime(send, now, 0.05);
}

function applyAll(immediate) {
  if (audioContext && master) master.gain.setTargetAtTime(world.volume, audioContext.currentTime, 0.05);
  for (const st of stems) applyStem(st, immediate);
}

// ---------- analysis ("the AI") ----------
const bufL = new Float32Array(2048), bufR = new Float32Array(2048);

function labelFor(st) {
  if (st.punch > 0.55) st.punchy = true; else if (st.punch < 0.3) st.punchy = false;
  switch (st.id) {
    case "bass": return st.punchy ? "Kick / drums" : "Bass";
    case "body": return st.punchy ? "Toms / low hits" : "Low instruments";
    case "voice": return (Math.abs(st.pan) < 0.2 && st.corr > 0.7) ? "Voice / lead" : "Instruments";
    case "presence": return st.punchy ? "Snare / claps" : "Presence / detail";
    case "air": return "Cymbals / air";
    default: return st.name;
  }
}

function analyse() {
  const n = bufL.length;
  let maxSlow = 1e-5;
  for (const st of stems) {
    if (!st.anL) continue;
    st.anL.getFloatTimeDomainData(bufL);
    let sl = 0, sr = 0, dot = 0;
    if (st.anR) {
      st.anR.getFloatTimeDomainData(bufR);
      for (let i = 0; i < n; i++) { const l = bufL[i], r = bufR[i]; sl += l * l; sr += r * r; dot += l * r; }
    } else {
      for (let i = 0; i < n; i++) { const l = bufL[i]; sl += l * l; }
      sr = sl; dot = sl;
    }
    const rmsL = Math.sqrt(sl / n), rmsR = Math.sqrt(sr / n);
    const level = Math.sqrt((sl + sr) / (2 * n));
    if (level > 0.002) {
      // Only trust stereo measurements while the stem is actually carrying sound.
      const panTarget = (rmsR - rmsL) / (rmsR + rmsL + 1e-9);
      const corr = dot / (Math.sqrt(sl * sr) + 1e-12);
      st.pan += (panTarget - st.pan) * Math.min(0.25, 0.04 + level * 2);
      st.corr += (corr - st.corr) * 0.1;
    }
    st.level += (level - st.level) * 0.4;
    st.slow += (level - st.slow) * 0.02;
    const onset = Math.max(0, level / (st.slow + 1e-4) - 1);
    st.punch += (Math.min(onset, 3) - st.punch) * 0.1;
    st.label = labelFor(st);
    if (st.slow > maxSlow) maxSlow = st.slow;
  }
  if (!world.auto) return;
  const scene = SCENES[world.scene] || SCENES.free;
  const w = world.spread * 2; // "Stage width": 0 = everything in the middle, 1 = normal, 2 = very wide
  for (const st of stems) {
    if (st.manual) continue;
    const rel = st.slow / maxSlow;
    let az, dist;
    const a = scene.anchors?.[st.id];
    if (a) {
      // Scene placement: each sound has a spot on the stage; its own stereo position nudges it.
      if (st.id === "ambience") { az = a.az; dist = a.d; }
      else {
        az = clamp(a.az * w + st.pan * scene.panWidth * w, -170, 170);
        dist = a.d * (0.9 + 0.25 * (1 - rel)); // quieter sounds sit slightly further back
      }
    } else if (st.id === "ambience") {
      az = 180; dist = 3.5;
    } else {
      // Free mode (same as 0.3): follow the stereo picture, fanning out mono sources by type.
      const off = st.spreadDeg * (world.spread * 2) * (1 - Math.min(1, Math.abs(st.pan) * 1.5));
      az = clamp(st.pan * 90 + off, -170, 170);
      dist = 1.5 + (1 - rel) * 1.5;
    }
    st.azimuth += (az - st.azimuth) * 0.15;
    st.distance += (dist - st.distance) * 0.1;
  }
}

function tick() {
  if (!active || !audioContext) return;
  // Glide toward the walk target so moving feels like walking, not teleporting.
  world.listenerX += (walkTX - world.listenerX) * 0.2;
  world.listenerZ += (walkTZ - world.listenerZ) * 0.2;
  analyse();
  applyAll(false);
}

// ---------- media element plumbing ----------
function pickMedia() {
  let best = null, bestScore = 0;
  for (const el of document.querySelectorAll("video, audio")) {
    let s = 0;
    if (!el.paused && !el.ended) s += 4;
    if (el.readyState > 0) s += 2;
    if (el.currentSrc || el.src) s += 1;
    if (s > 0 && el === currentEl) s += 0.5;
    if (s > bestScore) { best = el; bestScore = s; }
  }
  return best;
}

function detachCurrent() {
  if (currentSrc && persistentCtx) {
    try { currentSrc.disconnect(); } catch {}
    try { currentSrc.connect(persistentCtx.destination); } catch {} // back to normal, unprocessed playback
  }
  currentEl = null; currentSrc = null;
}

function attach(el) {
  if (el === currentEl) return;
  detachCurrent();
  if (!el) return;
  let node = elSources.get(el);
  if (!node) {
    node = audioContext.createMediaElementSource(el);
    elSources.set(el, node);
  }
  try { node.disconnect(); } catch {}
  node.connect(stereo);
  currentEl = el; currentSrc = node;
}

// ---------- world lifecycle ----------
function buildWorld() {
  if (active) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) throw new Error("Web Audio is not available in this WebView.");
  if (!persistentCtx) persistentCtx = new AC({latencyHint: "interactive"});
  const ctx = persistentCtx;
  ctx.resume().catch(() => {});
  audioContext = ctx;
  try {
    // Force stereo so mono videos feed both channels.
    stereo = track(ctx.createGain());
    stereo.channelCount = 2; stereo.channelCountMode = "explicit"; stereo.channelInterpretation = "speakers";
    splitter = track(ctx.createChannelSplitter(2));
    stereo.connect(splitter);

    master = track(ctx.createGain());
    master.gain.value = world.volume;
    limiter = track(ctx.createDynamicsCompressor());
    limiter.threshold.value = -3; limiter.knee.value = 0; limiter.ratio.value = 20;
    limiter.attack.value = 0.003; limiter.release.value = 0.15;
    master.connect(limiter); limiter.connect(ctx.destination);

    // Room reverb bus (highpassed so the room doesn't get muddy).
    reverbIn = track(ctx.createGain());
    const rhp = track(ctx.createBiquadFilter()); rhp.type = "highpass"; rhp.frequency.value = 140;
    convolver = track(ctx.createConvolver()); convolver.normalize = true;
    reverbOut = track(ctx.createGain());
    reverbIn.connect(rhp); rhp.connect(convolver); convolver.connect(reverbOut); reverbOut.connect(master);

    const now = ctx.currentTime, L = ctx.listener;
    if (L.forwardX) {
      L.positionX.setValueAtTime(0, now); L.positionY.setValueAtTime(0, now); L.positionZ.setValueAtTime(0, now);
      L.forwardX.setValueAtTime(0, now); L.forwardY.setValueAtTime(0, now); L.forwardZ.setValueAtTime(-1, now);
      L.upX.setValueAtTime(0, now); L.upY.setValueAtTime(1, now); L.upZ.setValueAtTime(0, now);
    }

    buildGraph(ctx, splitter);
    active = true;
    setRoom(world.room, true);
    applyAll(true);
    timer = setInterval(tick, 50);
  } catch (err) {
    teardown();
    throw err;
  }
}

function teardown() {
  active = false;
  irToken++;
  if (timer) clearInterval(timer);
  timer = null;
  detachCurrent();
  for (const n of allNodes) { try { n.disconnect(); } catch {} }
  allNodes = [];
  audioContext = null; master = null; limiter = null; stereo = null; splitter = null;
  reverbIn = null; convolver = null; reverbOut = null;
  for (const st of stems) { st.anL = st.anR = st.damp = st.panner = st.gain = st.send = null; st.level = 0; }
}

// Runs twice a second while World Audio is switched on: builds the world if the page was reloaded,
// keeps the AudioContext awake, and hooks up whichever video or song is currently playing.
function watch() {
  if (!wantActive) return;
  try {
    if (!active) buildWorld();
    if (persistentCtx.state === "suspended") persistentCtx.resume().catch(() => {});
    const el = pickMedia();
    if (el && el.mediaKeys) {
      // Copy-protected (DRM) streams come out silent when routed through Web Audio, so leave them alone.
      drm = true;
      if (currentEl) detachCurrent();
      return;
    }
    drm = false;
    attach(el);
    lastError = "";
  } catch (err) {
    lastError = `Audio problem: ${err && err.message ? err.message : err}`;
    if (!active) wantActive = false;
  }
}

function start() {
  wantActive = true; lastError = "";
  try { sessionStorage.setItem("wa-active", "1"); } catch {}
  watch();
  if (!active) return {ok: false, error: lastError || "Could not start the audio engine.", state: snapshot()};
  return {ok: true, state: snapshot()};
}

function stop() {
  wantActive = false; lastError = ""; drm = false;
  try { sessionStorage.removeItem("wa-active"); } catch {}
  teardown();
  return {ok: true, state: snapshot()};
}

// ---------- settings that survive page reloads ----------
const STORE_KEY = "worldAudio.settings.v1";
let saveTimer = null;
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const keep = {...world};
      delete keep.listenerX; delete keep.listenerZ; delete keep.listenerYaw;
      localStorage.setItem(STORE_KEY, JSON.stringify(keep));
    } catch {}
  }, 400);
}
function loadSettings() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) patchWorld(JSON.parse(raw));
  } catch {}
}

// ---------- messages ----------
function patchWorld(p = {}) {
  if ("listenerYaw" in p) world.listenerYaw = Number(p.listenerYaw) || 0;
  if ("worldLock" in p) world.worldLock = !!p.worldLock;
  if ("distanceOffset" in p) world.distanceOffset = Math.max(0, Number(p.distanceOffset) || 0);
  if ("auto" in p) world.auto = !!p.auto;
  if ("spread" in p) world.spread = clamp(Number(p.spread) || 0, 0, 1);
  if ("reverb" in p) world.reverb = clamp(Number(p.reverb) || 0, 0, 1.5);
  if ("volume" in p) world.volume = clamp(Number(p.volume) || 0, 0, 1.5);
  if ("sway" in p) world.sway = !!p.sway;
  if ("listenerX" in p || "listenerZ" in p) {
    setWalkTarget("listenerX" in p ? p.listenerX : walkTX, "listenerZ" in p ? p.listenerZ : walkTZ, !!p.snap);
  }
  // Scene first (it sets that scene's room), then an explicit room choice overrides it.
  // Both only act on a real change, so sending the whole state again never resets anything.
  if ("scene" in p && SCENES[p.scene] && p.scene !== world.scene) applyScene(p.scene);
  if ("room" in p && ROOMS[p.room] && p.room !== world.room) setRoom(p.room);
}

function patchStem(id, p = {}) {
  const st = stems.find(s => s.id === id);
  if (!st) return;
  if ("azimuth" in p) st.azimuth = clamp(Number(p.azimuth) || 0, -180, 180);
  if ("distance" in p) st.distance = clamp(Number(p.distance) || 1, 1, 12);
  if ("volume" in p) st.volume = clamp(Number(p.volume), 0, 1.5);
  if ("mute" in p) st.mute = !!p.mute;
  if ("solo" in p) st.solo = !!p.solo;
  // Touching direction or distance pins the stem so the auto-placement stops moving it.
  if (("azimuth" in p || "distance" in p) && !("manual" in p)) st.manual = true;
  if ("manual" in p) st.manual = !!p.manual;
}


const reply = () => ({ok: true, state: snapshot()});

function handle(message) {
  if (!message) return {ok: false, error: "Empty command"};
  switch (message.type) {
    case "START_WORLD_AUDIO": return start();
    case "STOP_WORLD_AUDIO": return stop();
    case "SET_WORLD": patchWorld(message.patch); applyAll(false); saveSoon(); return reply();
    case "SET_STEM": patchStem(message.id, message.patch); applyAll(false); return reply();
    case "RESET_WORLD":
      world = {...DEFAULT_WORLD}; resetStems(); setWalkTarget(0, 0, true); applyScene(world.scene); applyAll(false); saveSoon();
      return reply();
    case "GET_STATE": return reply();
    default: return {ok: false, error: "Unknown command"};
  }
}

try { if (sessionStorage.getItem("wa-active") === "1") wantActive = true; } catch {}
loadSettings();
setInterval(watch, 500);
window.__WA = {handle, version: "0.6.0"};
})();
