// Shared helpers: escaping, theme toggle, SSE, fetch. No framework.
function esc(s) { return String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
function nearbyCallRows(places, empty = "No open places listed in this search area.") {
  const available = (places || []).filter(p => p.open_now !== false);
  return available.map(p => {
    const status = p.open_now === true ? "Open now" : "Hours unconfirmed";
    const detail = [status, p.distance_mi + " mi", p.address].filter(Boolean).join(" · ");
    const number = p.phone ? String(p.phone).trim() : "";
    const dial = number.replace(/[^\d+]/g, "");
    const phone = /\d/.test(dial) ? `<a class="place-phone" href="tel:${esc(dial)}" aria-label="Call ${esc(p.name)} at ${esc(number)}">${esc(number)}</a>` : '<span class="sub2">Phone number unavailable</span>';
    return `<div class="row"><div class="place-details"><span class="k">${esc(p.name)}</span><span class="sub2">${esc(detail)}</span>${phone}</div></div>`;
  }).join("") || `<div class="row"><span class="cap">${esc(empty)}</span></div>`;
}
function getTheme() { try { return localStorage.getItem("nf-theme") || ""; } catch (e) { return ""; } }
function applyTheme(t) { if (t) document.documentElement.setAttribute("data-theme", t); else document.documentElement.removeAttribute("data-theme"); }
function toggleTheme() {
  const cur = document.documentElement.getAttribute("data-theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const next = cur === "dark" ? "light" : "dark";
  applyTheme(next); try { localStorage.setItem("nf-theme", next); } catch (e) {}
}
applyTheme(getTheme());
function fmtTime(iso) { const d = iso ? new Date(iso) : new Date(); return d.toLocaleTimeString([], {hour: "numeric", minute: "2-digit"}); }
async function post(path, body) { const r = await fetch(path, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify(body || {})}); return r.json(); }
function sse(path, onMsg) {
  const es = new EventSource(path);
  es.onmessage = e => { try { onMsg(JSON.parse(e.data)); } catch (err) {} };
  es.onerror = () => {};
  return es;
}
let voiceReady = false;
function speak(text) {
  if (!("speechSynthesis" in window)) return;
  const u = new SpeechSynthesisUtterance(text); u.rate = 0.92; u.pitch = 1;
  const pick = () => { const v = speechSynthesis.getVoices().find(v => /Samantha|Karen|Moira|Google US English/i.test(v.name)); if (v) u.voice = v; speechSynthesis.cancel(); speechSynthesis.speak(u); };
  if (speechSynthesis.getVoices().length) pick(); else speechSynthesis.onvoiceschanged = pick;
}
