// Person detection in the browser (TensorFlow.js coco-ssd), ring buffer, live relay to phones.
// Events: person_enter (3 consecutive hits after absence), person_lost (absent LOST_S), person_back.
const Cam = {model: null, video: null, canvas: null, ctx: null, overlay: null, octx: null, ring: [], personFrames: [],
             present: false, hits: 0, misses: 0, lastEvent: "", lostMs: 1500, lastSeenAt: 0, relayAt: 0, busy: false, on: false, heights: [], awayAt: 0, face: null, faceMisses: 0, faceTick: 0, facing: "", awaySince: 0, awayLostSent: false, awayHoldMs: 5000, track: []};

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
  try { Cam.model = await cocoSsd.load({base: "lite_mobilenet_v2"}); camStatus("detector ready. walk into frame = approach; out of frame 1.5 s = exit timer."); }
  catch (e) { camStatus("detector failed to load (offline?); falling back to motion"); }
  loadFace();
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
      boxes = preds.filter(p => p.class === "person" && p.score > 0.5);
      present = boxes.length > 0;
    } else present = motionFallback();
    drawBoxes(boxes, present);
    if (present && blob) { Cam.personFrames.push(blob); if (Cam.personFrames.length > 3) Cam.personFrames.shift(); }
    const now = Date.now();
    if (present) { Cam.hits++; Cam.lastSeenAt = now; trackAway(boxes, now); await checkFace(true, now); } else { Cam.hits = 0; Cam.heights = []; Cam.faceMisses = 0; Cam.awaySince = 0; Cam.awayLostSent = false; }
    if (!Cam.present && Cam.hits >= 2) { Cam.present = true; await onEnter(); }
    if (Cam.present && now - Cam.lastSeenAt >= Cam.lostMs) { Cam.present = false; await onLost(); }
    if (blob && now - Cam.relayAt > 400 && window.lastState && window.lastState.incident && !["CLOSED"].includes(window.lastState.incident.state)) {
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
  if (Cam.faceMisses >= 2 && now - Cam.awayAt > 15000) {
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
  const big = boxes.reduce((m, b) => b.bbox[3] > m.bbox[3] ? b : m, boxes[0]);
  Cam.track.push({t: now, cx: big.bbox[0] + big.bbox[2] / 2, h: big.bbox[3]}); Cam.track = Cam.track.filter(p => now - p.t < 2000);
  const h = Math.max(...boxes.map(b => b.bbox[3])); Cam.heights.push([now, h]); Cam.heights = Cam.heights.filter(([t]) => now - t < 1200);
  if (Cam.heights.length < 4) return; const first = Cam.heights[0][1];
  if (h < first * 0.85 && now - Cam.awayAt > 15000) { Cam.awayAt = now; camStatus("moving away from the camera: voice starts"); const st = window.lastState && window.lastState.incident ? window.lastState.incident.state : ""; if (!["CONVERSATION", "DOOR_OPEN", "ESCALATING"].includes(st)) post("/event", {kind: "person_enter", payload: {source: "coco-ssd", reason: "moving away"}}).then(() => window.refresh && refresh()); }
}
function sendBack(reason) { const st = window.lastState && window.lastState.incident ? window.lastState.incident.state : ""; if (["DOOR_OPEN", "ESCALATING"].includes(st)) post("/event", {kind: "person_back", payload: {source: "face", reason}}).then(() => window.refresh && refresh()); }
async function onEnter() {
  const st = window.lastState && window.lastState.incident ? window.lastState.incident.state : "";
  const kind = ["DOOR_OPEN", "ESCALATING"].includes(st) ? "person_back" : "person_enter";
  Cam.lastEvent = kind; await post("/event", {kind, payload: {source: "coco-ssd"}}); if (window.refresh) refresh();
}
async function onLost() {
  const hd = heading(); Cam.lastEvent = "person_lost"; camStatus("left the frame heading " + hd + ": exit clock starts");
  await post("/event", {kind: "person_lost", payload: {source: "coco-ssd", heading: hd}}); if (window.refresh) refresh();
}
async function postFrames(id) {
  const frames = Cam.personFrames.length ? Cam.personFrames : Cam.ring.slice(-3);
  if (!frames.length) return;
  const fd = new FormData(); frames.forEach((b, k) => fd.append("f" + k, b, "f" + k + ".jpg"));
  await fetch("/frames/" + id, {method: "POST", body: fd});
}
