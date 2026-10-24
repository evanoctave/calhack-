// Voice samples (hold to record), Cartesia clone, cloned-voice preview, call agent + takeover on the respond screen.
const SAMPLE_LINES = {introduction: ["Introduction", "Hi Dad. It's Sarah. I'm here with you."], reassurance: ["Reassurance", "Take your time. There's no rush."], everyday: ["Everyday speech", "Let's sit down and have some tea."]};
let recKind = "", rec = null, chunks = [], recStream = null, speaking = false, listening = false;
function mime() { return MediaRecorder.isTypeSupported("audio/mp4") ? "audio/mp4" : MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : ""; }
function renderSamples() {
  if (!S) return; const v = S.voice; let n = 0;
  $("v-samples").innerHTML = Object.entries(SAMPLE_LINES).map(([k, [title, line]], i) => { const has = v.samples[k]; if (has) n++;
    return `<div class="row big"><div><span class="k">${title}</span><span class="sub2">"${esc(line.replace("Sarah", S.household.caregiver_name))}"</span><span class="sub2">${has ? "Recorded" : "Not recorded"}</span></div>
      <div style="text-align:right;white-space:nowrap"><span class="small muted">Sample ${i + 1}</span><br>${has ? `<a class="act" onclick="playSample('${k}')">Play</a> · ` : ""}<a class="act" onclick="pickSample('${k}')">${has ? "Redo" : "Record"}</a></div></div>`; }).join("");
  $("v-count").textContent = n + " sample" + (n === 1 ? "" : "s");
  $("v-clone").disabled = n === 0; $("v-clone").textContent = v.source === "clone" ? "Re-create family AI voice" : "Create family AI voice";
  $("v-ready").hidden = v.source !== "clone"; $("v-readyt").textContent = (v.name || S.household.caregiver_name) + "'s AI voice is ready";
}
function pickSample(k) { recKind = k; $("v-recpanel").hidden = false; $("v-line").textContent = '"' + SAMPLE_LINES[k][1].replace("Sarah", S.household.caregiver_name) + '"'; $("v-recstat").textContent = "Tap the button, read the line, tap again to save."; $("v-recpanel").scrollIntoView({behavior: "smooth"}); }
function playSample(k) { new Audio("/voice/samples/" + k + ".wav?t=" + Date.now()).play(); }
const Recorder = {stream: null, rec: null, chunks: [], startedAt: 0, busy: false};
async function micStream() { if (Recorder.stream && Recorder.stream.active) return Recorder.stream; Recorder.stream = await navigator.mediaDevices.getUserMedia({audio: true}); return Recorder.stream; }
async function recToggle(btn, statEl, onBlob) {
  if (Recorder.busy) return;
  if (Recorder.rec && Recorder.rec.state === "recording") {
    const held = Date.now() - Recorder.startedAt; if (held < 800) { statEl.textContent = "Keep talking, then tap again to send."; return; }
    Recorder.busy = true; const r = Recorder.rec; r.stop(); btn.classList.remove("on"); btn.textContent = btn.dataset.idle; return;
  }
  let stream; try { stream = await micStream(); } catch (e) { statEl.textContent = "Microphone blocked. Allow the mic for this site in Safari settings."; return; }
  const mt = mime(); const r = new MediaRecorder(stream, mt ? {mimeType: mt} : undefined); Recorder.rec = r; Recorder.chunks = [];
  r.ondataavailable = e => { if (e.data && e.data.size) Recorder.chunks.push(e.data); };
  r.onstop = () => { setTimeout(() => { const type = r.mimeType || mt || "audio/webm"; const blob = new Blob(Recorder.chunks, {type}); Recorder.rec = null; Recorder.busy = false;
    if (blob.size < 1500) { statEl.textContent = "Nothing recorded. Tap, talk for a second or two, tap again."; return; } onBlob(blob, type); }, 250); };
  r.start(250); Recorder.startedAt = Date.now(); btn.dataset.idle = btn.dataset.idle || btn.textContent; btn.classList.add("on"); btn.textContent = "Recording… tap to send"; statEl.textContent = "Recording. Tap the button again when done.";
}
function recTap(ev) { ev.preventDefault(); if (!recKind) return; recToggle($("v-recbtn"), $("v-recstat"), async (blob, type) => {
  $("v-recstat").textContent = "Uploading…"; const fd = new FormData(); fd.append("clip", blob, type.includes("mp4") ? "clip.mp4" : "clip.webm");
  const r = await fetch("/voice/samples/" + recKind, {method: "POST", body: fd}); const j = await r.json();
  $("v-recstat").textContent = r.ok ? "Saved, " + j.seconds + " s. Record the next one or create the voice." : "Failed: " + (j.detail || r.status); refresh(); }); }
async function cloneVoice() { $("v-clone").disabled = true; $("v-clone").textContent = "Creating voice…";
  const r = await fetch("/voice/clone", {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({name: S.household.caregiver_name})}); const j = await r.json();
  if (!r.ok) { alert(j.detail || "clone failed"); $("v-clone").disabled = false; $("v-clone").textContent = "Create family AI voice"; return; }
  await refresh(); $("v-ready").hidden = false; $("v-ready").scrollIntoView({behavior: "smooth"}); }
