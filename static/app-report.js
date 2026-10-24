// Home → Morning report. Read-only: GET /report (history + Claude summary), POST /report/listen (Cartesia audio).
let Rep = null, repAudio = null;
async function fetchReport() { Rep = await (await fetch("/report")).json(); repHome(); return Rep; }
function repHome() {
  if (!Rep || !$("h-report")) return; const f = Rep.facts.last_night;
  $("h-report").textContent = Rep.night_label + ": " + (!f.door_approaches ? "quiet" : f.left_the_house ? "went out " + (f.left_the_house === 1 ? "once" : f.left_the_house + " times") : "came to the door, stayed in") + (Rep.includes_sample ? " · sample" : "");
}
async function loadReport() {
  $("rp-summary").textContent = "Writing this morning's report…"; $("rp-summary").className = "summary loading"; await fetchReport(); const r = Rep, f = r.facts, he = f.pronoun || "he";
  $("rp-title").textContent = r.night_label;
  $("rp-date").textContent = new Date(r.night + "T20:00:00").toLocaleDateString([], {weekday: "long", month: "short", day: "numeric"}) + " night · " + r.person_name;
  $("rp-sample").hidden = !r.includes_sample;
  $("rp-summary").textContent = r.summary; $("rp-summary").className = "summary ready";
  $("rp-source").textContent = r.summary_source === "claude" ? "Written by Claude from the night's events" : "From the night's events";
  $("rp-evlabel").textContent = "At the door, " + r.night_label.toLowerCase();
  $("rp-events").innerHTML = r.events.map(e => { const bits = [e.minutes_out ? Math.round(e.minutes_out) + " min outside" : "", e.heading, e.answered_by ? e.answered_by + " answered" : ""].filter(Boolean);
    return `<div class="row"><div><span class="k">${esc(e.time)}${e.sample ? ' <span class="tag">sample</span>' : ""}</span><span class="sub2">${esc(e.label)}${bits.length ? " · " + esc(bits.join(" · ")) : ""}</span></div></div>`; }).join("") || '<div class="row"><span class="muted">Nobody came to the door.</span></div>';
  const max = Math.max(2, ...r.week.map(w => w.approaches));
  $("rp-bars").innerHTML = r.week.map((w, i) => { const door = w.approaches - w.exits, pct = n => (n / max * 100).toFixed(0) + "%";
    return `<div class="col${i === r.week.length - 1 ? " last" : ""}${w.sample ? " sample" : ""}" style="--i:${i}" title="${w.approaches} at the door, ${w.exits} left"><div class="stack">${w.exits ? `<div class="seg-exit" style="height:${pct(w.exits)}"></div>` : ""}${door ? `<div class="seg-door" style="height:${pct(door)}"></div>` : ""}</div><span class="day">${esc(w.label)}</span></div>`; }).join("");
  $("rp-nightsk").textContent = "Nights " + he + " left";
  $("rp-nights").textContent = f.week.nights_he_left + " of " + f.week.nights;
  $("rp-usual").textContent = f.week.usual_time ? f.week.usual_time.replace(/^around /, "About ") : "—";
  $("rp-typical").textContent = f.week.typical_minutes_out ? Math.round(f.week.typical_minutes_out) + " min" : "—";
}
async function listenReport() {
  const b = $("rp-listen"); if (repAudio && !repAudio.paused) { repAudio.pause(); b.textContent = "Listen"; return; }
  if (window.speechSynthesis && speechSynthesis.speaking) { speechSynthesis.cancel(); b.textContent = "Listen"; return; }
  b.textContent = "Loading…"; b.disabled = true;
  try {
    const r = await post("/report/listen", {});
    if (r.audio && r.audio.mode === "cartesia" && r.audio.url) {
      repAudio = new Audio(r.audio.url); repAudio.onended = () => { b.textContent = "Listen"; }; await repAudio.play(); b.textContent = "Stop";
    } else if (window.speechSynthesis) {
      const u = new SpeechSynthesisUtterance(r.summary); u.onend = () => { b.textContent = "Listen"; }; speechSynthesis.speak(u); b.textContent = "Stop";
    } else b.textContent = "Listen";
  } catch (e) { b.textContent = "Listen"; }
  b.disabled = false;
}
fetchReport().catch(() => {});
