// Voice samples (hold to record), Cartesia clone, cloned-voice preview, call agent + takeover on the respond screen.
const SAMPLE_LINES = {introduction: ["Introduction", "Hi Dad. It's Sarah. I'm here with you."], reassurance: ["Reassurance", "Take your time. There's no rush."], everyday: ["Everyday speech", "Let's sit down and have some tea."]};
let recKind = "", rec = null, chunks = [], recStream = null, speaking = false, listening = false;
function mime() { return MediaRecorder.isTypeSupported("audio/mp4") ? "audio/mp4" : MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : ""; }
const SampleRecording = {blob: null, type: "", url: "", seconds: 0};
function renderSamples() {
  if (!S) return; const v = S.voice; let n = 0;
  const key = JSON.stringify([v.samples, S.household.caregiver_name]);
  if ($("v-samples").dataset.key !== key) {
    $("v-samples").dataset.key = key;
    $("v-samples").innerHTML = Object.entries(SAMPLE_LINES).map(([k,[title,line]],i) => {
      const has = v.samples[k];
      return `<div class="row big"><div><span class="k">${title}</span><span class="sub2">“${esc(line.replace("Sarah",S.household.caregiver_name))}”</span><span class="sub2">Sample ${i+1} · ${has ? "Recorded" : "Not recorded"}</span></div><div>${has ? `<button class="text-btn" onclick="playSample('${k}')">Play</button>` : ""}<button class="text-btn" onclick="pickSample('${k}')">${has ? "Redo" : "Record"}</button></div></div>`;
    }).join("");
  }
  n = Object.values(v.samples).filter(Boolean).length;
  $("v-count").textContent = n + " sample" + (n === 1 ? "" : "s");
  $("v-clone").disabled = n === 0; $("v-clone").hidden = n === 0;
}
function pickSample(kind) {
  recKind = kind; const [title,line] = SAMPLE_LINES[kind];
  $("v-line").textContent = line.replace("Sarah",S.household.caregiver_name).replace(/Dad/g,S.household.person_name);
  $("v-sample-label").textContent = title + " · Read aloud";
  $("v-recstat").textContent = "Allow microphone access when asked. Tap again to finish recording.";
  $("v-recbtn").textContent = "Start recording"; $("v-recbtn").dataset.idle = "Start recording";
  go("record");
}
function recordConsent() { $("v-recbtn").disabled = !$("v-consent").checked; }
function leaveRecording() {
  if (Recorder.rec?.state === "recording") { Recorder.rec._discard = true; Recorder.rec.stop(); }
  releaseSampleMic(); go("voice");
}
function releaseSampleMic() {
  if (typeof Live !== "undefined" && Live.on) return;
  Recorder.stream?.getTracks().forEach(track=>track.stop()); Recorder.stream = null;
}
function playSample(kind) { new Audio("/voice/samples/" + kind + ".wav?t=" + Date.now()).play().catch(()=>toast("Could not play this sample. Try recording it again.")); }
function renderVoicePreview() {
  if (!S) return;
  $("v-ready").hidden = false;
  $("v-readyt").textContent = S.voice.source === "clone" ? (S.voice.name || S.household.caregiver_name) + "’s AI voice is ready" : "Demo preview · Browser voice";
  $("v-saved-samples").innerHTML = Object.entries(SAMPLE_LINES).filter(([kind])=>S.voice.samples[kind]).map(([kind,[title]])=>`<button class="text-btn" onclick="playSample('${kind}')"><img src="/assets/figma/play.svg" alt=""> ${title}</button>`).join("");
}

