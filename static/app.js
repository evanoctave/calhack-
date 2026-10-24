// Shared helpers: escaping, theme toggle, SSE, fetch. No framework.
function esc(s) { return String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
function getTheme() { try { return localStorage.getItem("nf-theme") || ""; } catch (e) { return ""; } }
function applyTheme(t) { if (t) document.documentElement.setAttribute("data-theme", t); else document.documentElement.removeAttribute("data-theme"); }
function toggleTheme() {
  const cur = document.documentElement.getAttribute("data-theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const next = cur === "dark" ? "light" : "dark";
  applyTheme(next); try { localStorage.setItem("nf-theme", next); } catch (e) {}
}
applyTheme(getTheme() || "dark");
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
