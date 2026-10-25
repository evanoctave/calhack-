// Caregiver app: hash router, state polling + SSE, screen renderers. Voice/recording lives in app-voice.js.
let S = null, member = "", incident = null, feedTimer = null, mapObj = null, mapLayer = null, soundOn = false, acked = false;
function $(id) { return document.getElementById(id); }
function go(name) { location.hash = "#" + name; }
const SCREENS = ["setup", "profile", "medical", "report", "voice", "voices", "calls", "places", "area", "camera", "home", "door", "wait", "alert", "call", "talk", "takeover", "brief", "search", "responding", "back", "emergency", "help", "record", "review", "creating", "voice-preview", "join"];
const navStack = [];
function show(name) {
  if (name === "respond") name = "call";
  if (name !== "call" && typeof stopAgentCall === "function") stopAgentCall();
  if (!["record","takeover"].includes(name) && typeof Recorder !== "undefined" && Recorder.rec?.state === "recording") { Recorder.rec._discard = true; Recorder.rec.stop(); releaseSampleMic(); }
  if (!["talk","takeover"].includes(name) && typeof Listen !== "undefined" && Listen.on) listenStop();
  if (!["talk","takeover"].includes(name) && typeof Live !== "undefined" && Live.on) { liveStop(); $("r-live").classList.remove("on"); $("r-live").textContent = "Talk live"; }
  if (!SCREENS.includes(name)) name = "home";
  // direction for the slide: back if this is the screen before the current one, none on first paint
  const back = navStack.length > 1 && navStack[navStack.length - 2] === name;
  if (back) navStack.pop(); else if (navStack[navStack.length - 1] !== name) navStack.push(name);
  document.documentElement.dataset.nav = navStack.length === 1 && !back ? "none" : back ? "back" : "forward";
  document.querySelectorAll(".screen").forEach(s => s.classList.toggle("on", s.id === "s-" + name));
  $("s-join").hidden = name !== "join";
  if (name === "voice-preview") renderVoicePreview();
  if (name === "record") recordConsent();
  if (name === "brief") setTimeout(renderMap, 50);
  if (name === "area") setTimeout(renderArea, 50);
  if (name === "voices") loadVoices();
  if (name === "medical") loadMedical();
  if (name === "report") loadReport();
  window.scrollTo(0, 0);
}
window.addEventListener("hashchange", () => show(location.hash.slice(1) || "home"));
async function resolveMember() {
  const params = new URLSearchParams(location.search);
  const explicit = params.get("member"); if (explicit) { member = explicit; return; }
  const want = (params.get("me") || "").trim();
  if (!want) { member = "TM-PRIMARY"; return; }
  let id = ""; try { id = localStorage.getItem("nf-member-" + want) || ""; } catch (e) {}
  const st = await (await fetch("/state")).json();
  if (!st.household.tree.some(m => m.id === id)) { const r = await post("/tree", {name: want, phone: "web", tier: 1}); id = r.member_id; try { localStorage.setItem("nf-member-" + want, id); } catch (e) {} }
  member = id;
}
let es = null;
function connect() { if (es) es.close(); es = sse("/sse/phone/" + member, onEvent); }
async function refresh() {
  S = await requestJSON("/app/state?member=" + encodeURIComponent(member), undefined, "GET");
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
  $("h-cam").textContent = "Front entrance";
  $("h-feedcap").textContent = S.live_frame ? "Live" : demoRequested && S.demo_available ? "Recorded demo" : "Camera offline";
  $("h-camstat").textContent = S.live_frame ? "Connected" : "Standby"; $("h-camstat").className = "v " + (S.live_frame ? "ok" : "");
  $("h-event").textContent = inc && inc.exited_at ? "Exit " + hhmm(inc.exited_at) : inc && inc.state === "CONVERSATION" ? "At the door now" : "No exit detected";
  $("h-event").className = "body " + (inc && inc.exited_at && !inc.acked_by ? "danger" : "");
  $("h-voice").textContent = (S.voice.source === "clone" ? (S.voice.name || h.caregiver_name) + "'s voice" : S.voice.mock ? "Browser voice (mock)" : "Stock voice") + " · " + (S.voice.source === "clone" ? "cloned" : "Demo profile");
  $("h-tree").textContent = h.tree.map((m, i) => (i + 1) + " " + m.name).join(" → ");
  $("h-demo").textContent = "Demo session · " + (S.places_source === "apify" ? "Live places" : "Sample places") + " · memory " + S.memory_source;
  // profile
  hydrateCareForms();
  $("b-police").textContent = inc && inc.police_report ? inc.police_report : "Appears when an exit is detected.";
  const hs = inc && inc.history; $("sr-history").innerHTML = hs && hs.count ? `<div class="row"><span class="k">${hs.count} prior exit${hs.count > 1 ? "s" : ""}</span><span class="v">typically found in ${hs.typical_minutes} min${hs.headings.length ? ", heading " + hs.headings.join("/") : ""}</span></div>` + hs.last.map(r => `<div class="row"><span class="k" style="font-weight:400">${hhmm(r.exited_at)} · ${esc(r.outcome)}</span><span class="v">${r.minutes_out} min · ${esc(r.heading)}</span></div>`).join("") : '<div class="row"><span class="muted">No prior wandering on record.</span></div>';
  $("p-places").innerHTML = h.familiar_places.map(p => { const [n, ...rest] = p.name.split(", "); return `<div class="row"><div><span class="k">${esc(n)}</span>${rest.length ? `<span class="sub2">${esc(cap(rest.join(", ")))}</span>` : ""}</div></div>`; }).join("") || '<div class="row"><span class="muted">None yet</span></div>';
  renderCallOrder();
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
  $("b-loc").textContent = inc && inc.state === "RETURNED" ? "Back inside" : "Current location unknown"; $("b-loc").style.color = inc && inc.state === "RETURNED" ? "var(--green)" : "var(--red)";
  const c = inc && inc.clothing; const pending = c && c.source === "pending";
  $("b-wear").textContent = c ? (pending ? "Describing…" : c.confidence < 0.4 ? "See photo" : cap(c.top_color + " " + c.top_type)) : "—";
  $("b-wear2").textContent = c && !pending && c.confidence >= 0.4 ? [c.bottom_color, c.bottom_type, c.footwear].filter(value=>value && value !== "unknown").join(" ") : "";
  $("b-backup").textContent = (h.tree.find(m => m.id !== member) || h.tree[0] || {}).name || "—";
  $("b-conf").textContent = c && !pending && c.source !== "mock" ? `Clothing is AI-described (${Math.round(c.confidence * 100)}% confidence). Verify against the image.` : c?.source === "mock" ? "Demo description · Check the photo." : "Clothing is AI-described. Verify against the image.";
  acked = !!(inc && inc.acked_by); $("b-respond").hidden = acked || !inc || inc.state === "RETURNED"; $("b-responding").hidden = !acked; $("b-response-status").hidden = !acked;
  if (acked) $("b-responding").querySelector(".title").textContent = inc.acked_by_name + " is responding";
  // search
  $("sr-radius").textContent = "Reference search area · " + h.radius_mi + "-mile radius"; $("sr-src").textContent = S.places_source === "apify" ? "Live data" : "Demo";
  $("sr-last").textContent = "Last confirmed at home · " + (inc && inc.exited_at ? hhmm(inc.exited_at) : "—");
  $("sr-notes").innerHTML = [...h.notes.map(n => n.text), h.medications.length ? "Medications: " + h.medications.map(m => (m.name + " " + m.dose).trim()).join("; ") : "Medication information not added."].map(t => `<div class="row"><span class="k" style="font-weight:400">${esc(t)}</span></div>`).join("");
  $("sr-contacts").innerHTML = h.contacts.map(ct => `<div class="row"><span class="k">${esc(ct.name)}</span><span class="v">${ct.phone ? `<a href="tel:${esc(ct.phone.replace(/[^\d+]/g, ""))}">${esc(ct.phone)}</a>` : esc(ct.note || "")}</span></div>`).join("");
  $("sr-911").hidden = !S.call_911 || !inc || ["RETURNED","CLOSED"].includes(inc.state); $("r-911").hidden = $("sr-911").hidden;
  $("r-sub").textContent = S.live_by ? "You are live through the door." : S.takeover_by ? "You are speaking through the door." : "Nightfall is talking to " + first + " at the door.";
  const mon = []; if (inc) { if (inc.state === "CONVERSATION") mon.push(inc.person_in_frame ? first + " is at the door, in view" : first + " heading out"); if (inc.exited_at) mon.push("Out of view " + (inc.minutes_since_exit < 1 ? "under a minute" : Math.round(inc.minutes_since_exit) + " min")); if (S.rings.length) mon.push("Family tier " + S.rings[S.rings.length - 1].tier + " called"); if (S.call_911) mon.push("911 option shown"); if (inc.state === "RETURNED") mon.push("Back inside, all clear"); if (inc.clothing_line) mon.push("Wearing: " + inc.clothing_line); }
  $("r-monitortxt").textContent = mon.join(" · ") || "Watching the door";
  $("r-tostat").textContent = S.takeover_by ? "You are speaking." : "AI is speaking for you.";
  if (!incident || window.B?.incident_id !== incident) window.B = null;
  if (incident && inc.brief_link) loadBrief(inc.brief_link);
  renderFigma(); renderCareStatus(); renderBriefCards(); autoRoute();
}
let serverOffset = 0;
function tickCountdown() {
  if (!S) return; const inc = S.incident; const show = inc && inc.state === "DOOR_OPEN" && inc.door_opened_at;
  ["h", "a"].forEach(k => { const el = $(k + "-cd"); if (!el) return; el.hidden = !show; if (!show) return; el.style.setProperty("--cd", S.door_wait_s + "s");
    const left = Math.max(0, (new Date(inc.door_opened_at).getTime() + S.door_wait_s * 1000 - (Date.now() + serverOffset)) / 1000);
    $(k + "-cdt").textContent = "Out of view · this phone rings in " + left.toFixed(1) + " s"; $(k + "-cds").textContent = "Back in frame cancels it."; });
}
setInterval(tickCountdown, 200);
setInterval(() => { if (!S || !S.incident) return; const inc = S.incident; if (inc.state !== "DOOR_OPEN" || !inc.door_opened_at) return;
  const total = S.door_wait_s, left = Math.max(0, (new Date(inc.door_opened_at).getTime() + total * 1000 - (Date.now() + serverOffset)) / 1000);
  $("w-num").textContent = Math.ceil(left) + (Math.ceil(left) === 1 ? " second" : " seconds"); $("w-drain").style.transform = "scaleX(" + (left / total).toFixed(3) + ")"; }, 200);