const Recorder = {stream: null, rec: null, chunks: [], startedAt: 0, busy: false};
async function micStream() { if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) throw new Error("Microphone unavailable. Use typed speech instead."); if (Recorder.stream && Recorder.stream.active) return Recorder.stream; Recorder.stream = await navigator.mediaDevices.getUserMedia({audio: true}); return Recorder.stream; }
async function recToggle(btn, statEl, onBlob) {
  if (Recorder.busy) return;
  if (Recorder.rec && Recorder.rec.state === "recording") {
    const held = Date.now() - Recorder.startedAt; if (held < 800) { statEl.textContent = "Keep talking, then tap again to send."; return; }
    Recorder.busy = true; const r = Recorder.rec; r.stop(); btn.classList.remove("on"); btn.textContent = btn.dataset.idle; return;
  }
  let stream; Recorder.busy = true; statEl.textContent = "Waiting for microphone access…";
  try { stream = await micStream(); }
  catch (error) { statEl.textContent = error.name === "NotAllowedError" ? "Microphone blocked. Allow microphone access for this site." : (error.message || "Microphone unavailable. Try again or use typed speech."); return; }
  finally { Recorder.busy = false; }
  const mt = mime(); const r = new MediaRecorder(stream, mt ? {mimeType: mt} : undefined); Recorder.rec = r; Recorder.chunks = [];
  r.ondataavailable = e => { if (e.data && e.data.size) Recorder.chunks.push(e.data); };
  r.onstop = () => { setTimeout(() => { if (r._discard) { Recorder.rec = null; Recorder.busy = false; return; } const type = r.mimeType || mt || "audio/webm"; const blob = new Blob(Recorder.chunks, {type}); Recorder.rec = null; Recorder.busy = false;
    if (blob.size < 1500) { statEl.textContent = "Nothing recorded. Tap, talk for a second or two, tap again."; return; } onBlob(blob, type); }, 250); };
  r.start(250); Recorder.startedAt = Date.now(); btn.dataset.idle = btn.dataset.idle || btn.textContent; btn.classList.add("on"); btn.textContent = "Finish recording"; statEl.textContent = "Recording. Tap the button again when done.";
}
function recTap(event) {
  event.preventDefault(); if (!recKind || !$("v-consent").checked) return;
  recToggle($("v-recbtn"),$("v-recstat"),(blob,type)=>{
    if (SampleRecording.url) URL.revokeObjectURL(SampleRecording.url);
    SampleRecording.blob = blob; SampleRecording.type = type; SampleRecording.url = URL.createObjectURL(blob);
    SampleRecording.seconds = Math.round((Date.now()-Recorder.startedAt)/1000);
    $("v-review-audio").src = SampleRecording.url; $("v-review-line").textContent = $("v-line").textContent;
    $("v-review-label").textContent = SAMPLE_LINES[recKind][0] + " · " + S.household.caregiver_name;
    $("v-duration").textContent = SampleRecording.seconds + " seconds recorded";
    $("v-save-status").textContent = ""; releaseSampleMic(); go("review");
  });
}
async function saveRecording() {
  if (!SampleRecording.blob) return;
  $("v-save").disabled = true; $("v-save-status").textContent = "Saving your sample…";
  try {
    const form = new FormData(); form.append("clip", await recordingWav(SampleRecording.blob), "clip.wav");
    await requestJSON("/voice/samples/"+recKind,form); await refresh(); $("v-save-status").textContent = ""; toast("Voice sample saved."); go("voice");
  } catch (error) { $("v-save-status").textContent = error.message + " Your recording is still here. Try saving again."; }
  finally { $("v-save").disabled = false; }
}
async function recordingWav(blob) {
  const decoder = new (window.AudioContext || window.webkitAudioContext)();
  let buffer;
  try { buffer = await decoder.decodeAudioData(await blob.arrayBuffer()); }
  finally { await decoder.close(); }
  const offline = new OfflineAudioContext(1, Math.ceil(buffer.duration * 16000), 16000);
  const source = offline.createBufferSource(); source.buffer = buffer; source.connect(offline.destination); source.start();
  const mono = (await offline.startRendering()).getChannelData(0);
  const bytes = new ArrayBuffer(44 + mono.length * 2), view = new DataView(bytes);
  const text = (offset, value) => [...value].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  text(0,"RIFF"); view.setUint32(4,36+mono.length*2,true); text(8,"WAVE"); text(12,"fmt "); view.setUint32(16,16,true);
  view.setUint16(20,1,true); view.setUint16(22,1,true); view.setUint32(24,16000,true); view.setUint32(28,32000,true);
  view.setUint16(32,2,true); view.setUint16(34,16,true); text(36,"data"); view.setUint32(40,mono.length*2,true);
  mono.forEach((sample,i)=>view.setInt16(44+i*2, Math.max(-1,Math.min(1,sample)) * (sample < 0 ? 32768 : 32767),true));
  return new Blob([bytes],{type:"audio/wav"});
}
async function saveVoiceName() {
  const name = $("v-name").value.trim(); careDrafts.add("v-name");
  try { await requestJSON("/profile", {caregiver_name: name}); careDrafts.delete("v-name"); await refresh(); } catch (error) { toast(error.message); }
}
async function cloneVoice() {
  const typed = $("v-name").value.trim();
  if (!typed && !S.household.caregiver_name) { go("voice"); $("v-name").focus(); toast("Add your name first."); return; }
  if (typed && typed !== S.household.caregiver_name) await saveVoiceName();
  go("creating"); $("v-retry").hidden = true; $("v-create-status").textContent = "Creating the voice reference…";
  try { await requestJSON("/voice/clone",{name:S.household.caregiver_name}); await refresh(); go("voice-preview"); }
  catch(error) { $("v-create-status").textContent = error.message + " Your saved samples are still here."; $("v-retry").hidden = false; }
}
async function previewVoice() {
  $("v-preview").textContent = "Generating…";
  try { const result = await requestJSON("/voice/preview",{situation:$("v-sit").value}); $("v-preview").textContent = "“"+result.text+"”"+(S.voice.source === "mock" ? " · Browser voice preview" : ""); await playRef(result.audio,result.text); }
  catch(error) { $("v-preview").textContent = error.message; }
}
let refPlayback = null;
function playRef(audio, text) { return new Promise(done => { speaking = true; const fin = () => { speaking = false; done(); }; if (audio && audio.url) { const a = new Audio(audio.url); refPlayback = a; a.onended = fin; a.onerror = () => speakThen(text, fin); a.play().catch(() => speakThen(text, fin)); } else speakThen(text, fin); }); }
function speakThen(text, cb) { if (!text || !("speechSynthesis" in window)) { cb(); return; } const u = new SpeechSynthesisUtterance(text); u.rate = .95; u.onend = cb; u.onerror = cb; speechSynthesis.cancel(); speechSynthesis.speak(u); }
// respond screen: agent call + takeover
async function openingLine() { if (!incident) return; const r = await (await fetch("/agent/opening/" + incident + "/" + member)).json(); $("r-say").textContent = r.say; await playRef(r.audio, r.say); if (location.hash === "#call") listenOnce(); }
async function sendTurn(text) { const r = await post("/agent/turn", {incident_id: incident, member_id: member, text}); $("r-say").textContent = r.say; await playRef(r.audio, r.say); if (r.ack) refresh(); else if (!r.done && location.hash === "#call") listenOnce(); }
let agentRecognition = null;
function stopAgentCall() { if (refPlayback) { refPlayback.pause(); refPlayback = null; } agentRecognition?.abort(); agentRecognition = null; listening = false; speechSynthesis.cancel(); }
function listenOnce() { const SR = window.SpeechRecognition || window.webkitSpeechRecognition; if (!SR) { $("r-sub").textContent = "Voice questions unavailable here. Type your question below."; return; } if (listening || speaking) return; const r = new SR(); agentRecognition = r; r.lang = "en-US"; listening = true; $("r-listen").textContent = "Listening…";
  r.onresult = ev => { listening = false; sendTurn(ev.results[0][0].transcript); }; r.onend = () => { listening = false; $("r-listen").textContent = "Tap, then speak"; }; r.onerror = () => { listening = false; }; try { r.start(); } catch (e) { listening = false; } }
