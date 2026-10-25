// Signed brief links share the caregiver app's styling and retain the member-scoped token.
let sharedToken = location.hash.slice(1);
let sharedBrief = null, sharedMap = null, sharedLayer = null, sharedOffset = 0;
const byId = id => document.getElementById(id);
function briefRows(rows, detail, link = false) {
  return rows.map(p => { const href = link && p.phone ? `href="tel:${esc(p.phone.replace(/[^\d+]/g,""))}"` : "";
    return `<${href ? "a" : "div"} class="row" ${href}><div><span class="k">${esc(p.name)}</span><span class="sub2">${esc(detail(p))}</span></div></${href ? "a" : "div"}>`;
  }).join("") || '<div class="row"><span class="cap">None listed.</span></div>';
}
async function loadSharedBrief() {
  if (!sharedToken) { showBriefError(404); return; }
  try {
    const response = await fetch("/brief/" + encodeURIComponent(sharedToken));
    if (!response.ok) { showBriefError(response.status); return; }
    const b = await response.json(); sharedBrief = b; sharedOffset = new Date(b.now).getTime()-Date.now();
    byId("shared-brief").hidden = false; byId("brief-error").hidden = true;
    byId("brief-title").textContent = b.person_name + (b.state === "RETURNED" ? " is back inside" : " left home");
    byId("brief-seen").textContent = "Last seen " + fmtTime(b.last_seen_at) + " · Front entrance";
    byId("brief-clothing").textContent = b.clothing_line;
    const photo = b.exit_frames?.at(-1) || b.photo;
    if (photo && byId("brief-photo").dataset.photo !== photo) { byId("brief-photo").innerHTML = `<img ${photo === "/assets/figma/demo-camera.png" ? 'class="demo-camera"' : ""} src="${esc(photo)}" alt="Last confirmed camera image">`; byId("brief-photo").dataset.photo = photo; }
    byId("brief-state").textContent = b.state === "RETURNED" ? "Return confirmed. Pending family calls cancelled." : b.responder ? b.responder + " is responding. Return is not confirmed." : "Current location unknown.";
    byId("brief-radius").textContent = "Within " + b.home.radius_mi + " mi of home";
    byId("brief-hazards").innerHTML = briefRows(b.hazards,p=>p.category + " · " + p.distance_mi + " mi");
    byId("brief-calls").innerHTML = nearbyCallRows(b.call_first);
    byId("brief-familiar").innerHTML = briefRows(b.familiar,p=>p.note || p.distance_mi+" mi");
    byId("brief-prose").textContent = b.prose;
    byId("brief-notes").innerHTML = (b.habits || []).map(p=>`<p>${esc(p.text)}</p>`).join("");
    byId("brief-medications").innerHTML = briefRows(b.medications,p=>[p.dose,p.note].filter(Boolean).join(" · "));
    byId("brief-contacts").innerHTML = briefRows(b.contacts,p=>p.phone || p.note || "",true);
    byId("brief-police").textContent = b.police_report || "No dispatcher details added.";
    byId("brief-source").textContent = "Places · " + (b.places_source === "apify" ? "Apify" : "Saved / sample data") + " · This shared link expires in 24 hours.";
    byId("brief-app").href = "/app?member="+encodeURIComponent(b.viewer)+"#brief";
    byId("brief-ack").hidden = !!b.acked_by || !b.active;
    renderSharedMap(b); tickSharedBrief();
  } catch { byId("brief-status").textContent = "Connection interrupted. Reconnecting…"; }
}
function showBriefError(status) {
  byId("shared-brief").hidden = true; byId("brief-error").hidden = false;
  byId("error-title").textContent = status === 410 ? "This link has expired" : "This link is not valid";
  byId("error-copy").textContent = status === 410 ? "Ask someone in the care circle to send a current brief." : "Check that you opened the complete link from the family message.";
}
function tickSharedBrief() {
  if (!sharedBrief) return;
  const b=sharedBrief, seconds=Math.max(0,Math.ceil((new Date(b.deadline_at)-Date.now()-sharedOffset)/1000));
  byId("brief-timer").textContent = b.state === "RETURNED" ? "Return confirmed" : !b.active ? "Past incident" : seconds === 0 ? "Emergency help recommended" : "Emergency recommendation in " + Math.floor(seconds/60)+":"+String(seconds%60).padStart(2,"0");
}
function renderSharedMap(b) {
  if (!window.L) return;
  const key=JSON.stringify([b.home,b.hazards,b.call_first,b.familiar]);
  if (!sharedMap) { sharedMap=L.map("map",{zoomControl:false,zoomAnimation:false,fadeAnimation:false,markerZoomAnimation:false}).setView([b.home.lat,b.home.lng],14); L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png",{attribution:"© OpenStreetMap"}).addTo(sharedMap); }
  if (sharedMap._briefKey === key) return;
  if (sharedLayer) sharedLayer.remove(); sharedLayer=L.layerGroup().addTo(sharedMap);
  const ring=L.circle([b.home.lat,b.home.lng],{radius:b.home.radius_mi*1609.34,color:"#245dd6",weight:1,dashArray:"4 4",fillOpacity:.03}).addTo(sharedLayer);
  const points=[...b.hazards,...b.call_first,...b.familiar];
  if (points.length) sharedMap.fitBounds(L.latLngBounds([[b.home.lat,b.home.lng],...points.map(p=>[p.lat,p.lng])]).pad(.18),{maxZoom:15});
  b.hazards.forEach((p,i)=>L.marker([p.lat,p.lng],{icon:L.divIcon({className:"",html:`<div class="pin" style="background:#b52b38">${i+1}</div>`,iconSize:[24,24]})}).addTo(sharedLayer).bindPopup(esc(p.name)));
  [...b.call_first.map(p=>[p,"#23764a"]),...b.familiar.map(p=>[p,"#245dd6"])].forEach(([p,color])=>L.circleMarker([p.lat,p.lng],{radius:7,color:"#fff",weight:2,fillColor:color,fillOpacity:1}).addTo(sharedLayer).bindPopup(esc(p.name)));
  sharedMap._briefKey=key;
}
async function acknowledgeBrief() {
  if (!sharedBrief) return;
  byId("brief-ack").disabled=true;
  try {
    const response=await fetch("/ack",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({incident_id:sharedBrief.incident_id,member_id:sharedBrief.viewer})});
    if (!response.ok) throw new Error("This alert has changed. Open the caregiver app for the latest status.");
    await loadSharedBrief();
  } catch(error) { byId("brief-status").textContent=error.message; }
  finally { byId("brief-ack").disabled=false; }
}
async function copyDispatcher() {
  try { await navigator.clipboard.writeText(byId("brief-police").textContent); byId("brief-status").textContent="Dispatcher information copied."; }
  catch { byId("brief-status").textContent="Select and copy the dispatcher information above."; }
}
window.addEventListener("hashchange", () => { sharedToken = location.hash.slice(1); sharedBrief = null; loadSharedBrief(); });
loadSharedBrief(); setInterval(loadSharedBrief,5000); setInterval(tickSharedBrief,1000);