function notice(t, sub) { $("h-noticet").textContent = t; $("h-notices").textContent = sub; $("h-notice").hidden = false; setTimeout(() => { $("h-notice").hidden = true; }, 60000); if (!["respond"].includes(location.hash.slice(1))) go("home"); }
async function doorCmd(c) { const r = await post("/door/command", c); if (!r.ok) alert(r.detail || "command failed"); }
async function enrollCmd(label) {
  const name = $("h-enrollname").value.trim() || (label === "person" ? S.household.person_full_name : "");
  if (!name) { $("camera-status").textContent = "Enter the household member's name first."; return; }
  if (!S.live_frame) { $("camera-status").textContent = "Start the door camera before registering a face."; return; }
  $("camera-status").textContent = "Look toward the door camera. Registering…";
  try {
    await requestJSON("/door/command", {cmd:"enroll",label,name});
    setTimeout(async()=>{ await loadEnrolled(); const faces = await requestJSON("/enroll",undefined,"GET"); const found = faces.faces.some(f=>f.name === name && f.label === label); $("camera-status").textContent = found ? name + "’s face is registered. This is separate from the profile photo." : "No face found yet. Look toward the camera and try again."; },2500);
  } catch(error) { $("camera-status").textContent = error.message; }
}
async function loadEnrolled() { try { const f = (await (await fetch("/enroll")).json()).faces; $("h-enrolled").textContent = f.length ? f.map(x => x.name + (x.label === "person" ? " (watched)" : "")).join(", ") : "none"; } catch (e) {} }
function startHomeFeed() { feedStart(); }
let visFeed = null;
function showVisitor(said) { $("vis-said").textContent = said || ""; $("visitor").hidden = false; feedStart(); }
function hideVisitor() { $("visitor").hidden = true; if (visFeed) { clearInterval(visFeed); visFeed = null; } if (Listen.on) listenStop(); }
function dismissVisitor() { $("visitor").dataset.dismissed = "1"; hideVisitor(); setTimeout(() => { delete $("visitor").dataset.dismissed; }, 120000); }
function chime() { try { const c = new (window.AudioContext || window.webkitAudioContext)(); const t = c.currentTime; [[659, 0], [523, 0.35]].forEach(([f, d]) => { const o = c.createOscillator(), g = c.createGain(); o.frequency.value = f; g.gain.setValueAtTime(0.25, t + d); g.gain.exponentialRampToValueAtTime(0.001, t + d + 0.6); o.connect(g); g.connect(c.destination); o.start(t + d); o.stop(t + d + 0.6); }); } catch (e) {} if (navigator.vibrate) navigator.vibrate(200); }
function cap(s) { s = s.replace(/unknown ?/g, "").trim(); return s ? s[0].toUpperCase() + s.slice(1) : "See photo"; }
function setHero(id, inc) { const el = $(id); const f = inc && inc.exit_frame; const want = f ? `<img ${f === "/assets/figma/demo-camera.png" ? 'class="demo-camera"' : ""} src="${esc(f)}" alt="Last camera image">` : '<div class="ph"></div>'; if (el.dataset.f !== (f || "")) { el.innerHTML = want; el.dataset.f = f || ""; } }
let briefLoaded = "";
async function loadBrief(link) {
  if (briefLoaded === link) return; briefLoaded = link;
  const r = await fetch("/brief/" + link.split("#")[1]); if (!r.ok) { briefLoaded = ""; return; }
  const b = await r.json(); if (b.incident_id !== incident) return; window.B = b; renderBriefCards();
  $("sr-fam").innerHTML = b.familiar.map(p => `<div class="row"><div><span class="k">${esc(p.name)}</span><span class="sub2">${p.distance_mi} mi · family-provided</span></div></div>`).join("");
  $("sr-haz").innerHTML = b.hazards.slice(0, 5).map(p => `<div class="row"><span class="k">${esc(p.name)}</span><span class="v danger">${p.distance_mi} mi</span></div>`).join("") || '<div class="row"><span class="muted">none in radius</span></div>';
  $("sr-call").innerHTML = b.call_first.slice(0, 5).map(p => `<div class="row"><div><span class="k">${esc(p.name)}</span><span class="sub2">${p.distance_mi} mi${p.open_now === true ? " · open" : ""}</span></div><span class="v">${p.phone ? `<a href="tel:${esc(p.phone.replace(/[^\d+]/g, ""))}">${esc(p.phone)}</a>` : ""}</span></div>`).join("");
  if ($("s-search").classList.contains("on")) renderMap();
}
function tok(name) { const el = document.createElement("i"); el.style.color = `var(${name})`; document.body.appendChild(el); const c = getComputedStyle(el).color; el.remove(); return c; }
function renderMap() {
  if (!window.L || !S) return;
  const h = S.household, b = window.B;
  if (!mapObj) { mapObj = L.map("map", {zoomControl: false, zoomAnimation: false, fadeAnimation: false, markerZoomAnimation: false}).setView([h.home.lat,h.home.lng],14); L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {attribution: '© OpenStreetMap'}).addTo(mapObj); }
  const key = JSON.stringify([h.home, h.radius_mi, b?.hazards, b?.call_first, h.familiar_places]);
  if (mapObj._nightfallKey !== key) {
    if (mapLayer) mapLayer.remove(); mapLayer = L.layerGroup().addTo(mapObj);
    const ring = L.circle([h.home.lat,h.home.lng], {radius:h.radius_mi*1609.34,color:"#245dd6",weight:1,dashArray:"4 4",fillOpacity:.03}).addTo(mapLayer);
    const points = [...(b?.hazards || []).slice(0,6), ...(b?.call_first || []).slice(0,6), ...h.familiar_places];
    if (points.length) mapObj.fitBounds(L.latLngBounds([[h.home.lat,h.home.lng], ...points.map(p=>[p.lat,p.lng])]).pad(.18), {maxZoom:15});
    L.circleMarker([h.home.lat,h.home.lng], {radius:5,color:"#fff",weight:2,fillColor:"#506078",fillOpacity:1}).addTo(mapLayer).bindPopup("Last confirmed at home");
    const hazards = (b?.hazards || []).slice(0,6), calls = (b?.call_first || []).slice(0,6);
    [...hazards.map((p,i)=>[p,i+1,"#b52b38"]),...calls.map((p,i)=>[p,hazards.length+i+1,"#23764a"])].forEach(([p,n,color]) => {
      L.marker([p.lat,p.lng], {icon:L.divIcon({className:"",html:`<div class="pin" style="background:${color}">${n}</div>`,iconSize:[24,24]})}).addTo(mapLayer).bindPopup(esc(p.name));
    });
    h.familiar_places.forEach(p=>L.circleMarker([p.lat,p.lng],{radius:7,color:"#fff",weight:2,fillColor:"#245dd6",fillOpacity:1}).addTo(mapLayer).bindPopup(esc(p.name)));
    mapObj._nightfallKey = key;
  }
  setTimeout(()=>mapObj.invalidateSize(),100);
}
function copyPolice() { const t = $("b-police").textContent; (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(() => { $("b-copied").textContent = "copied"; }).catch(() => { $("b-copied").textContent = "select and copy"; }); }
async function saveProfile() {
  const description = {}; ["sex", "height", "weight", "hair", "eyes", "build", "marks"].forEach(k => { description[k] = $("p-" + k).value.trim(); });
  $("profile-status").textContent = "Saving…";
  try {
    await requestJSON("/profile", {person_full_name: $("p-name").value.trim(), person_name: $("p-short").value.trim(), person_age: $("p-age").value === "" ? undefined : Number($("p-age").value), caregiver_name: $("p-care").value.trim(), caregiver_relationship: $("p-relationship").value.trim(), description, diagnosis: $("p-diag").value.trim(), doctor: {name: $("p-docname").value.trim(), phone: $("p-docphone").value.trim()}});
    careDrafts.delete("s-profile"); await refresh(); $("profile-status").textContent = ""; toast("Care details saved."); go("setup");
  } catch (error) { $("profile-status").textContent = error.message; }
}
async function addMember() { openInvite(); }
async function testAlert() { await runDemo("start"); }
function openBrief() { go("brief"); }
async function respond() { if (!incident) return; await post("/ack", {incident_id: incident, member_id: member}); await post("/answer", {incident_id: incident, member_id: member}); await refresh(); }
async function gotHim() { await acknowledgeIncident(); }
async function answerCall() { enableSound(); stopRing(); if (incident) post("/answer", {incident_id: incident, member_id: member}); go("call"); openingLine(); }
function startFeed() { feedStart(); }
function enableSound() { if (soundOn) return; soundOn = true; try { const a = $("ring"); a.src = ringDataUrl(); a.load(); a.volume = 1; a.play().then(() => { a.pause(); a.currentTime = 0; renderCareStatus(); }).catch(() => { soundOn = false; renderCareStatus(); toast("Tap Phone alerts to enable sound on this phone."); }); } catch (e) {} try { speechSynthesis.cancel(); speechSynthesis.speak(new SpeechSynthesisUtterance("")); } catch (e) {} }
function armPhone() { enableSound(); $("arm").hidden = true; renderCareStatus(); try { localStorage.setItem("nf-armed", "1"); } catch (e) {} }
function showArm() { $("arm").hidden = false; }
let rungFor = ""; let lastRingMsg = "";
function showIncoming(msg) { const who = (S && S.household.person_name) || "Dad"; $("inc-title").textContent = /help button/i.test(msg || "") ? "Help requested at the door" : who + " has left home"; $("inc-ctx").textContent = who + "'s care circle"; $("inc-msg").textContent = msg || ""; $("incoming").hidden = false; }
function answerFromOverlay() { $("incoming").hidden = true; answerCall(); }
function dismissOverlay() { $("incoming").hidden = true; stopRing(); go("alert"); }
function ringNow(incId, msg) { if (rungFor === incId) return; rungFor = incId; incident = incId; lastRingMsg = msg; startRing(); showIncoming(msg); fillIncoming(); }
function headingText(h) { return {left: "to the left of the door camera", right: "to the right of the door camera", away: "away from the camera, out the door", toward: "toward the camera", unknown: "direction not seen"}[h || "unknown"]; }
function fillIncoming() {
  if (!S || !S.incident) return; const inc = S.incident, c = inc.clothing;
  $("inc-wear").textContent = !c || c.source === "pending" ? "describing from the exit frame…" : (inc.clothing_line === "see photo" ? "see the exit photo" : inc.clothing_line) + " (AI-described, verify)";
  $("inc-head").textContent = headingText(inc.heading) + (inc.exited_at ? " at " + hhmm(inc.exited_at) : "");
  $("inc-911").textContent = inc.emergency ? inc.emergency.text : "not called";
  if (!/help button/i.test(lastRingMsg)) $("inc-msg").textContent = "Last seen at the entrance · " + hhmm(inc.exited_at);
  $("inc-ring").textContent = "Ringing now · " + (S.rings.length ? S.rings[S.rings.length - 1].members.join(", ") : "you") + (S.rings.length === 1 ? " is first" : "");
}
function ringDataUrl() { const sr = 8000, len = sr * 3, buf = new Uint8Array(44 + len); const w = (o, s) => [...s].forEach((c, i) => buf[o + i] = c.charCodeAt(0)); w(0, "RIFF"); w(8, "WAVEfmt "); buf[16] = 16; buf[20] = 1; buf[22] = 1; buf[24] = sr & 255; buf[25] = sr >> 8; buf[28] = sr & 255; buf[29] = sr >> 8; buf[32] = 1; buf[34] = 8; w(36, "data"); for (let i = 0; i < len; i++) { const t = i / sr, on = (t % 1) < 0.45; buf[44 + i] = on ? 128 + Math.round(110 * Math.sin(2 * Math.PI * (t < 1.5 ? 880 : 660) * t)) : 128; } const view = new DataView(buf.buffer); view.setUint32(4,36+len,true); view.setUint32(40,len,true); return "data:audio/wav;base64," + btoa(String.fromCharCode(...buf)); }
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
  await resolveMember(); await refresh(); connect(); setInterval(() => refresh().catch(() => { $("h-feedcap").textContent = "Reconnecting…"; }), 2000); startHomeFeed(); loadEnrolled(); try { $("h-edge").value = localStorage.getItem("nf-door-edge-phone") || "far"; } catch (e) {}
  $("h-edge").addEventListener("change", () => { try { localStorage.setItem("nf-door-edge-phone", $("h-edge").value); } catch (e) {} });
  document.querySelectorAll("#cam-edge button").forEach(b => b.addEventListener("click", () => { $("h-edge").value = b.dataset.e; $("h-edge").dispatchEvent(new Event("change")); syncEdge(); }));
  syncEdge();
  // Browsers only allow sound after a tap, so unlock it on the first tap anywhere instead of gating the app.
  document.addEventListener("pointerdown", () => enableSound(), {once: true});
  show(new URLSearchParams(location.search).has("join") ? "join" : location.hash.slice(1) || (S.household.person_full_name ? "home" : "setup"));
})();

