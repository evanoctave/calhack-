// Care forms keep drafts across polling. Requests report failures without claiming a save succeeded.
const careDrafts = new Set();
let careHydrated = false, callOrderDraft = null, toastTimer;
const demoRequested = new URLSearchParams(location.search).get("demo") === "1";
let demoMode = false;

async function requestJSON(path, body, method = "POST") {
  const options = {method};
  if (body instanceof FormData) options.body = body;
  else if (body !== undefined) { options.headers = {"content-type": "application/json"}; options.body = JSON.stringify(body); }
  const response = await fetch(path, options);
  const data = await response.json();
  if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : "Please check the fields and try again.");
  return data;
}
function toast(message) {
  const el = document.getElementById("toast"); if (!el) return;
  el.textContent = message; el.hidden = false; clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 6000);
}
window.addEventListener("unhandledrejection", event => { toast(event.reason?.message || "Connection interrupted. Please try again."); });
document.querySelectorAll('a[onclick]:not([href]), .chip[onclick], .row.link[onclick]').forEach(el => { el.setAttribute("role", "button"); el.tabIndex = 0; });
document.addEventListener("keydown", event => { if ((event.key === "Enter" || event.key === " ") && event.target.matches('[role="button"]')) { event.preventDefault(); event.target.click(); } });
function backToApp() { if (navStack.length > 1) history.back(); else go("home"); }
document.addEventListener("input", event => {
  const screen = event.target.closest(".screen");
  if (screen) careDrafts.add(screen.id);
});
function hydrateCareForms() {
  const h = S.household;
  if (!careDrafts.has("s-profile")) {
    const values = {"p-name": h.person_full_name, "p-short": h.person_name, "p-age": h.person_age || "", "p-care": h.caregiver_name, "p-relationship": h.caregiver_relationship, "p-diag": h.diagnosis, "p-docname": h.doctor?.name, "p-docphone": h.doctor?.phone};
    for (const key of ["sex", "height", "weight", "hair", "eyes", "build", "marks"]) values["p-" + key] = h.description?.[key];
    for (const [id, value] of Object.entries(values)) $(id).value = value || "";
  }
  if (!careDrafts.has("s-places")) $("p-addr").value = h.address || "";
  careHydrated = true;
}
async function uploadPhoto(input) {
  const photo = input.files[0]; if (!photo) return;
  $("profile-status").textContent = "Saving photo…";
  try {
    const form = new FormData(); form.append("photo", photo);
    await requestJSON("/care/photo", form); await refresh(); $("profile-status").textContent = ""; toast("Profile photo saved.");
  } catch (error) { $("profile-status").textContent = error.message; }
  input.value = "";
}
function renderCallOrder() {
  const members = S.household.tree;
  if (callOrderDraft && callOrderDraft.some(id => !members.some(m => m.id === id))) callOrderDraft = null;
  const ids = callOrderDraft || members.map(m => m.id);
  const ordered = ids.map(id => members.find(m => m.id === id));
  const key = JSON.stringify(ordered);
  if ($("p-tree").dataset.key === key) return;
  $("p-tree").dataset.key = key;
  $("p-tree").innerHTML = ordered.map((m, i) => `<div class="row" draggable="true" data-member="${esc(m.id)}"><div class="lead"><span class="badge ${i === 0 ? "on" : ""}">${i + 1}</span><div><span class="k">${esc(m.name)}${m.relationship ? " · " + esc(m.relationship) : ""}</span><span class="sub2">${i === 0 ? "Call first" : i === 1 ? "Next if no answer" : "Then everyone in the care circle"}${m.id === member ? " · This phone" : ""}</span></div></div><div class="reorder"><button aria-label="Move ${esc(m.name)} up" onclick="moveContact(${i},-1)" ${i === 0 ? "disabled" : ""}>↑</button><button aria-label="Move ${esc(m.name)} down" onclick="moveContact(${i},1)" ${i === ordered.length - 1 ? "disabled" : ""}>↓</button><button aria-label="Copy link for ${esc(m.name)}" onclick="copyMemberLink('${esc(m.id)}')">Link</button><button aria-label="Remove ${esc(m.name)}" onclick="removeContact('${esc(m.id)}')">Remove</button></div></div>`).join("") || '<div class="row"><span class="muted">No one yet. Invite a family member to start the call order.</span></div>';
  let dragged;
  $("p-tree").querySelectorAll("[data-member]").forEach(row => {
    row.addEventListener("dragstart", e => { dragged = row.dataset.member; e.dataTransfer.setData("text/plain", dragged); });
    row.addEventListener("dragover", e => e.preventDefault());
    row.addEventListener("drop", e => { e.preventDefault(); const from = ids.indexOf(dragged), to = ids.indexOf(row.dataset.member); if (from < 0 || to < 0) return; callOrderDraft = [...ids]; callOrderDraft.splice(to, 0, callOrderDraft.splice(from, 1)[0]); renderCallOrder(); });
  });
}
function memberLink(id) { return (S.public_url || location.origin).replace(/\/$/, "") + "/app?member=" + encodeURIComponent(id); }
async function copyMemberLink(id) {
  const url = memberLink(id), name = (S.household.tree.find(m => m.id === id) || {}).name || "this person";
  try { await navigator.clipboard.writeText(url); toast("Link for " + name + " copied."); }
  catch (error) { toast(url); }
}
async function removeContact(id) {
  const name = (S.household.tree.find(m => m.id === id) || {}).name || "this person";
  if (!confirm("Remove " + name + " from the care circle?")) return;
  try { await requestJSON("/care/members/" + encodeURIComponent(id), undefined, "DELETE"); callOrderDraft = null; await refresh(); toast(name + " removed."); }
  catch (error) { $("calls-status").textContent = error.message; }
}
function moveContact(index, direction) {
  callOrderDraft = [...(callOrderDraft || S.household.tree.map(m => m.id))];
  const target = index + direction; if (target < 0 || target >= callOrderDraft.length) return;
  [callOrderDraft[index], callOrderDraft[target]] = [callOrderDraft[target], callOrderDraft[index]];
  renderCallOrder();
}
async function saveCallOrder() {
  try { await requestJSON("/care/call-order", {member_ids: callOrderDraft || S.household.tree.map(m => m.id)}, "PUT"); callOrderDraft = null; await refresh(); toast("Call order saved for the next alert."); go("setup"); }
  catch (error) { $("calls-status").textContent = error.message; }
}
let addrTimer, addrSeq = 0;
function suggestAddress() {
  clearTimeout(addrTimer);
  const q = $("p-addr").value.trim(); if (q.length < 4) return;
  addrTimer = setTimeout(async () => {
    const seq = ++addrSeq;
    try {
      const data = await requestJSON("/care/address-suggest?q=" + encodeURIComponent(q), undefined, "GET");
      if (seq === addrSeq) $("addr-list").innerHTML = data.suggestions.map(s => `<option value="${esc(s)}"></option>`).join("");
    } catch (error) { /* suggestions are optional */ }
  }, 350);
}
function openInvite() {
  $("invite-result").hidden = true; $("invite-create").hidden = false; $("invite-name").value = ""; $("invite-rel").value = ""; $("invite-phone").value = ""; $("invite-status").textContent = "";
  $("invite-dialog").showModal();
}
async function createInvitation() {
  $("invite-create").disabled = true;
  try {
    const result = await requestJSON("/care/members", {name: $("invite-name").value.trim(), relationship: $("invite-rel").value.trim(), phone: $("invite-phone").value.trim()});
    $("invite-url").value = result.invitation_url; $("invite-result").hidden = false; $("invite-create").hidden = true;
    callOrderDraft = null; await refresh();
  } catch (error) { $("invite-status").textContent = error.message; }
  finally { $("invite-create").disabled = false; }
}
async function shareInvitation() {
  const url = $("invite-url").value;
  try { if (navigator.share) await navigator.share({title: "Join the Nightfall care circle", url}); else { await navigator.clipboard.writeText(url); toast("Invitation link copied."); } }
  catch (error) { if (error.name !== "AbortError") { $("invite-url").select(); toast("Select and copy the invitation link."); } }
}
async function joinCircle() {
  try { const result = await requestJSON("/care/members", {name: $("join-name").value.trim()}); location.assign("/app?member=" + encodeURIComponent(result.member_id)); }
  catch (error) { $("join-status").textContent = error.message; }
}
async function savePlaces(places) {
  await requestJSON("/care/places", {places: places.map(p => ({name: p.name, note: p.note || "", lat: p.lat, lng: p.lng}))}, "PUT");
  await refresh();
}
async function deletePlace(i) {
  try { await savePlaces(S.household.familiar_places.filter((_, k) => k !== i)); toast("Place deleted."); }
  catch (error) { toast(error.message); }
}
async function addPlace() {
  const name = $("fa-name").value.trim(); if (!name) { $("places-status").textContent = "Enter a place name or address."; return; }
  $("places-status").textContent = "Adding…";
  try {
    await savePlaces([...S.household.familiar_places, {name, note: $("fa-note").value.trim()}]);
    $("fa-name").value = ""; $("fa-note").value = ""; $("places-status").textContent = ""; $("familiar-editor").hidden = true; toast("Place added.");
  } catch (error) { $("places-status").textContent = error.message; }
}
function fmtClock(hhmm) { const [h, m] = hhmm.split(":").map(Number); return ((h + 11) % 12 + 1) + ":" + String(m).padStart(2, "0") + " " + (h < 12 ? "AM" : "PM"); }
function renderSchedule() {
  const h = S.household, active = [$("sch-start"), $("sch-end")].includes(document.activeElement);
  $("sch-on").checked = h.watch_enabled;
  if (!active) { $("sch-start").value = h.night_start; $("sch-end").value = h.night_end; }
  $("sch-sum").textContent = h.watch_enabled ? "Watching " + fmtClock(h.night_start) + " to " + fmtClock(h.night_end) : "Off. Nothing is monitored.";
  $("sch-start").disabled = $("sch-end").disabled = !h.watch_enabled;
}
async function saveSchedule() {
  $("sch-status").textContent = "";
  try { await requestJSON("/care/schedule", {enabled: $("sch-on").checked, start: $("sch-start").value, end: $("sch-end").value}, "PUT"); await refresh(); }
  catch (error) { $("sch-status").textContent = error.message; await refresh(); }
}
async function clearEverything() {
  if (!confirm("Clear all information? This erases the profile, call order, address and places, voice recordings, enrolled faces, medical info and history. It cannot be undone.")) return;
  try { await requestJSON("/care/clear", {}); try { localStorage.clear(); } catch (e) {} location.hash = "#setup"; location.reload(); }
  catch (error) { toast(error.message); }
}
async function startWatch() { await requestJSON("/arm", {on: true}); await refresh(); go("home"); if (!soundOn) showArm(); }
async function acknowledgeIncident() {
  if (!incident) return;
  try { const result = await requestJSON("/ack", {incident_id: incident, member_id: member}); await refresh(); stopRing(); $("incoming").hidden = true; go(result.acked_by === member ? "responding" : "alert"); }
  catch (error) { toast(error.message); }
}
function enterDemo() { const url = new URL(location.href); url.searchParams.set("demo", "1"); url.hash = "home"; location.assign(url); }
function exitDemo() { const url = new URL(location.href); url.searchParams.delete("demo"); location.assign(url); }
function renderCareStatus() {
  demoMode = demoRequested && S.demo_available;
  document.documentElement.dataset.demo = String(demoMode);
  if ($("demo-enable")) $("demo-enable").hidden = !S.demo_available;
  $("home-live-action").hidden = demoMode;
  $("h-readiness").innerHTML = `<span class="${S.live_frame ? "ready" : demoMode ? "" : "attention"}">${S.live_frame ? "Camera connected" : demoMode ? "Recorded camera demo" : "Camera offline"}</span><button class="text-btn" onclick="showArm()">${soundOn ? "Phone sound enabled" : "Enable phone sound"}</button>`;
  $("h-watch").classList.toggle("green", !!S.live_frame || demoMode);
  if (!S.live_frame && !demoMode) $("h-watch").textContent = "Waiting for the door camera";
  if (!S.live_frame && typeof Feed !== "undefined" && Date.now() - Feed.lastAt > 10000) {
    document.querySelectorAll("img.feed-live").forEach(img => { img.style.display = "none"; });
    $("h-door").style.display = "grid";
  }
  document.querySelectorAll(".media").forEach(el => {
    const current = el.querySelector(".demo-camera");
    if (demoMode && !S.live_frame && !current && !el.querySelector("img:not(.feed-live)")) {
      const img = document.createElement("img"); img.className = "demo-camera"; img.alt = "Recorded demonstration camera image"; img.src = "/assets/figma/demo-camera.png"; el.appendChild(img);
    } else if ((!demoMode || S.live_frame) && current) current.remove();
  });
}
function renderBriefCards() {
  const b = window.B, inc = S.incident;
  const hazard = b?.hazards?.[0], call = b?.call_first?.find(p => p.phone);
  $("b-first").textContent = hazard?.name || (b ? "No nearby hazards listed" : "Brief appears after a confirmed exit");
  $("b-first-detail").textContent = hazard ? (HAZ_LABEL[hazard.category] || hazard.category) + " · " + hazard.distance_mi + " mi" : "";
  $("b-call-card").hidden = !call;
  if (call) { $("b-call-card").href = "tel:" + call.phone.replace(/[^\d+]/g, ""); $("b-call-name").textContent = call.name; $("b-call-detail").textContent = [call.open_now === true ? "Open now" : "Check opening hours", call.distance_mi + " mi", "Tap to call"].join(" · "); }
  $("b-source").textContent = "Nearby places · " + (S.places_source === "apify" ? "Apify" : "Saved / sample data");
  if (inc?.state === "RETURNED") {
    if ($("toast").textContent === "Emergency call option available.") $("toast").hidden = true;
    $("back-title").textContent = S.household.person_name + " is back inside";
    $("back-tag").textContent = S.rings.length ? "Return confirmed" : "Returned before a call";
    $("back-call-status").textContent = S.rings.length ? "Pending family calls were cancelled." : "No family call was needed.";
  }
}
async function runDemo(scenario) {
  if (!demoMode) return;
  $("scenarios").close(); enableSound();
  try { await requestJSON("/care/demo/" + scenario, {}); await refresh(); if (scenario === "start") go("door"); if (scenario === "leave") go("wait"); if (scenario === "help") go("help"); }
  catch (error) { toast(error.message); }
}
