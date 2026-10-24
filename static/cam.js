// Person detection in the browser (TensorFlow.js coco-ssd), ring buffer, live relay to phones.
// Events: person_enter (3 consecutive hits after absence), person_lost (absent LOST_S), person_back.
const Cam = {model: null, video: null, canvas: null, ctx: null, overlay: null, octx: null, ring: [], personFrames: [],
             present: false, hits: 0, misses: 0, lastEvent: "", lostS: 3, relayAt: 0, busy: false, on: false};

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
  try { Cam.model = await cocoSsd.load({base: "lite_mobilenet_v2"}); camStatus("detector ready. walk into frame = approach; leave frame = exit."); }
  catch (e) { camStatus("detector failed to load (offline?); falling back to motion"); }
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
    if (present) { Cam.hits++; Cam.misses = 0; } else { Cam.misses++; Cam.hits = 0; }
    if (!Cam.present && Cam.hits >= 3) { Cam.present = true; await onEnter(); }
    if (Cam.present && Cam.misses >= Cam.lostS * 4) { Cam.present = false; await onLost(); }
    const now = Date.now();
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
  const t = document.getElementById("persontxt"); if (t) t.textContent = present ? "person in frame" : "no person";
}

async function onEnter() {
  const st = window.lastState && window.lastState.incident ? window.lastState.incident.state : "";
  const kind = ["DOOR_OPEN", "ESCALATING"].includes(st) ? "person_back" : "person_enter";
  Cam.lastEvent = kind; await post("/event", {kind, payload: {source: "coco-ssd"}}); if (window.refresh) refresh();
}
async function onLost() {
  Cam.lastEvent = "person_lost"; await post("/event", {kind: "person_lost", payload: {source: "coco-ssd"}}); if (window.refresh) refresh();
}
async function postFrames(id) {
  const frames = Cam.personFrames.length ? Cam.personFrames : Cam.ring.slice(-3);
  if (!frames.length) return;
  const fd = new FormData(); frames.forEach((b, k) => fd.append("f" + k, b, "f" + k + ".jpg"));
  await fetch("/frames/" + id, {method: "POST", body: fd});
}
