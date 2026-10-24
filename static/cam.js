// Person detection in the browser (TensorFlow.js coco-ssd), ring buffer, live relay to phones.
// Events: person_enter (3 consecutive hits after absence), person_lost (absent LOST_S), person_back.
const Cam = {model: null, video: null, canvas: null, ctx: null, overlay: null, octx: null, ring: [], personFrames: [],
             present: false, hits: 0, misses: 0, lastEvent: "", lostMs: 1500, lastSeenAt: 0, relayAt: 0, busy: false, on: false, heights: [], awayAt: 0, face: null, faceMisses: 0, faceTick: 0, facing: "", awaySince: 0, awayLostSent: false, awayHoldMs: 5000, track: []};

function camTele(event, detail, metadata = {}) { fetch("/door/telemetry", {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({event, detail: String(detail || ""), ...metadata})}).catch(() => {}); }
function camStatus(t) { const el = document.getElementById("camstat"); if (el) el.textContent = t; }

async function startCam() {
  if (Cam.on) return;
  try { Cam.stream = await navigator.mediaDevices.getUserMedia({video: {width: 320, height: 240}, audio: false}); }
  catch (e) { camStatus("camera denied; use the buttons"); return; }
  Cam.video = document.getElementById("cam"); Cam.video.srcObject = Cam.stream;
  Cam.canvas = document.createElement("canvas"); Cam.canvas.width = 320; Cam.canvas.height = 240;
  Cam.ctx = Cam.canvas.getContext("2d", {willReadFrequently: true});
  Cam.overlay = document.getElementById("overlay"); Cam.octx = Cam.overlay.getContext("2d");
  Cam.on = true; camStatus("loading detector...");
  try { Cam.model = await cocoSsd.load({base: "lite_mobilenet_v2"}); camStatus("detector ready. walk into frame = approach; out of frame 1.5 s = exit timer."); camTele("detector_ready", "coco-ssd"); }
  catch (e) { camStatus("detector failed to load (offline?); falling back to motion"); camTele("detector_failed", String(e)); }
  loadFace(); loadFaceApi();
  setInterval(camTick, 250);
}

async function camTick() {
  if (!Cam.video || !Cam.video.videoWidth || Cam.busy) return;
  Cam.busy = true;
  try {
    Cam.ctx.drawImage(Cam.video, 0, 0, 320, 240);
    const blob = await new Promise(r => Cam.canvas.toBlob(r, "image/jpeg", 0.6));
    if (blob) { Cam.ring.push(blob); if (Cam.ring.length > 150) Cam.ring.shift(); }
    let present = false, boxes = [];
    if (Cam.model) {
      const preds = await Cam.model.detect(Cam.canvas);
      boxes = preds.filter(p => p.class === "person" && p.score > 0.55 && p.bbox[3] > 70);
      present = boxes.length > 0;
    } else present = motionFallback();
    drawBoxes(boxes, present);
    if (Date.now() < (Cam.armAt || 0)) {  // arming delay after Start: the person who tapped it is not "Dad"
      camStatus("arming in " + Math.ceil((Cam.armAt - Date.now()) / 1000) + " s: step out of frame"); return;
    }
    if (Cam.armAt) { Cam.armAt = 0; Cam.hits = 0; camStatus("armed. walk into frame = approach; out of frame 1.5 s = exit timer."); camTele("armed", ""); }
    if (present && blob) { Cam.personFrames.push(blob); if (Cam.personFrames.length > 3) Cam.personFrames.shift(); }
    const now = Date.now();
    if (present) { Cam.hits++; Cam.lastSeenAt = now; trackAway(boxes, now); await checkFace(true, now); await identify(now); } else { Cam.hits = 0; Cam.heights = []; Cam.faceMisses = 0; Cam.awaySince = 0; Cam.awayLostSent = false; }
    if (!Cam.present && Cam.hits >= 2) { Cam.present = true; Cam.presentSince = now; camTele("person_present", boxes.map(b => Math.round(b.bbox[3]) + "px " + Math.round(b.score * 100) + "%").join(",")); await onEnter(); }
    if (Cam.present && now - Cam.lastSeenAt >= Cam.lostMs) { Cam.present = false; camTele("person_absent", "no person for " + Cam.lostMs + " ms"); await onLost(); }
    const active = window.lastState && window.lastState.incident && !["CLOSED", "RETURNED", "ACKED"].includes(window.lastState.incident.state);
    if (blob && now - Cam.relayAt > (active ? 400 : 1000)) {
      Cam.relayAt = now; const fd = new FormData(); fd.append("f", blob, "f.jpg"); fetch("/cam/frame", {method: "POST", body: fd}).catch(() => {});
    }
  } finally { Cam.busy = false; }
}