// ---------- Figma screens: renderers and state-driven navigation ----------
function meName() { const m = S.household.tree.find(t => t.id === member); return m ? m.name : S.household.caregiver_name; }
function mmss(sec) { sec = Math.max(0, Math.round(sec)); return String(Math.floor(sec / 60)).padStart(2, "0") + ":" + String(sec % 60).padStart(2, "0"); }
function renderFigma() {
  const h = S.household, inc = S.incident, p = h.person_name || "Dad", first = (h.person_full_name || "").split(" ")[0] || p, me = meName();
  const tree = h.tree, others = tree.filter(m => m.id !== member).map(m => m.name);
  // setup hub
  $("su-sub").textContent = p + "'s care, in one place.";
  $("su-person").textContent = `${p} (${first})` + (h.person_age ? ", " + h.person_age : "");
  $("su-person2").textContent = [h.caregiver_name, h.caregiver_relationship, "Care details"].filter(Boolean).join(" · ");
  $("su-voice").textContent = S.voice.source === "clone" ? (S.voice.name || h.caregiver_name) + "'s cloned voice" : S.voice.name ? S.voice.name + (S.voice.source === "mock" ? " · Demo voice" : " · Ready-made voice") : "Record or choose a familiar voice";
  $("su-calls").textContent = tree.map((m, i) => (i + 1) + " " + m.name).join(" → ");
  $("su-places").textContent = (h.address || "Home") + " · " + h.radius_mi + " mi";
  const rad = pickRadius ?? h.radius_mi; $("pl-radius").textContent = rad + " mi around home"; renderRadius(rad); $("ar-sub").textContent = (h.address || "Home") + " · " + h.radius_mi + " mi around home";
  $("cam-person").textContent = `${p} (${first})`; $("arm-who").textContent = me + " · " + (tree[0] && tree[0].id === member ? "First contact" : "Care circle");
  $("pf-avatar").innerHTML = h.photo ? `<img src="${esc(h.photo)}" alt="Profile photo">` : `<img class="profile-camera-icon" src="/assets/figma/camera.svg" alt="Add photo">`;
  $("pf-meds").innerHTML = h.medications.map(m => `<div class="row"><span>${esc(m.name)}</span><span class="v">${esc((m.dose + " · " + (m.note || "")).replace(/ · $/, ""))}</span></div>`).join("") || '<div class="row"><span class="muted">None added</span></div>';
  // watch
  $("h-watch").textContent = "Watching over " + p; $("h-greet").textContent = greeting() + ", " + h.caregiver_name;
  // at the door
  $("d-title").textContent = p + " approaches the door";
  $("d-quote").textContent = inc && inc.last_line ? "“" + inc.last_line + "”" : "“Hi " + p + ". It's " + h.caregiver_name + ". Let's head back inside.”";
  $("d-cap").textContent = (inc && inc.person_in_frame ? "Person detected" : "Out of view") + " · " + (S.live_frame ? "Live" : demoMode ? "Recorded demo" : "Camera offline");
  $("d-next").textContent = `No return after ${S.door_wait_s} seconds? We call ${tree[0] ? tree[0].name : "the family"}.`;
  $("w-title").textContent = "Will " + p + " come back?"; $("w-until").textContent = "Until " + (tree[0] ? tree[0].name : "the family") + " is called";
  // alert: call order with live status
  $("a-title").textContent = inc && inc.exited_at ? p + " has left home" : inc && inc.state === "CONVERSATION" ? p + " is at the door" : "No active alert";
  $("a-nop2").textContent = `No return after ${S.door_wait_s} seconds`;
  const rungIds = S.rings.flatMap(r => r.member_ids), latest = S.rings.length ? S.rings[S.rings.length - 1].member_ids : [];
  $("a-order").innerHTML = tree.map((m, i) => { const ringing = latest.includes(m.id) && !(inc && inc.acked_by), done = rungIds.includes(m.id) && !ringing;
    const st = inc && inc.acked_by === m.id ? ["Responding", "ok"] : ringing ? ["Ringing now", "blue"] : done ? ["No answer", ""] : [i === tree.length - 1 && i > 0 ? "Then " + m.name + " + family" : "Next if no answer", ""];
    return `<div class="row"><div class="lead"><span class="badge ${ringing ? "on" : ""}">${i + 1}</span><span class="k">${esc(m.name)}</span></div><span class="v ${st[1]}">${esc(st[0])}</span></div>`; }).join("");
  $("a-ladder").textContent = `No answer? The next person is called after ${S.ladder_step_s} seconds.`;
  // brief + search
  $("b-name").textContent = inc?.exited_at ? p + " left home" : "No active alert"; $("b-seen").textContent = "Last seen " + (inc && inc.exited_at ? hhmm(inc.exited_at) : "—") + " · Front entrance";
  $("b-radius").textContent = "Within " + h.radius_mi + " mi of home"; $("sr-radius").textContent = h.radius_mi + " mi around home";
  if (window.B && window.B.hazards[0]) $("b-first").textContent = window.B.hazards[0].name;
  const dl = inc && inc.deadline_at ? (new Date(inc.deadline_at).getTime() - (Date.now() + serverOffset)) / 1000 : null;
  $("sr-rec").hidden = dl === null || !!inc?.emergency?.recommendation_due; if (dl !== null) $("sr-rect").textContent = "Emergency recommendation in " + mmss(dl);
  // responding, help, emergency
  const responder = inc?.acked_by_name || me; $("rs-who").textContent = responder + " · Responding"; $("rs-stopped").textContent = "Other care-circle calls stopped.";
  $("rs-return").textContent = inc && inc.state === "RETURNED" ? p + " is back inside." : p + "'s return is not yet confirmed.";
  $("hp-who").textContent = tree.map(m => m.name).join(" · ");
  if (inc && inc.exited_at) { const since = (Date.now() + serverOffset - new Date(inc.exited_at).getTime()) / 1000, late = !!inc.emergency?.recommendation_due;
    $("em-clock").textContent = mmss(since); $("em-sub").textContent = (since < 120 ? Math.round(since) + " seconds" : Math.round(since / 60) + " minutes") + " since the confirmed exit";
    $("em-title").textContent = late ? p + " is still missing" : "Need emergency help?"; $("em-tag").textContent = late ? "Emergency help recommended" : "Emergency option available";
    $("em-line").textContent = late ? "Nightfall recommends calling 911." : "You can choose to call 911 now."; }
}
function greeting() { const hr = new Date(Date.now() + serverOffset).getHours(); return hr < 5 || hr >= 18 ? "Good evening" : hr < 12 ? "Good morning" : "Good afternoon"; }
let routeKey = "";
function autoRoute() {
  const inc = S.incident; const key = inc ? [inc.id, inc.state, inc.acked_by || "", S.call_911 ? 1 : 0].join("|") : "none";
  if (key === routeKey) return; const prev = routeKey; routeKey = key; if (!prev) return;  // first load: stay where the user is
  if (!inc || inc.state === "CLOSED") return;
  const here = location.hash.slice(1) || "home", busy = ["talk", "takeover", "call", "brief", "search", "profile", "medical", "record", "review", "creating"].includes(here);
  if (S.call_911 && !prev.endsWith("|1") && !["RETURNED","CLOSED"].includes(inc.state)) { toast("Emergency call option available."); if (!busy && !["RETURNED","CLOSED"].includes(inc.state)) go("emergency"); return; }
  if (inc.state === "CONVERSATION" && !busy) go("door");
  else if (inc.state === "DOOR_OPEN" && !busy) go("wait");
  else if (["ESCALATING", "EXHAUSTED"].includes(inc.state) && !inc.acked_by && ["door", "wait", "home", "back"].includes(here)) go("alert");
  else if (inc.state === "RETURNED" && inc.checkin !== "self_other" && !["talk", "takeover"].includes(here)) go("back");
  else if (inc.acked_by && inc.acked_by === member && !busy) go("responding");
  else if (inc.acked_by && inc.acked_by !== member && !busy) go("alert");

}
function syncEdge() { const v = $("h-edge").value || "far"; document.querySelectorAll("#cam-edge button").forEach(b => b.classList.toggle("on", b.dataset.e === v)); }
function endCall() { try { stopAgentCall(); } catch (e) {} go(S && S.incident && S.incident.acked_by === member ? "responding" : "alert"); }
let areaMap = null, areaLayer = null, areaPoll = null, pickRadius = null, areaSearching = false;
const RADII = [0.5, 1, 1.5, 2, 3], HAZ_LABEL = {water: "Water", rail: "Rail line", motorway: "Highway", construction: "Construction"};
function renderRadius(cur) {
  const el = $("pl-rad"); if (el.dataset.cur === String(cur)) return; el.dataset.cur = String(cur);
  el.innerHTML = RADII.map(r => `<button type="button" class="${r === cur ? "on" : ""}" onclick="pickRadius = ${r}; render()">${r} mi</button>`).join("");
}
function placeRows(list, empty, label) {
  return list.map(x => `<div class="row"><div><span class="k">${esc(x.name)}</span><span class="sub2">${esc(label(x))}</span></div><span class="v">${x.distance_mi} mi</span></div>`).join("") || `<div class="row"><span class="muted">${empty}</span></div>`;
}
async function findPlaces() {
  const address = $("p-addr").value.trim() || S.household.address;
  if (!address) { toast("Enter your home address first."); return; }
  clearInterval(areaPoll); areaSearching = true; go("area"); $("ar-status").textContent = "Finding nearby places…";
  try {
    if (address !== S.household.address) await requestJSON("/profile",{address});
    await requestJSON("/setup/address",{address,radius_mi:pickRadius ?? S.household.radius_mi,google:true});
    await requestJSON("/profile",{}); pickRadius = null; careDrafts.delete("s-places"); areaSearching = false; await refresh();
    const update = async()=>{ const status = await requestJSON("/setup/status",undefined,"GET"); await renderArea(status); if (status.apify !== "running") { clearInterval(areaPoll); $("ar-status").textContent = status.apify === "done" ? "Nearby places are ready." : "Hazards are ready. Open-late places are unavailable; try again later."; } else $("ar-status").textContent = "Hazards are ready. Finding places open late…"; };
    areaPoll = setInterval(()=>update().catch(()=>{ $("ar-status").textContent="Search interrupted. Go back and try again."; clearInterval(areaPoll); }),2000); await update();
  } catch(error) { areaSearching = false; $("ar-status").textContent = "Search unavailable: " + error.message; }
}
async function renderArea(st) {
  if (!window.L || (areaSearching && !st)) return; st = st || await (await fetch("/setup/status")).json(); const home = st.home || S.household.home;
  if (!areaMap) { areaMap = L.map("area-map", {zoomControl: false, attributionControl: true, zoomAnimation: false, fadeAnimation: false, markerZoomAnimation: false}).setView([home.lat,home.lng],14); L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {attribution:"© OpenStreetMap"}).addTo(areaMap); }
  if (areaLayer) areaLayer.remove(); areaLayer = L.layerGroup().addTo(areaMap); const ring = L.circle([home.lat, home.lng], {radius: home.radius_mi * 1609.34, color: "#245dd6", weight: 1, dashArray: "4 4", fillOpacity: .04}).addTo(areaLayer);
  areaMap.setView([home.lat, home.lng], 14); areaMap.fitBounds(ring.getBounds(), {padding: [8, 8]});
  const hz = st.hazards_ranked || [], open = st.call_first || [];
  hz.slice(0, 6).forEach((x, i) => L.marker([x.lat, x.lng], {icon: L.divIcon({className: "", html: `<div class="pin" style="background:#b52b38">${i + 1}</div>`, iconSize: [22, 22]})}).addTo(areaLayer));
  open.slice(0, 10).forEach(x => L.circleMarker([x.lat, x.lng], {radius: 6, color: "#fff", weight: 2, fillColor: "#23764a", fillOpacity: 1}).addTo(areaLayer));
  $("ar-hazlist").innerHTML = placeRows(hz.slice(0, 8), st.apify === "running" ? "Still searching with Apify…" : "No water, rail, highways or construction found in this radius", x => HAZ_LABEL[x.category] || x.category);
  $("ar-calllist").innerHTML = placeRows(open.slice(0, 6), st.apify === "running" ? "Still searching with Apify…" : "No late-night places found yet", x => cap(x.category) + (x.hours ? " · " + x.hours : "") + (x.phone ? " · " + x.phone : ""));
  $("ar-haz").textContent = hz.length; $("ar-call").textContent = st.open || open.length; setTimeout(() => areaMap.invalidateSize(), 100);
}
let voiceList = [], voiceCatalog = [], voicePick = null, voiceAudio = null, previewStyle = "natural";
async function loadVoices() {
  if (!voiceList.length) { try { voiceCatalog = await (await fetch("/samples/index.json")).json(); voiceList = voiceCatalog.filter(v => v.variant === "natural"); if (voicePick === null) { const index = voiceList.findIndex(v=>v.id === S.voice.voice_id); if (index >= 0) voicePick = index; } } catch (e) { voiceList = []; } }
  $("vl-list").innerHTML = voiceList.map((v, i) => `<div class="row"><div><span class="k">${esc(v.name.replace(" (current)", ""))}</span><span class="sub2">English${voicePick === i ? " · Selected" : ""}</span></div><span class="inline"><a onclick="playVoice(${i})" style="cursor:pointer;font-weight:500">Play</a><a onclick="pickVoice(${i})" style="cursor:pointer;font-weight:600;margin-left:14px">${voicePick === i ? "&#10003;" : "Pick"}</a></span></div>`).join("") || '<div class="row"><span class="muted">No voices available.</span></div>';
  $("vl-use").disabled = voicePick === null; $("vl-use").textContent = voicePick === null ? "Use this voice" : "Use " + voiceList[voicePick].name.replace(" (current)", "");
}
function setPreviewStyle(style) { previewStyle = style; $("vl-natural").classList.toggle("on",style === "natural"); $("vl-warm").classList.toggle("on",style === "warm"); }
function playVoice(i) { if (voiceAudio) voiceAudio.pause(); const sample = voiceCatalog.find(v=>v.id === voiceList[i].id && v.variant === previewStyle) || voiceList[i]; voiceAudio = new Audio(sample.file); voiceAudio.playbackRate = Number($("vl-speed").value); voiceAudio.play().catch(() => toast("Could not play this preview.")); }
function pickVoice(i) { voicePick = i; loadVoices(); }
async function useVoice() { const v = voiceList[voicePick]; if (!v) return; await requestJSON("/voice/select", {voice_id: v.id, name: v.name.replace(" (current)",""), speed: Number($("vl-speed").value), emotion: $("vl-emotion").value}); await refresh(); go("setup"); }