async function askTyped() { const t = $("r-ask").value.trim(); if (t) { $("r-ask").value = ""; sendTurn(t); } }
async function toggleTakeover() { const on = !(S && S.takeover_by === member); if (!on && Live.on) liveStop(); await post("/takeover", {member_id: member, on}); $("r-tobtn").textContent = on ? "Hand back to Nightfall" : "Take over the voice";
  if ($("tk-eyebrow")) { $("tk-eyebrow").textContent = meName() + " is speaking"; $("tk-who").textContent = meName() + " took over the voice at the door"; } await refresh(); go(on ? "takeover" : "talk"); }
async function sayText(t) { try { await requestJSON("/say", {member_id: member, text: t}); $("r-pttstat").textContent = "Message sent to the door."; toast("Message sent to the door."); } catch (error) { toast(error.message); } }
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
function liveStop() { Live.on = false; try { Live.proc && Live.proc.disconnect(); Live.src && Live.src.disconnect(); } catch (e) {} try { Live.ws && Live.ws.close(); } catch (e) {} Live.ws = null; Live.sent = 0; Live.ctx?.close(); Live.ctx = null; Recorder.stream?.getTracks().forEach(track=>track.stop()); Recorder.stream = null; }

// Listen: door microphone -> this phone (PCM over /ws/listen), scheduled with a small jitter buffer.
const Listen = {ws: null, ctx: null, t: 0, on: false, btn: null};
function listenToggle(btnId) {
  const btn = $(btnId);
  if (Listen.on) { listenStop(); btn.classList.remove("on"); btn.textContent = "Listen"; return; }
  Listen.ctx = Listen.ctx || new (window.AudioContext || window.webkitAudioContext)({sampleRate: 16000}); Listen.ctx.resume();
  const proto = location.protocol === "https:" ? "wss" : "ws"; const ws = new WebSocket(`${proto}://${location.host}/ws/listen/${member}`); ws.binaryType = "arraybuffer"; Listen.ws = ws; Listen.btn = btn;
  ws.onopen = () => { Listen.on = true; btn.classList.add("on"); btn.textContent = "Listening · tap to stop"; };
  ws.onmessage = ev => { if (typeof ev.data === "string" || !Listen.on || !Listen.ctx) return; const pcm = new Int16Array(ev.data), buf = Listen.ctx.createBuffer(1, pcm.length, 16000), ch = buf.getChannelData(0); for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768; const src = Listen.ctx.createBufferSource(); src.buffer = buf; src.connect(Listen.ctx.destination); const now = Listen.ctx.currentTime; if (Listen.t < now + 0.05) Listen.t = now + 0.15; src.start(Listen.t); Listen.t += buf.duration; };
  ws.onclose = () => { if (Listen.on) { Listen.on = false; btn.classList.remove("on"); btn.textContent = "Listen"; } };
}
function listenStop() { Listen.on = false; try { Listen.ws && Listen.ws.close(); } catch (e) {} Listen.ws = null; Listen.ctx?.close(); Listen.ctx = null; Listen.t = 0; if (Listen.btn) { Listen.btn.classList.remove("on"); Listen.btn.textContent = "Listen"; } }