let prevPix = null;
function motionFallback() {
  const d = Cam.ctx.getImageData(0, 0, 320, 240).data; let sum = 0;
  if (prevPix) for (let i = 0; i < d.length; i += 32) sum += Math.abs(d[i] - prevPix[i]);
  prevPix = d; return sum / (d.length / 32) > 12;
}

function drawBoxes(boxes, present) {
  const c = Cam.octx; c.clearRect(0, 0, 320, 240);
  c.strokeStyle = present ? "#4cc17a" : "#ff6b6b"; c.lineWidth = 2; c.font = "12px system-ui"; c.fillStyle = c.strokeStyle;
  boxes.forEach(b => { const [x, y, w, h] = b.bbox; c.strokeRect(x, y, w, h); c.fillText("person " + Math.round(b.score * 100) + "%", x + 4, y + 14); });
  const el = document.getElementById("persondot"); if (el) el.className = "dot " + (present ? "ok" : "");
  const t = document.getElementById("persontxt"); if (t && !(present && Cam.face)) t.textContent = present ? "person in frame" : "no person";
}

// Face detector (MediaPipe via TF.js). No face while a person is in frame for ~1 s = turned away from the door camera.
async function loadFace() {
  try {
    const det = await faceDetection.createDetector(faceDetection.SupportedModels.MediaPipeFaceDetector, {runtime: "mediapipe", solutionPath: "https://cdn.jsdelivr.net/npm/@mediapipe/face_detection@0.4.1646425229", modelType: "short"});
    Cam.face = det; camStatus("detectors ready: person + face. turning away or moving away starts the voice.");
  } catch (e) { console.warn("face detector unavailable", e); }
}
async function checkFace(present, now) {
  if (!Cam.face || !present || (Cam.faceTick++ % 2)) return;
  let faces = []; try { faces = await Cam.face.estimateFaces(Cam.canvas, {flipHorizontal: false}); } catch (e) { return; }
  Cam.facing = faces.length ? "facing camera" : "turned away";
  const t = document.getElementById("persontxt"); if (t) t.textContent = "person in frame · " + Cam.facing;
  if (faces.length) { Cam.faceMisses = 0; Cam.awaySince = 0; if (Cam.awayLostSent) { Cam.awayLostSent = false; sendBack("turned back to the camera"); } return; }
  Cam.faceMisses++; if (!Cam.awaySince) Cam.awaySince = now;
  if (!Cam.awayLostSent && now - Cam.awaySince >= Cam.awayHoldMs) { Cam.awayLostSent = true; camStatus("still heading out after " + Math.round(Cam.awayHoldMs / 1000) + " s: exit clock starts"); post("/event", {kind: "person_lost", payload: {source: "face", reason: "turned away, not responding", heading: heading() === "unknown" ? "away" : heading()}}).then(() => window.refresh && refresh()); }
  if (Cam.faceMisses >= 2 && now - Cam.awayAt > 15000 && now - (Cam.presentSince || 0) < 20000) {
    const st = window.lastState && window.lastState.incident ? window.lastState.incident.state : "";
    if (!["CONVERSATION", "DOOR_OPEN", "ESCALATING"].includes(st)) { Cam.awayAt = now; camStatus("turned away from the camera: voice starts"); post("/event", {kind: "person_enter", payload: {source: "face", reason: "turned away"}}).then(() => window.refresh && refresh()); }
  }
}
// Moving away from the camera (toward the door): the person's box shrinks by 15% within about a second.
function heading() {
  const tr = Cam.track; if (tr.length < 3) return "unknown";
  const a = tr[0], b = tr[tr.length - 1], dx = b.cx - a.cx, dh = b.h - a.h;
  if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dh)) return dx < 0 ? "left" : "right";
  if (dh < -20) return "away";
  if (dh > 20) return "toward";
  return Math.abs(dx) > 15 ? (dx < 0 ? "left" : "right") : "unknown";
}
function trackAway(boxes, now) {
  if (!boxes.length) return;
  const big = boxes.reduce((m, b) => b.bbox[3] > m.bbox[3] ? b : m, boxes[0]);
  const pt = {t: now, cx: big.bbox[0] + big.bbox[2] / 2, cy: big.bbox[1] + big.bbox[3] / 2, h: big.bbox[3]}; if (!Door.first) Door.first = pt; Cam.track.push(pt); Cam.track = Cam.track.filter(p => now - p.t < 2000);
  const h = Math.max(...boxes.map(b => b.bbox[3])); Cam.heights.push([now, h]); Cam.heights = Cam.heights.filter(([t]) => now - t < 1200);
  if (Cam.heights.length < 4) return; const first = Cam.heights[0][1];
  if (h < first * 0.85 && now - Cam.awayAt > 15000) { Cam.awayAt = now; camStatus("moving away from the camera: voice starts"); const st = window.lastState && window.lastState.incident ? window.lastState.incident.state : ""; if (!["CONVERSATION", "DOOR_OPEN", "ESCALATING"].includes(st)) post("/event", {kind: "person_enter", payload: {source: "coco-ssd", reason: "moving away"}}).then(() => window.refresh && refresh()); }
}
function sendBack(reason) { const st = window.lastState && window.lastState.incident ? window.lastState.incident.state : ""; if (["DOOR_OPEN", "ESCALATING"].includes(st)) post("/event", {kind: "person_back", payload: {source: "face", reason}}).then(() => window.refresh && refresh()); }
async function onEnter() {
  const st = window.lastState && window.lastState.incident ? window.lastState.incident.state : "";
  const kind = ["DOOR_OPEN", "ESCALATING"].includes(st) ? "person_back" : "person_enter";
  Cam.lastEvent = kind; Face.label = "unknown"; Face.votes = []; Door.first = Cam.track[0] || null;
  const dir = Door.first && nearDoor(Door.first) ? "entry" : "unknown";
  await post("/event", {kind, payload: {source: "coco-ssd", identity: Face.label, direction: dir}}); if (window.refresh) refresh();
}
async function onLost() {
  const hd = heading(), dir = direction(); Cam.lastEvent = "person_lost"; camStatus("left the frame heading " + hd + " (" + dir + ", identity " + Face.label + ")");
  await post("/event", {kind: "person_lost", payload: {source: "coco-ssd", heading: hd, direction: dir, identity: Face.label}}); Door.first = null; if (window.refresh) refresh();
}
async function postFrames(id) {
  const frames = Cam.personFrames.length ? Cam.personFrames : Cam.ring.slice(-3);
  if (!frames.length) return;
  const fd = new FormData(); frames.forEach((b, k) => fd.append("f" + k, b, "f" + k + ".jpg"));
  await fetch("/frames/" + id, {method: "POST", body: fd});
}