async function previewVoice() { $("v-preview").textContent = "Generating…"; const r = await post("/voice/preview", {situation: $("v-sit").value}); $("v-preview").textContent = '"' + r.text + '" · line by ' + r.line_source + ", voice " + r.audio.source; playRef(r.audio, r.text); }
function playRef(audio, text) { return new Promise(done => { speaking = true; const fin = () => { speaking = false; done(); }; if (audio && audio.url) { const a = new Audio(audio.url); a.onended = fin; a.onerror = () => speakThen(text, fin); a.play().catch(() => speakThen(text, fin)); } else speakThen(text, fin); }); }
function speakThen(text, cb) { if (!text || !("speechSynthesis" in window)) { cb(); return; } const u = new SpeechSynthesisUtterance(text); u.rate = .95; u.onend = cb; u.onerror = cb; speechSynthesis.cancel(); speechSynthesis.speak(u); }
// respond screen: agent call + takeover
async function openingLine() { if (!incident) return; const r = await (await fetch("/agent/opening/" + incident + "/" + member)).json(); $("r-say").textContent = r.say; await playRef(r.audio, r.say); listenOnce(); }
async function sendTurn(text) { const r = await post("/agent/turn", {incident_id: incident, member_id: member, text}); $("r-say").textContent = r.say; await playRef(r.audio, r.say); if (r.ack) refresh(); else if (!r.done) listenOnce(); }
function listenOnce() { const SR = window.SpeechRecognition || window.webkitSpeechRecognition; if (!SR || listening || speaking) return; const r = new SR(); r.lang = "en-US"; listening = true; $("r-listen").textContent = "Listening…";
  r.onresult = ev => { listening = false; sendTurn(ev.results[0][0].transcript); }; r.onend = () => { listening = false; $("r-listen").textContent = "Tap, then speak"; }; r.onerror = () => { listening = false; }; try { r.start(); } catch (e) { listening = false; } }
async function askTyped() { const t = $("r-ask").value.trim(); if (t) { $("r-ask").value = ""; sendTurn(t); } }
async function toggleTakeover() { const on = !(S && S.takeover_by === member); await post("/takeover", {member_id: member, on}); $("r-tobtn").textContent = on ? "Hand back to Nightfall" : "Take over the voice";
  if ($("tk-eyebrow")) { $("tk-eyebrow").textContent = meName() + " is speaking"; $("tk-who").textContent = meName() + " took over the voice at the door"; } await refresh(); go(on ? "takeover" : "talk"); }
async function sayText(t) { const r = await post("/say", {member_id: member, text: t}); $("r-pttstat").textContent = r.ok ? "Played at the door (" + r.audio.source + ")." : "Failed."; }
async function sayTyped() { const t = $("r-text").value.trim(); if (t) { $("r-text").value = ""; sayText(t); } }
function pttTap(ev) { ev.preventDefault(); recToggle($("r-ptt"), $("r-pttstat"), async (blob, type) => {
  $("r-pttstat").textContent = "Sending…"; const fd = new FormData(); fd.append("member_id", member); fd.append("clip", blob, type.includes("mp4") ? "clip.mp4" : "clip.webm");
  const r = await fetch("/say/clip", {method: "POST", body: fd}); const j = await r.json().catch(() => ({}));
  $("r-pttstat").textContent = r.ok ? "Your voice is playing at the door (" + Math.round(blob.size / 1024) + " KB)." : "Clip failed: " + (j.detail || r.status); }); }
// Live voice: mic -> 16 kHz Int16 PCM -> WebSocket -> door speaker on the laptop. Tap to go live, tap to stop.
const Live = {ws: null, ctx: null, src: null, proc: null, on: false, sent: 0};
async function liveToggle(btnId, statId) {
  const btn = $(btnId || "r-live"), stat = $(statId || "r-livestat");
  if (Live.on) { liveStop(); btn.classList.remove("on"); btn.textContent = btn.dataset.idle || "Talk through the door"; stat.textContent = "Mic off. The door speaker is quiet."; return; }
  btn.dataset.idle = btn.dataset.idle || btn.textContent;
  let stream; try { stream = await micStream(); } catch (e) { stat.textContent = "Microphone blocked. Allow the mic for this site."; return; }
  const proto = location.protocol === "https:" ? "wss" : "ws"; const ws = new WebSocket(`${proto}://${location.host}/ws/talk/${member}`); ws.binaryType = "arraybuffer";
  ws.onopen = () => { Live.on = true; btn.classList.add("on"); btn.textContent = "Mic on · tap to stop"; stat.textContent = "You are live at the door. Speak normally."; if ($("r-takeover")) { $("r-takeover").hidden = false; $("r-tobtn").textContent = "Hand back to the AI"; } };
  ws.onclose = () => { if (Live.on) { liveStop(); btn.classList.remove("on"); btn.textContent = btn.dataset.idle || "Talk through the door"; stat.textContent = "Connection dropped. Tap to talk again."; } };
  ws.onerror = () => { stat.textContent = "Could not open the live channel."; };
  Live.ws = ws; Live.ctx = new (window.AudioContext || window.webkitAudioContext)(); await Live.ctx.resume();
  Live.src = Live.ctx.createMediaStreamSource(stream); Live.proc = Live.ctx.createScriptProcessor(2048, 1, 1);
  const inRate = Live.ctx.sampleRate, ratio = inRate / 16000;
  Live.proc.onaudioprocess = e => {
    if (!Live.ws || Live.ws.readyState !== 1) return;
    const f = e.inputBuffer.getChannelData(0), n = Math.floor(f.length / ratio), out = new Int16Array(n);
    for (let i = 0; i < n; i++) { const v = f[Math.floor(i * ratio)]; out[i] = Math.max(-1, Math.min(1, v)) * 32767; }
    Live.ws.send(out.buffer); Live.sent++; if (Live.sent % 20 === 0) stat.textContent = "Live at the door · " + Math.round(Live.sent * n / 16000) + " s";
  };
  Live.src.connect(Live.proc); Live.proc.connect(Live.ctx.destination);
}
function liveStop() { Live.on = false; try { Live.proc && Live.proc.disconnect(); Live.src && Live.src.disconnect(); } catch (e) {} try { Live.ws && Live.ws.close(); } catch (e) {} Live.ws = null; Live.sent = 0; }