// Live video from the door (JPEG frames over /ws/video). Paints into every element with class "feed-live".
const Feed = {ws: null, on: false, url: null, frames: 0, lastAt: 0, poll: null};
function feedStart() {
  if (Feed.on) return; Feed.on = true;
  const proto = location.protocol === "https:" ? "wss" : "ws"; const ws = new WebSocket(`${proto}://${location.host}/ws/video/${member}`); ws.binaryType = "arraybuffer"; Feed.ws = ws;
  ws.onmessage = ev => { if (typeof ev.data === "string") return; const blob = new Blob([ev.data], {type: "image/jpeg"}); const u = URL.createObjectURL(blob); document.querySelectorAll("img.feed-live").forEach(img => { img.src = u; img.style.display = "block"; }); if (Feed.url) URL.revokeObjectURL(Feed.url); Feed.url = u; Feed.frames++; Feed.lastAt = Date.now(); feedCaption("Live"); };
  ws.onclose = () => { Feed.on = false; Feed.ws = null; setTimeout(() => { if (!Feed.on) feedStart(); }, 2000); };
  if (!Feed.poll) Feed.poll = setInterval(() => { if (Date.now() - Feed.lastAt > 2500) { const u = "/cam/latest.jpg?t=" + Date.now(); const p = new Image(); p.onload = () => { document.querySelectorAll("img.feed-live").forEach(img => { img.src = u; img.style.display = "block"; }); feedCaption("live · slow link"); }; p.onerror = () => feedCaption("Camera offline"); p.src = u; } }, 1500);
}
function feedCaption(t) { if (demoMode && !S?.live_frame) t = "Recorded demo"; ["h-feedcap", "r-feedcap"].forEach(id => { const el = $(id); if (el) el.textContent = "Front door camera · " + t; }); const d = $("h-door"); if (d && Feed.lastAt) d.style.display = "none"; }