// ---- Identity (face-api.js) and door-zone direction ----
// Enrolled descriptors come from /enroll: label "person" (the monitored person) or "other" (household member).
const Face = {api: null, ready: false, enrolled: [], lastAt: 0, label: "unknown", labelAt: 0, votes: []};
async function loadFaceApi() {
  try {
    if (!window.faceapi) throw new Error("face-api not loaded");
    const base = "https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.15/model";
    await faceapi.nets.tinyFaceDetector.loadFromUri(base); await faceapi.nets.faceLandmark68TinyNet.loadFromUri(base); await faceapi.nets.faceRecognitionNet.loadFromUri(base);
    Face.api = faceapi; Face.ready = true; await loadEnrolled(); camStatus("face recognition ready · " + Face.enrolled.length + " enrolled");
  } catch (e) { console.warn("face recognition unavailable", e); camStatus("face recognition unavailable; identity stays unknown (rings by default)"); }
}
async function loadEnrolled() { try { Face.enrolled = (await (await fetch("/enroll")).json()).faces || []; } catch (e) { Face.enrolled = []; } const el = document.getElementById("enrolled"); if (el) el.textContent = Face.enrolled.map(f => f.name + " (" + f.label + ")").join(", ") || "nobody enrolled"; }
async function descriptorNow() {
  if (!Face.ready) return null;
  const det = await Face.api.detectSingleFace(Cam.canvas, new Face.api.TinyFaceDetectorOptions({inputSize: 224, scoreThreshold: 0.4})).withFaceLandmarks(true).withFaceDescriptor();
  return det ? Array.from(det.descriptor) : null;
}
function dist(a, b) { let s = 0; for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; } return Math.sqrt(s); }
async function identify(now) {
  if (!Face.ready || !Face.enrolled.length || now - Face.lastAt < 900) return;
  Face.lastAt = now; const d = await descriptorNow(); if (!d) return;
  let best = null; for (const f of Face.enrolled) { const x = dist(d, f.descriptor); if (!best || x < best.x) best = {x, f}; }
  const label = best && best.x < 0.55 ? (best.f.label === "person" ? "match" : "other") : "unknown";
  Face.votes.push(label); Face.votes = Face.votes.slice(-3);
  const agreed = Face.votes.length === 3 && Face.votes.every(v => v === label) ? label : null;
  const t = document.getElementById("idtxt"); if (t) t.textContent = "identity: " + label + (best ? " (" + best.f.name + " " + best.x.toFixed(2) + ")" : "");
  if (agreed && agreed !== Face.label) { Face.label = agreed; Face.labelAt = now; post("/event", {kind: "features", payload: {identity: agreed, who: best ? best.f.name : ""}}).then(() => window.refresh && refresh()); }
}
async function enroll(label) {
  const name = prompt(label === "person" ? "Name of the person being watched over (e.g. Robert)" : "Household member's name (e.g. Mike)"); if (!name) return;
  return enrollNamed(label, name);
}
async function enrollNamed(label, name) {
  const report = (event, detail) => { camStatus(detail); camTele(event, detail, {name, label}); };
  try {
    if (!Face.ready) throw new Error("Face recognition is not ready yet. Start the camera and try again.");
    camStatus("look at the camera…"); const samples = [];
    for (let i = 0; i < 4 && samples.length < 3; i++) { const d = await descriptorNow(); if (d) samples.push(d); await new Promise(r => setTimeout(r, 350)); }
    if (!samples.length) throw new Error("No face found. Face the camera and try again.");
    const mean = samples[0].map((_, k) => samples.reduce((a, s) => a + s[k], 0) / samples.length);
    const response = await fetch("/enroll", {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({label, name, descriptor: mean})});
    if (!response.ok) throw new Error("Registration could not be saved. Try again.");
    const result = await response.json();
    if (!result.ok) throw new Error("Registration was not confirmed. Try again.");
    await loadEnrolled();
    report("enroll_success", "Enrolled " + name + " as " + label);
  } catch (error) {
    report("enroll_error", error instanceof Error ? error.message : "Registration failed. Try again.");
  }
}
// Door zone: which edge of the frame the door is on. Entry = track started at that edge; exit = track ended there.
const Door = {edge: (() => { try { return localStorage.getItem("nf-door-edge") || "far"; } catch (e) { return "far"; } })(), first: null};
function setDoorEdge(e) { Door.edge = e; try { localStorage.setItem("nf-door-edge", e); } catch (ex) {} camStatus("door is at the " + e + " of the frame"); }
function nearDoor(p) { const W = 320, H = 240; switch (Door.edge) { case "left": return p.cx < W * 0.3; case "right": return p.cx > W * 0.7; case "top": return p.cy < H * 0.35; case "far": return p.h < H * 0.45; default: return false; } }
function direction() {
  const tr = Cam.track; if (!tr.length) return "unknown";
  const first = Door.first || tr[0], last = tr[tr.length - 1];
  const startedAtDoor = nearDoor(first), endsAtDoor = nearDoor(last) || last.h < first.h * 0.8;
  if (startedAtDoor && !endsAtDoor) return "entry";
  if (!startedAtDoor && endsAtDoor) return "exit";
  return "unknown";
}
