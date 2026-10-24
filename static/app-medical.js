// Care settings → Medical info. Medical fields go to /medical (data/medical.json, gitignored); name, height and
// weight go to /profile, where the missing-person brief already reads them. Nothing here touches the alert flow.
const Med = {rec: null, blood: [], directives: []};
const MD_FIELDS = {"md-mobility": "mobility", "md-communication": "communication", "md-implants": "implants", "md-hospital": "preferred_hospital", "md-ins": "insurance_provider", "md-insid": "insurance_member_id", "md-notes": "emergency_notes"};

async function fetchMedical() {
  const r = await (await fetch("/medical")).json();
  Med.rec = r.medical; Med.blood = r.blood_types; Med.directives = r.directives; medSummary();
}
function medSummary() {
  const m = Med.rec; if (!m || !$("su-medical")) return;
  const bits = [m.blood_type ? "Blood " + m.blood_type : "", m.allergies.length ? m.allergies.length + " allerg" + (m.allergies.length === 1 ? "y" : "ies") : "No allergies listed", m.advance_directive];
  $("su-medical").textContent = bits.filter(Boolean).join(" · ") + (m.sample ? " · sample" : "");
}
function ageFrom(dob) {
  const d = new Date(dob + "T12:00:00"); if (isNaN(d)) return undefined; const n = new Date();
  return n.getFullYear() - d.getFullYear() - ((n.getMonth() < d.getMonth() || (n.getMonth() === d.getMonth() && n.getDate() < d.getDate())) ? 1 : 0);
}
async function loadMedical() {
  await fetchMedical(); if (!S) await refresh();
  const m = Med.rec, h = S.household, d = h.description || {};
  $("md-sample").hidden = !m.sample;
  $("md-sub").textContent = "What paramedics and the ER will ask about " + (h.person_name || "Dad") + ".";
  $("md-name").value = h.person_full_name || ""; $("md-short").value = h.person_name || ""; $("md-dob").value = m.date_of_birth || "";
  $("md-height").value = d.height || ""; $("md-weight").value = d.weight || "";
  for (const [id, k] of Object.entries(MD_FIELDS)) $(id).value = m[k] || "";
  $("md-directive").innerHTML = ['<option value="">Not set</option>'].concat(Med.directives.map(x => `<option${x === m.advance_directive ? " selected" : ""}>${esc(x)}</option>`)).join("");
  $("md-doc").textContent = (h.doctor && h.doctor.name) || "No doctor added"; $("md-docphone").textContent = (h.doctor && h.doctor.phone) || "Add one in care details";
  $("md-meds").innerHTML = h.medications.map(x => `<div class="row"><span>${esc(x.name)}</span><span class="v">${esc((x.dose + " · " + (x.note || "")).replace(/ · $/, ""))}</span></div>`).join("") || '<div class="row"><span class="muted">None shared</span></div>';
  mdBlood(); mdList("allergies"); mdList("conditions");
  $("md-stat").textContent = m.updated_at ? "Saved " + new Date(m.updated_at).toLocaleString([], {month: "short", day: "numeric", hour: "numeric", minute: "2-digit"}) + ". Stored on your home server, never in the public repo." : "Stored on your home server, never in the public repo.";
}
function mdBlood() {
  $("md-blood").innerHTML = Med.blood.map(b => `<button type="button" class="${b === Med.rec.blood_type ? "on" : ""}${b === "Unknown" ? " wide" : ""}" onclick="mdPickBlood('${b}')">${esc(b === "Unknown" ? "Don't know" : b)}</button>`).join("");
}
function mdPickBlood(b) { Med.rec.blood_type = Med.rec.blood_type === b ? "" : b; mdBlood(); }
function mdList(k) {
  const items = Med.rec[k];
  $("md-" + k).innerHTML = items.map((t, i) => `<div class="row"><span>${esc(t)}</span><button type="button" class="x" aria-label="Remove" onclick="mdRemove('${k}', ${i})">×</button></div>`).join("") || `<div class="row"><span class="muted">None listed</span></div>`;
}
function mdAdd(k) {
  const el = $(k === "allergies" ? "md-allergy-new" : "md-condition-new"), t = el.value.trim(); if (!t) return;
  if (!Med.rec[k].some(x => x.toLowerCase() === t.toLowerCase())) Med.rec[k].push(t);
  el.value = ""; mdList(k);
}
function mdRemove(k, i) { Med.rec[k].splice(i, 1); mdList(k); }
document.addEventListener("keydown", e => { if (e.key !== "Enter") return; if (e.target.id === "md-allergy-new") mdAdd("allergies"); if (e.target.id === "md-condition-new") mdAdd("conditions"); });

async function saveMedical() {
  mdAdd("allergies"); mdAdd("conditions");  // a typed-but-not-added item still counts
  const btn = $("md-save"); btn.disabled = true; $("md-stat").classList.remove("saved"); $("md-stat").textContent = "Saving…";
  const body = {blood_type: Med.rec.blood_type, advance_directive: $("md-directive").value, date_of_birth: $("md-dob").value, allergies: Med.rec.allergies, conditions: Med.rec.conditions};
  for (const [id, k] of Object.entries(MD_FIELDS)) body[k] = $(id).value;
  const h = S.household, prof = {description: {...(h.description || {}), height: $("md-height").value.trim(), weight: $("md-weight").value.trim()}};
  if ($("md-name").value.trim()) prof.person_full_name = $("md-name").value.trim();
  if ($("md-short").value.trim()) prof.person_name = $("md-short").value.trim();
  const age = body.date_of_birth ? ageFrom(body.date_of_birth) : undefined; if (age !== undefined && age >= 0 && age <= 120) prof.person_age = age;
  try {
    const [m, p] = await Promise.all([fetch("/medical", {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify(body)}), post("/profile", prof)]);
    const mj = await m.json();
    if (!m.ok) throw new Error(mj.detail || "could not save medical info");
    if (!p.ok) throw new Error(p.detail || "could not save the profile");
    await refresh(); await loadMedical(); $("md-stat").classList.add("saved");
  } catch (e) { $("md-stat").textContent = String(e.message || e); }
  btn.disabled = false;
}
fetchMedical().catch(() => {});
