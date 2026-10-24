// Camera and person detection. Reports what it sees; the server decides what it means.
//
// Primary detector is MediaPipe person detection, loaded from static/vendor (fetched by
// scripts/fetch_models.sh, gitignored). If those files are missing or fail to load, the
// frame-difference motion detector takes over so the demo always runs. The difference that
// matters: motion cannot see someone standing still, and reports them as gone.

const DOOR_DEFAULT = { x: 0.66, w: 0.34 };   // right third of the frame
const FPS = 5;
const POST_EVERY_MS = 1000;                  // throttle for person_seen
const HIT_FRAMES = 2;                        // frames before declaring someone present
const MISS_FRAMES = 5;                       // frames before declaring the frame empty
const SCORE = 0.4;
const RING_MAX = 150;

// ---------------------------------------------------------------- pure logic

function doorZone() {
  try {
    const raw = localStorage.getItem("nf-door-zone");
    if (raw) { const z = JSON.parse(raw); if (typeof z.x === "number" && typeof z.w === "number") return z; }
  } catch (e) { /* storage blocked; fall through */ }
  return DOOR_DEFAULT;
}

// Which zone a detection sits in, from the centre of its box as a 0..1 fraction.
function zoneOf(centreX, zone) {
  return centreX >= zone.x && centreX < zone.x + zone.w ? "door" : "room";
}

function newState() {
  return { present: false, hits: 0, misses: 0, lastPostAt: 0, zone: "" };
}

// One frame in, the events to POST out. Pure, so it can be tested without a browser.
//   seen: {centreX} when a person is detected this frame, otherwise null
function decide(state, seen, now, zone) {
  const out = [];
  if (seen) {
    state.misses = 0;
    state.hits += 1;
    state.zone = zoneOf(seen.centreX, zone);
    if (!state.present && state.hits >= HIT_FRAMES) {
      state.present = true;
      state.lastPostAt = now;
      // Someone stepped into an empty frame. This starts the conversation.
      out.push({ kind: "motion", payload: {} });
      out.push({ kind: "person_seen", payload: { inside: state.zone !== "door", zone: state.zone } });
    } else if (state.present && now - state.lastPostAt >= POST_EVERY_MS) {
      state.lastPostAt = now;
      // Keeps the server's absence clock fed while they are still visible.
      out.push({ kind: "person_seen", payload: { inside: state.zone !== "door", zone: state.zone } });
    }
  } else {
    state.hits = 0;
    state.misses += 1;
    // Nothing is posted on absence: the server's ticker owns that decision.
    if (state.present && state.misses >= MISS_FRAMES) state.present = false;
  }
  return out;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { zoneOf, decide, newState, DOOR_DEFAULT, HIT_FRAMES, MISS_FRAMES, POST_EVERY_MS };
}

// ---------------------------------------------------------------- browser glue

if (typeof window !== "undefined") {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  let detector = null, mode = "off", stream = null, state = newState();
  let ring = [], prev = null, motionHits = 0, timer = null;

  function status(text) {
    const el = document.getElementById("camstat");
    if (el) el.textContent = text;
  }

  async function loadDetector() {
    const mp = await import("/vendor/vision_bundle.mjs");
    const fileset = await mp.FilesetResolver.forVisionTasks("/vendor");
    return mp.ObjectDetector.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: "/vendor/efficientdet_lite0.tflite" },
      runningMode: "VIDEO",
      scoreThreshold: SCORE,
      categoryAllowlist: ["person"],
    });
  }

  async function startCam() {
    const video = document.getElementById("cam");
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } });
    } catch (e) {
      status("camera denied; use the simulate buttons");
      return;
    }
    video.srcObject = stream;
    canvas.width = 640; canvas.height = 480;
    status("starting the person detector...");
    try {
      detector = await loadDetector();
      mode = "person";
      status("watching for people. the red box is the door zone.");
    } catch (e) {
      mode = "motion";
      status("person detector unavailable, using motion only: " + e.message);
      console.warn("cam.js fallback:", e);
    }
    state = newState();
    if (timer) clearInterval(timer);
    timer = setInterval(tick, Math.round(1000 / FPS));
  }

  function detectPerson(video) {
    const res = detector.detectForVideo(video, performance.now());
    let best = null;
    for (const d of res.detections || []) {
      const box = d.boundingBox;
      if (!box) continue;
      const score = (d.categories && d.categories[0] && d.categories[0].score) || 0;
      if (!best || score > best.score) {
        best = { score, box, centreX: (box.originX + box.width / 2) / canvas.width };
      }
    }
    return best;
  }

  // Fallback: mean absolute difference against the previous frame, inside the door zone.
  // Blind to anyone standing still, which is exactly why the model is preferred.
  function detectMotion(zone) {
    const x = Math.round(zone.x * canvas.width), w = Math.round(zone.w * canvas.width);
    const data = ctx.getImageData(x, 0, w, canvas.height).data;
    let sum = 0;
    if (prev && prev.length === data.length) {
      for (let i = 0; i < data.length; i += 16) sum += Math.abs(data[i] - prev[i]);
    }
    const score = sum / (data.length / 16);
    prev = data;
    motionHits = score > 18 ? motionHits + 1 : 0;
    return motionHits >= 3 ? { centreX: zone.x + zone.w / 2, box: null, score } : null;
  }

  function overlay(zone, seen) {
    const o = document.getElementById("overlay");
    if (!o) return;
    const g = o.getContext("2d");
    o.width = canvas.width; o.height = canvas.height;
    g.clearRect(0, 0, o.width, o.height);
    g.strokeStyle = "#ff6b6b"; g.lineWidth = 2;
    g.strokeRect(zone.x * o.width, 0, zone.w * o.width, o.height);
    if (seen && seen.box) {
      g.strokeStyle = state.zone === "door" ? "#ff6b6b" : "#4cc17a";
      g.strokeRect(seen.box.originX, seen.box.originY, seen.box.width, seen.box.height);
    }
  }

  function tick() {
    const video = document.getElementById("cam");
    if (!video || !video.videoWidth) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(b => { if (b) { ring.push(b); if (ring.length > RING_MAX) ring.shift(); } }, "image/jpeg", 0.8);
    const zone = doorZone();
    let seen = null;
    try {
      seen = mode === "person" ? detectPerson(video) : detectMotion(zone);
    } catch (e) {
      console.warn("cam.js detect failed, falling back to motion:", e);
      mode = "motion";
    }
    overlay(zone, seen);
    for (const e of decide(state, seen, Date.now(), zone)) post("/event", e);
  }

  async function postFrames(incidentId) {
    if (!ring.length) return;
    const fd = new FormData();
    const n = ring.length;
    [n - 25, n - 10, n - 1].filter(i => i >= 0).forEach((i, k) => fd.append("f" + k, ring[i], "f" + k + ".jpg"));
    await fetch("/frames/" + incidentId, { method: "POST", body: fd });
  }

  window.startCam = startCam;
  window.postFrames = postFrames;
}
