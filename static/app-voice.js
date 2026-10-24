// Voice samples (hold to record), Cartesia clone, cloned-voice preview, call agent + takeover on the respond screen.
const SAMPLE_LINES = {introduction: ["Introduction", "Hi Dad. It's Sarah. I'm here with you."], reassurance: ["Reassurance", "Take your time. There's no rush."], everyday: ["Everyday speech", "Let's sit down and have some tea."]};
let recKind = "", rec = null, chunks = [], recStream = null, speaking = false, listening = false;
function mime() { return MediaRecorder.isTypeSupported("audio/mp4") ? "audio/mp4" : MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : ""; }
function renderSamples() {
  if (!S) return; const v = S.voice; let n = 0;
  $("v-samples").innerHTML = Object.entries(SAMPLE_LINES).map(([k, [title, line]], i) => { const has = v.samples[k]; if (has) n++;
    return `<div class="row big"><div><span class="k">${title}</span><span class="sub2">"${esc(line.replace("Sarah", S.household.caregiver_name))}"</span><span class="sub2">${has ? "Recorded" : "Not recorded"}</span></div>
      <div style="text-align:right;white-space:nowrap"><span class="small muted">Sample ${i + 1}</span><br>${has ? `<a class="back" onclick="playSample('${k}')">Play</a> · ` : ""}<a class="back" onclick="pickSample('${k}')">${has ? "Redo" : "Record"}</a></div></div>`; }).join("");
  $("v-count").textContent = n + " sample" + (n === 1 ? "" : "s");
  $("v-clone").disabled = n === 0; $("v-clone").textContent = v.source === "clone" ? "Re-create family AI voice" : "Create family AI voice";
  $("v-ready").hidden = v.source !== "clone"; $("v-readyt").textContent = (v.name || S.household.caregiver_name) + "'s AI voice is ready";
}
function pickSample(k) { recKind = k; $("v-recpanel").hidden = false; $("v-line").textContent = '"' + SAMPLE_LINES[k][1].replace("Sarah", S.household.caregiver_name) + '"'; $("v-recstat").textContent = "Hold the button, read the line, release."; $("v-recpanel").scrollIntoView({behavior: "smooth"}); }
function playSample(k) { new Audio("/voice/samples/" + k + ".wav?t=" + Date.now()).play(); }
async function recStart(ev) { ev.preventDefault(); if (!recKind || rec) return;
  try { recStream = await navigator.mediaDevices.getUserMedia({audio: true}); } catch (e) { $("v-recstat").textContent = "Microphone blocked. Allow the mic for this site."; return; }
  const mt = mime(); rec = new MediaRecorder(recStream, mt ? {mimeType: mt} : undefined); chunks = []; rec.ondataavailable = e => chunks.push(e.data);
  rec.onstop = async () => { recStream.getTracks().forEach(t => t.stop()); const type = rec.mimeType || mt; const blob = new Blob(chunks, {type}); rec = null;
    if (blob.size < 2000) { $("v-recstat").textContent = "Too short. Hold longer and read the whole line."; return; }
    $("v-recstat").textContent = "Uploading…"; const fd = new FormData(); fd.append("clip", blob, type.includes("mp4") ? "clip.mp4" : "clip.webm");
    const r = await fetch("/voice/samples/" + recKind, {method: "POST", body: fd}); const j = await r.json();
    $("v-recstat").textContent = r.ok ? "Saved, " + j.seconds + " s. Record the next one or create the voice." : "Failed: " + (j.detail || r.status); refresh(); };
  rec.start(); $("v-recbtn").classList.add("on"); $("v-recbtn").textContent = "Recording… release to stop"; }
function recStop(ev) { ev.preventDefault(); if (rec && rec.state === "recording") rec.stop(); $("v-recbtn").classList.remove("on"); $("v-recbtn").textContent = "Hold to record"; }
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
async function toggleTakeover() { const on = $("r-takeover").hidden; await post("/takeover", {member_id: member, on}); $("r-takeover").hidden = !on; $("r-tobtn").textContent = on ? "Hand back to the AI" : "Take over the voice"; refresh(); }
async function sayText(t) { const r = await post("/say", {member_id: member, text: t}); $("r-pttstat").textContent = r.ok ? "Played at the door (" + r.audio.source + ")." : "Failed."; }
async function sayTyped() { const t = $("r-text").value.trim(); if (t) { $("r-text").value = ""; sayText(t); } }
let ptt = null, pttChunks = [];
async function pttStart(ev) { ev.preventDefault(); if (ptt) return; try { const s = await navigator.mediaDevices.getUserMedia({audio: true}); const mt = mime(); ptt = new MediaRecorder(s, mt ? {mimeType: mt} : undefined); pttChunks = []; ptt.ondataavailable = e => pttChunks.push(e.data);
  ptt.onstop = async () => { s.getTracks().forEach(t => t.stop()); const blob = new Blob(pttChunks, {type: ptt.mimeType || mt}); ptt = null; const fd = new FormData(); fd.append("member_id", member); fd.append("clip", blob, (mt || "").includes("mp4") ? "clip.mp4" : "clip.webm"); const r = await fetch("/say/clip", {method: "POST", body: fd}); $("r-pttstat").textContent = r.ok ? "Your voice played at the door." : "Clip failed."; };
  ptt.start(); $("r-ptt").classList.add("on"); $("r-pttstat").textContent = "Recording… release to send."; } catch (e) { $("r-pttstat").textContent = "Microphone not available; type instead."; } }
function pttStop(ev) { ev.preventDefault(); if (ptt && ptt.state === "recording") ptt.stop(); $("r-ptt").classList.remove("on"); }
