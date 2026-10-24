// Caregiver app: hash router, state polling + SSE, screen renderers. Voice/recording lives in app-voice.js.
let S = null, member = "", incident = null, feedTimer = null, mapObj = null, mapLayer = null, soundOn = false, acked = false;
function $(id) { return document.getElementById(id); }
function go(name) { location.hash = "#" + name; }
function show(name) {
  document.querySelectorAll(".screen").forEach(s => s.classList.toggle("on", s.id === "s-" + name));
  ["home", "alert", "care"].forEach(t => $("t-" + t).classList.toggle("on", t === name || (t === "care" && ["profile", "voice"].includes(name)) || (t === "alert" && ["alert", "brief", "search", "respond"].includes(name))));
  if (name === "search") setTimeout(renderMap, 50);
  if (name === "respond") startFeed();
  window.scrollTo(0, 0);
}
window.addEventListener("hashchange", () => show(location.hash.slice(1) || "home"));
async function resolveMember() {
  const want = (new URLSearchParams(location.search).get("me") || "").trim();
  if (!want) { member = "TM-SARAH"; return; }
  let id = ""; try { id = localStorage.getItem("nf-member-" + want) || ""; } catch (e) {}
  const st = await (await fetch("/state")).json();
  if (!st.household.tree.some(m => m.id === id)) { const r = await post("/tree", {name: want, phone: "web", tier: 1}); id = r.member_id; try { localStorage.setItem("nf-member-" + want, id); } catch (e) {} }
  member = id;
}
let es = null;
function connect() { if (es) es.close(); es = sse("/sse/phone/" + member, onEvent); }
async function refresh() {
  S = await (await fetch("/app/state?member=" + encodeURIComponent(member))).json();
  serverOffset = new Date(S.now).getTime() - Date.now();
  if (!S.household.tree.some(m => m.id === member)) { const old = member; await resolveMember(); if (member !== old) { connect(); S = await (await fetch("/app/state?member=" + encodeURIComponent(member))).json(); } }
  render(); tickCountdown();
}
function hhmm(iso) { return iso ? new Date(iso).toLocaleTimeString([], {hour: "numeric", minute: "2-digit"}) : "—"; }
function render() {
  const h = S.household, inc = S.incident; incident = inc && inc.state !== "CLOSED" ? inc.id : null;
  if (inc && inc.exited_at && !inc.acked_by && ["ESCALATING", "EXHAUSTED"].includes(inc.state) && S.rings.some(r => r.member_ids.includes(member)) && rungFor !== inc.id) ringNow(inc.id, (h.person_full_name.split(" ")[0] || h.person_name) + " has left the house at " + hhmm(inc.exited_at) + ". Open the brief.");
  if (!$("incoming").hidden && (!inc || inc.id !== rungFor || inc.acked_by || ["RETURNED", "CLOSED"].includes(inc.state))) { $("incoming").hidden = true; stopRing(); }
  if (!$("incoming").hidden) fillIncoming();
  if (inc && inc.visitor && $("visitor").hidden && !$("visitor").dataset.dismissed) showVisitor("");
  if ((!inc || !inc.visitor) && !$("visitor").hidden) hideVisitor();
  $("clock").textContent = hhmm(S.now);
  // home
  $("h-title").textContent = S.night_mode ? "Night watch is on" : "Night watch is off";
  $("h-greet").textContent = "Good evening, " + h.caregiver_name;
  $("h-watch").textContent = "Watching over " + (h.person_full_name.split(" ")[0] || h.person_name);
  $("h-cam").textContent = S.live_frame ? "Front entrance camera connected" : "Front entrance camera (enable on the laptop)";
  $("h-camstat").textContent = S.live_frame ? "Connected" : "Standby"; $("h-camstat").className = "v " + (S.live_frame ? "ok" : "");
  $("h-event").textContent = inc && inc.exited_at ? "Exit " + hhmm(inc.exited_at) : inc && inc.state === "CONVERSATION" ? "At the door now" : "No exit detected";
  $("h-event").className = "v " + (inc && inc.exited_at && !inc.acked_by ? "danger" : "");
  $("h-voice").textContent = (S.voice.source === "clone" ? (S.voice.name || h.caregiver_name) + "'s voice" : S.voice.mock ? "Browser voice (mock)" : "Stock voice") + " · " + (S.voice.source === "clone" ? "cloned" : "Demo profile");
  $("h-tree").textContent = h.tree.map((m, i) => (i + 1) + " " + m.name).join(" → ");
  $("h-demo").textContent = "Demo session · " + (S.places_source === "apify" ? "Live places" : "Sample places") + " · memory " + S.memory_source;
  // profile
  if (document.activeElement.tagName !== "INPUT") { $("p-name").value = h.person_full_name; $("p-short").value = h.person_name; $("p-age").value = h.person_age || ""; $("p-addr").value = h.address; $("p-care").value = h.caregiver_name;
    const d = h.description || {}; ["sex", "height", "weight", "hair", "eyes", "build", "marks"].forEach(k => { $("p-" + k).value = d[k] || ""; }); $("p-diag").value = h.diagnosis || ""; $("p-docname").value = (h.doctor || {}).name || ""; $("p-docphone").value = (h.doctor || {}).phone || ""; }
  $("b-police").textContent = inc && inc.police_report ? inc.police_report : "Appears when an exit is detected.";
  const hs = inc && inc.history; $("sr-history").innerHTML = hs && hs.count ? `<div class="row"><span class="k">${hs.count} prior exit${hs.count > 1 ? "s" : ""}</span><span class="v">typically found in ${hs.typical_minutes} min${hs.headings.length ? ", heading " + hs.headings.join("/") : ""}</span></div>` + hs.last.map(r => `<div class="row"><span class="k" style="font-weight:400">${hhmm(r.exited_at)} · ${esc(r.outcome)}</span><span class="v">${r.minutes_out} min · ${esc(r.heading)}</span></div>`).join("") : '<div class="row"><span class="muted">No prior wandering on record.</span></div>';
  $("p-places").innerHTML = h.familiar_places.map(p => `<div class="row"><span class="k">${esc(p.name)}</span></div>`).join("") || '<div class="row"><span class="muted">none yet</span></div>';
  $("p-tree").innerHTML = h.tree.map((m, i) => `<div class="row"><div><span class="k">${i + 1} · ${esc(m.name)}</span><span class="sub2">${i === 0 ? "Call first" : "Next if no answer"} · tier ${m.tier}${m.id === member ? " · this phone" : ""}</span></div></div>`).join("");
  $("p-ladder").textContent = h.tree.length > 1 ? `If ${h.tree[0].name} does not answer in ${S.ladder_step_s} sec, we call ${h.tree[1].name}.` : "";
  $("v-owner").textContent = h.caregiver_name + "'s voice";
  renderSamples();
  // alert
  const first = h.person_full_name.split(" ")[0] || h.person_name;
  $("a-title").textContent = inc && inc.exited_at ? first + " left home" : inc && inc.state === "CONVERSATION" ? first + " is at the door" : "No active alert";
  $("a-sub").textContent = inc && inc.exited_at ? "Front entrance · " + hhmm(inc.exited_at) : "Front entrance";
  setHero("a-hero", inc); setHero("b-hero", inc);
  const ev = [];
  if (inc) {
    if (inc.exited_at) ev.push(["Exit detected", (inc.minutes_since_exit < 1 ? "just now" : Math.round(inc.minutes_since_exit) + " min ago"), "danger"]);
    else if (inc.state === "CONVERSATION") ev.push(["At the door", inc.person_in_frame ? "in view" : "", ""]);
    ev.push(["Voice check-in", inc.lines_spoken ? (inc.state === "RETURNED" ? "Returned inside" : inc.lines_spoken + " line" + (inc.lines_spoken > 1 ? "s" : "") + " spoken · no return confirmed") : "Not started", ""]);
    S.rings.forEach((r, i) => { const prev = S.rings[i - 1]; ev.push([(i + 1) + " · Calling " + r.members.join(", "), prev ? `${i} · ${prev.members.join(", ")} did not answer within ${S.ladder_step_s} sec.` : "", "sub"]); });
    if (inc.exited_at) ev.push(["Headed", headingText(inc.heading), ""]);
    if (inc.wander) ev.push(["Why we " + (inc.wander.action === "escalate" ? "rang" : "did not ring"), "score " + inc.wander.score + " · " + inc.wander.reasons.join("; "), "sub"]);
    if (inc.identity !== "unknown") ev.push(["Face", inc.identity === "match" ? "matched " + (h.person_full_name.split(" ")[0] || h.person_name) : "a different person", inc.identity === "match" ? "danger" : "ok"]);
    if (inc.checkin === "self_other") ev.push(["Check-in", inc.checkin_who + " answered at the door", "ok"]);
    if (inc.exited_at) ev.push(["Emergency services", inc.emergency && inc.emergency.option_shown ? "Call 911 option shown. Not called." : "Not called. You decide.", inc.emergency && inc.emergency.option_shown ? "danger" : ""]);
    if (inc.acked_by_name) ev.push(["Acknowledged", inc.acked_by_name + " is responding", "ok"]);
    if (inc.state === "RETURNED") ev.push(["Back inside", "Rings cancelled", "ok"]);
  }
  $("a-events").innerHTML = ev.map(([k, v, c]) => c === "sub" ? `<div class="row big"><div><span class="k">${esc(k)}</span>${v ? `<span class="sub2">${esc(v)}</span>` : ""}</div></div>` : `<div class="row"><span class="k">${esc(k)}</span><span class="v ${c}">${esc(v)}</span></div>`).join("") || '<div class="row"><span class="muted">Nothing tonight. Run a test alert from Home.</span></div>';
  $("a-ack").hidden = !(inc && inc.acked_by_name); $("a-ackt").textContent = (inc && inc.acked_by_name ? inc.acked_by_name : "") + " is responding";
  $("a-answer").hidden = !(inc && inc.exited_at && inc.state !== "RETURNED");
  // brief
  $("b-name").textContent = h.person_full_name + (h.person_age ? ", " + h.person_age : "");
  $("b-seen").textContent = "Last seen at home · " + (inc && inc.exited_at ? hhmm(inc.exited_at) : "—");
  $("b-loc").textContent = inc && inc.state === "RETURNED" ? "Back inside" : "Current location unknown"; $("b-loc").style.color = inc && inc.state === "RETURNED" ? "var(--ok)" : "var(--danger)";
  const c = inc && inc.clothing; const pending = c && c.source === "pending";
  $("b-wear").textContent = c ? (pending ? "Describing…" : c.confidence < 0.4 ? "See photo" : cap(c.top_color + " " + c.top_type)) : "—";
  $("b-wear2").textContent = c && !pending && c.confidence >= 0.4 ? cap(c.bottom_color + " " + c.bottom_type) + (c.footwear !== "unknown" ? ", " + c.footwear : "") : "—";
  $("b-backup").textContent = (h.tree.find(m => m.id !== member) || h.tree[0] || {}).name || "—";
  $("b-conf").textContent = c && !pending && c.source !== "mock" ? `Clothing is AI-described (${Math.round(c.confidence * 100)}% confidence). Verify against the image.` : "Clothing is AI-described. Verify against the image.";
  acked = !!(inc && inc.acked_by === member); $("b-respond").hidden = acked; $("b-responding").hidden = !acked;
  // search
  $("sr-radius").textContent = "Reference search area · " + h.radius_mi + "-mile radius"; $("sr-src").textContent = S.places_source === "apify" ? "Live data" : "Demo";
  $("sr-last").textContent = "Last confirmed at home · " + (inc && inc.exited_at ? hhmm(inc.exited_at) : "—");
  $("sr-notes").innerHTML = [...h.notes.map(n => n.text), h.medications.length ? "Medications: " + h.medications.map(m => (m.name + " " + m.dose).trim()).join("; ") : "Medication information not added."].map(t => `<div class="row"><span class="k" style="font-weight:400">${esc(t)}</span></div>`).join("");
  $("sr-contacts").innerHTML = h.contacts.map(ct => `<div class="row"><span class="k">${esc(ct.name)}</span><span class="v">${ct.phone ? `<a href="tel:${esc(ct.phone.replace(/[^\d+]/g, ""))}">${esc(ct.phone)}</a>` : esc(ct.note || "")}</span></div>`).join("");
  $("sr-911").hidden = !S.call_911; $("r-911").hidden = !S.call_911;
  $("r-sub").textContent = S.live_by ? "You are live through the door." : S.takeover_by ? "You are speaking through the door." : "Nightfall is talking to " + first + " at the door.";
  const mon = []; if (inc) { if (inc.state === "CONVERSATION") mon.push(inc.person_in_frame ? first + " is at the door, in view" : first + " heading out"); if (inc.exited_at) mon.push("Out of view " + (inc.minutes_since_exit < 1 ? "under a minute" : Math.round(inc.minutes_since_exit) + " min")); if (S.rings.length) mon.push("Family tier " + S.rings[S.rings.length - 1].tier + " called"); if (S.call_911) mon.push("911 option shown"); if (inc.state === "RETURNED") mon.push("Back inside, all clear"); if (inc.clothing_line) mon.push("Wearing: " + inc.clothing_line); }
  $("r-monitortxt").textContent = mon.join(" · ") || "Watching the door";
  $("r-tostat").textContent = S.takeover_by ? "You are speaking." : "AI is speaking for you.";
  if (incident && inc.brief_link) loadBrief(inc.brief_link);
}
let serverOffset = 0;
function tickCountdown() {
  if (!S) return; const inc = S.incident; const show = inc && inc.state === "DOOR_OPEN" && inc.door_opened_at;
  ["h", "a"].forEach(k => { const el = $(k + "-cd"); if (!el) return; el.hidden = !show; if (!show) return;
    const left = Math.max(0, (new Date(inc.door_opened_at).getTime() + S.door_wait_s * 1000 - (Date.now() + serverOffset)) / 1000);
    $(k + "-cdt").textContent = "Out of view · this phone rings in " + left.toFixed(1) + " s"; $(k + "-cds").textContent = "Back in frame cancels it."; });
}
setInterval(tickCountdown, 200);
function notice(t, sub) { $("h-noticet").textContent = t; $("h-notices").textContent = sub; $("h-notice").hidden = false; setTimeout(() => { $("h-notice").hidden = true; }, 60000); if (!["respond"].includes(location.hash.slice(1))) go("home"); }
async function doorCmd(c) { const r = await post("/door/command", c); if (!r.ok) alert(r.detail || "command failed"); }
async function enrollCmd(label) { const name = $("h-enrollname").value.trim(); if (!name) { alert("Type the name first"); return; } await doorCmd({cmd: "enroll", label, name}); $("h-enrollname").value = ""; setTimeout(loadEnrolled, 2500); }
async function loadEnrolled() { try { const f = (await (await fetch("/enroll")).json()).faces; $("h-enrolled").textContent = f.length ? f.map(x => x.name + (x.label === "person" ? " (watched)" : "")).join(", ") : "none"; } catch (e) {} }
function startHomeFeed() { feedStart(); }
let visFeed = null;
function showVisitor(said) { $("vis-said").textContent = said || ""; $("visitor").hidden = false; feedStart(); }
function hideVisitor() { $("visitor").hidden = true; if (visFeed) { clearInterval(visFeed); visFeed = null; } if (Listen.on) listenStop(); }
function dismissVisitor() { $("visitor").dataset.dismissed = "1"; hideVisitor(); setTimeout(() => { delete $("visitor").dataset.dismissed; }, 120000); }
function chime() { try { const c = new (window.AudioContext || window.webkitAudioContext)(); const t = c.currentTime; [[659, 0], [523, 0.35]].forEach(([f, d]) => { const o = c.createOscillator(), g = c.createGain(); o.frequency.value = f; g.gain.setValueAtTime(0.25, t + d); g.gain.exponentialRampToValueAtTime(0.001, t + d + 0.6); o.connect(g); g.connect(c.destination); o.start(t + d); o.stop(t + d + 0.6); }); } catch (e) {} if (navigator.vibrate) navigator.vibrate(200); }
function cap(s) { s = s.replace(/unknown ?/g, "").trim(); return s ? s[0].toUpperCase() + s.slice(1) : "See photo"; }
function setHero(id, inc) { const el = $(id); const f = inc && inc.exit_frame; el.innerHTML = f ? `<img src="${esc(f)}" alt="exit frame">` : '<div class="door"></div><div class="line"></div>'; }
let briefLoaded = "";
async function loadBrief(link) {
  if (briefLoaded === link) return; briefLoaded = link;
  const r = await fetch("/brief/" + link.split("#")[1]); if (!r.ok) { briefLoaded = ""; return; }
  const b = await r.json(); window.B = b;
  $("sr-fam").innerHTML = b.familiar.map(p => `<div class="row"><div><span class="k">${esc(p.name)}</span><span class="sub2">${p.distance_mi} mi · family-provided</span></div></div>`).join("");
  $("sr-haz").innerHTML = b.hazards.slice(0, 5).map(p => `<div class="row"><span class="k">${esc(p.name)}</span><span class="v danger">${p.distance_mi} mi</span></div>`).join("") || '<div class="row"><span class="muted">none in radius</span></div>';
  $("sr-call").innerHTML = b.call_first.slice(0, 5).map(p => `<div class="row"><div><span class="k">${esc(p.name)}</span><span class="sub2">${p.distance_mi} mi${p.open_now === true ? " · open" : ""}</span></div><span class="v">${p.phone ? `<a href="tel:${esc(p.phone.replace(/[^\d+]/g, ""))}">${esc(p.phone)}</a>` : ""}</span></div>`).join("");
  if ($("s-search").classList.contains("on")) renderMap();
}
function renderMap() {
  if (!window.L || !S) return; const h = S.household, b = window.B;
  if (!mapObj) { mapObj = L.map("map", {zoomControl: false, attributionControl: false}); L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png").addTo(mapObj); }
  if (mapLayer) mapLayer.remove(); mapLayer = L.layerGroup().addTo(mapObj); mapObj.setView([h.home.lat, h.home.lng], 14);
  L.circle([h.home.lat, h.home.lng], {radius: h.radius_mi * 1609.34, color: "#2d6cdf", weight: 1, dashArray: "4 4", fillOpacity: .04}).addTo(mapLayer);
  L.circleMarker([h.home.lat, h.home.lng], {radius: 7, color: "#2d6cdf", fillColor: "#2d6cdf", fillOpacity: 1}).addTo(mapLayer);
  const route = [[h.home.lat, h.home.lng], ...h.familiar_places.map(p => [p.lat, p.lng])];
  L.polyline(route, {color: "#2d6cdf", dashArray: "6 6", weight: 2}).addTo(mapLayer);
  h.familiar_places.forEach(p => L.circleMarker([p.lat, p.lng], {radius: 6, color: "#2d6cdf", fillColor: "#fff", fillOpacity: 1}).addTo(mapLayer).bindPopup(esc(p.name)));
  if (b) { b.hazards.slice(0, 6).forEach(p => L.circleMarker([p.lat, p.lng], {radius: 6, color: "#c62828", fillOpacity: .7}).addTo(mapLayer).bindPopup(esc(p.name))); b.call_first.slice(0, 6).forEach(p => L.circleMarker([p.lat, p.lng], {radius: 6, color: "#1f8a4c", fillOpacity: .7}).addTo(mapLayer).bindPopup(esc(p.name))); }
  setTimeout(() => mapObj.invalidateSize(), 100);
}
function copyPolice() { const t = $("b-police").textContent; (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(() => { $("b-copied").textContent = "copied"; }).catch(() => { $("b-copied").textContent = "select and copy"; }); }
async function saveProfile() {
  const description = {}; ["sex", "height", "weight", "hair", "eyes", "build", "marks"].forEach(k => { description[k] = $("p-" + k).value.trim(); });
  const r = await post("/profile", {person_full_name: $("p-name").value, person_name: $("p-short").value || undefined, person_age: parseInt($("p-age").value) || undefined, caregiver_name: $("p-care").value || undefined, address: $("p-addr").value || undefined,
    description, diagnosis: $("p-diag").value.trim(), doctor: {name: $("p-docname").value.trim(), phone: $("p-docphone").value.trim()}});
  if (!r.ok) { alert(r.detail || "could not save"); return; } await refresh(); go("voice");
}
async function addMember() { const n = $("p-newname").value.trim(); if (!n) return; await post("/tree", {name: n, phone: "web", tier: Math.min(3, (S.household.tree.length || 0) + 1)}); $("p-newname").value = ""; refresh(); }
async function testAlert() { enableSound(); await post("/event", {kind: "person_enter"}); setTimeout(() => post("/event", {kind: "person_lost"}), 2500); go("alert"); }
function openBrief() { go("brief"); }
async function respond() { if (!incident) return; await post("/ack", {incident_id: incident, member_id: member}); await post("/answer", {incident_id: incident, member_id: member}); await refresh(); }
async function gotHim() { if (!incident) return; await post("/ack", {incident_id: incident, member_id: member}); await refresh(); go("brief"); }
async function answerCall() { enableSound(); stopRing(); if (incident) post("/answer", {incident_id: incident, member_id: member}); go("respond"); openingLine(); }
function startFeed() { feedStart(); }
function enableSound() { if (soundOn) return; soundOn = true; try { const a = $("ring"); a.src = ringDataUrl(); a.load(); a.volume = 1; a.play().then(() => { a.pause(); a.currentTime = 0; }).catch(() => {}); } catch (e) {} try { speechSynthesis.cancel(); speechSynthesis.speak(new SpeechSynthesisUtterance("")); } catch (e) {} }
function armPhone() { enableSound(); $("arm").hidden = true; try { localStorage.setItem("nf-armed", "1"); } catch (e) {} }
let rungFor = ""; let lastRingMsg = "";
function showIncoming(msg) { const first = (S && S.household.person_full_name.split(" ")[0]) || "Robert"; $("inc-title").textContent = /help button/i.test(msg || "") ? "Help button pressed at the door" : first + " left home"; $("inc-msg").textContent = msg || ""; $("incoming").hidden = false; }
function answerFromOverlay() { $("incoming").hidden = true; answerCall(); }
function dismissOverlay() { $("incoming").hidden = true; stopRing(); go("alert"); }
function ringNow(incId, msg) { if (rungFor === incId) return; rungFor = incId; incident = incId; lastRingMsg = msg; startRing(); showIncoming(msg); fillIncoming(); }
function headingText(h) { return {left: "to the left of the door camera", right: "to the right of the door camera", away: "away from the camera, out the door", toward: "toward the camera", unknown: "direction not seen"}[h || "unknown"]; }
function fillIncoming() {
  if (!S || !S.incident) return; const inc = S.incident, c = inc.clothing;
  $("inc-wear").textContent = !c || c.source === "pending" ? "describing from the exit frame…" : (inc.clothing_line === "see photo" ? "see the exit photo" : inc.clothing_line) + " (AI-described, verify)";
  $("inc-head").textContent = headingText(inc.heading) + (inc.exited_at ? " at " + hhmm(inc.exited_at) : "");
  $("inc-911").textContent = inc.emergency ? inc.emergency.text : "not called";
  if (!/help button/i.test(lastRingMsg)) $("inc-msg").textContent = "Exit at " + hhmm(inc.exited_at) + ". Ringing " + (S.rings.length ? S.rings[S.rings.length - 1].members.join(", ") : "you") + ".";
}
function ringDataUrl() { const sr = 8000, len = sr * 3, buf = new Uint8Array(44 + len); const w = (o, s) => [...s].forEach((c, i) => buf[o + i] = c.charCodeAt(0)); w(0, "RIFF"); w(8, "WAVEfmt "); buf[16] = 16; buf[20] = 1; buf[22] = 1; buf[24] = sr & 255; buf[25] = sr >> 8; buf[28] = sr & 255; buf[29] = sr >> 8; buf[32] = 1; buf[34] = 8; w(36, "data"); for (let i = 0; i < len; i++) { const t = i / sr, on = (t % 1) < 0.45; buf[44 + i] = on ? 128 + Math.round(110 * Math.sin(2 * Math.PI * (t < 1.5 ? 880 : 660) * t)) : 128; } return "data:audio/wav;base64," + btoa(String.fromCharCode(...buf)); }
function startRing() { try { $("ring").play().catch(() => {}); } catch (e) {} if (navigator.vibrate) navigator.vibrate([300, 200, 300]); }
function stopRing() { try { const a = $("ring"); a.pause(); a.currentTime = 0; } catch (e) {} }
function onEvent(e) {
  if (e.type === "ring") { ringNow(e.incident_id, e.message); refresh(); }
  if (e.type === "acked" || e.type === "returned") { stopRing(); refresh(); }
  if (e.type === "brief_updated" || e.type === "deadline" || e.type === "call_911_option" || e.type === "takeover") refresh();
  if (e.type === "visitor") { showVisitor(""); chime(); refresh(); }
  if (e.type === "visitor_said") { $("vis-said").textContent = e.said ? 'They said: "' + e.said + '"' : ""; }
  if (e.type === "visitor_left") { hideVisitor(); notice("Visitor left", e.detail || ""); refresh(); }
  if (e.type === "home") { notice(e.who === "other" ? "A household member is home" : (S.household.person_full_name.split(" ")[0] || "He") + " came back in", "No alert. Recognized at the door."); refresh(); }
  if (e.type === "sos") { ringNow(e.incident_id, "Help button pressed at the door."); refresh(); }
  if (e.type === "stand_down") { stopRing(); $("incoming").hidden = true; notice((e.who || "A household member") + " stepped out", "No alert. " + (e.detail || "")); refresh(); }
  if (e.type === "watch_only") { notice("Someone left, watching only", "Nightfall is not ringing the family for this one. " + (e.detail || "")); refresh(); }
}
(async function main() {
  await resolveMember(); await refresh(); connect(); setInterval(refresh, 2000); startHomeFeed(); loadEnrolled(); try { $("h-edge").value = localStorage.getItem("nf-door-edge-phone") || "far"; } catch (e) {}
  $("h-edge").addEventListener("change", () => { try { localStorage.setItem("nf-door-edge-phone", $("h-edge").value); } catch (e) {} });
  show(location.hash.slice(1) || (S.household.person_full_name ? "home" : "profile"));
})();