// Listen: door microphone -> this phone (PCM over /ws/listen), scheduled with a small jitter buffer.
const Listen = {ws: null, ctx: null, t: 0, on: false, btn: null};
function listenToggle(btnId) {
  const btn = $(btnId);
  if (Listen.on) { listenStop(); btn.classList.remove("on"); btn.textContent = "Listen"; return; }
  Listen.ctx = Listen.ctx || new (window.AudioContext || window.webkitAudioContext)({sampleRate: 16000}); Listen.ctx.resume();
  const proto = location.protocol === "https:" ? "wss" : "ws"; const ws = new WebSocket(`${proto}://${location.host}/ws/listen/${member}`); ws.binaryType = "arraybuffer"; Listen.ws = ws; Listen.btn = btn;
  ws.onopen = () => { Listen.on = true; btn.classList.add("on"); btn.textContent = "Listening · tap to stop"; };
  ws.onmessage = ev => { if (typeof ev.data === "string") return; const pcm = new Int16Array(ev.data), buf = Listen.ctx.createBuffer(1, pcm.length, 16000), ch = buf.getChannelData(0); for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768; const src = Listen.ctx.createBufferSource(); src.buffer = buf; src.connect(Listen.ctx.destination); const now = Listen.ctx.currentTime; if (Listen.t < now + 0.05) Listen.t = now + 0.15; src.start(Listen.t); Listen.t += buf.duration; };
  ws.onclose = () => { if (Listen.on) { Listen.on = false; btn.classList.remove("on"); btn.textContent = "Listen"; } };
}
function listenStop() { Listen.on = false; try { Listen.ws && Listen.ws.close(); } catch (e) {} Listen.ws = null; }

// Live video from the door (JPEG frames over /ws/video). Paints into every element with class "feed-live".
const Feed = {ws: null, on: false, url: null, frames: 0, lastAt: 0, poll: null};
function feedStart() {
  if (Feed.on) return; Feed.on = true;
  const proto = location.protocol === "https:" ? "wss" : "ws"; const ws = new WebSocket(`${proto}://${location.host}/ws/video/${member}`); ws.binaryType = "arraybuffer"; Feed.ws = ws;
  ws.onmessage = ev => { if (typeof ev.data === "string") return; try { ws.send("a"); } catch (e) {} const blob = new Blob([ev.data], {type: "image/jpeg"}); const u = URL.createObjectURL(blob); document.querySelectorAll("img.feed-live").forEach(img => { img.src = u; img.style.display = "block"; }); if (Feed.url) URL.revokeObjectURL(Feed.url); Feed.url = u; Feed.frames++; Feed.lastAt = Date.now(); feedCaption("live · " + (Feed.frames % 20 === 0 ? "20 fps" : "20 fps")); };
  ws.onclose = () => { Feed.on = false; Feed.ws = null; setTimeout(() => { if (!Feed.on) feedStart(); }, 2000); };
  if (!Feed.poll) Feed.poll = setInterval(() => { if (Date.now() - Feed.lastAt > 2500) { const u = "/cam/latest.jpg?t=" + Date.now(); const p = new Image(); p.onload = () => { document.querySelectorAll("img.feed-live").forEach(img => { img.src = u; img.style.display = "block"; }); feedCaption("live · slow link"); }; p.onerror = () => feedCaption("no frame (start the door screen on the laptop)"); p.src = u; } }, 1500);
}
function feedCaption(t) { ["h-feedcap", "r-feedcap"].forEach(id => { const el = $(id); if (el) el.textContent = "Front door camera · " + t; }); const d = $("h-door"); if (d && Feed.lastAt) d.style.display = "none"; }
