// Plain-English view of what the door is doing and what happens next. Pure: server state in, text out.
// The timings come from /state (door wait, line gap, ladder, 15 minute mark), never hard-coded here.
function doorPlan(last, nowMs) {
  const inc = last.incident, tm = last.timing || {}, tree = last.household.tree || [];
  const who = last.household.person_name || "the person";
  const doorWait = last.door_wait_s, ladder = last.ladder || [];
  const at = (iso) => (iso ? new Date(iso).getTime() : null);
  const secs = (ms) => Math.max(0, Math.round(ms / 1000));
  const names = (tier) => {
    const m = tier >= 3 ? tree.filter((x) => x.tier <= 3) : tree.filter((x) => x.tier === tier);
    return m.map((x) => x.name).filter(Boolean).join(", ") || "no one yet (add people in Call order)";
  };
  const st = inc ? inc.state : "ARMED_IDLE";
  const next = [];
  let headline = "", sub = "";

  const verdictText = () => {
    if (!inc) return "";
    const rule = inc.verdict === "escalate" ? "will call the family if they leave" : inc.verdict === "speak_only" ? "will watch but not call" : "will not call";
    return `Score ${inc.score}/100: ${rule}. ${(inc.reasons || []).join("; ")}`;
  };

  if (st === "CONVERSATION") {
    headline = `Talking to ${who} at the door.`;
    const n = inc.lines_spoken, max = tm.max_lines || 4;
    if (inc.person_in_frame) {
      if (n < max) {
        const since = inc.last_line_at ? nowMs - at(inc.last_line_at) : 0;
        next.push({ in_s: secs((tm.line_gap_s || 8) * 1000 - since), text: `Says the next line (line ${n + 1} of ${max}).` });
      } else next.push({ text: `All ${max} lines spoken. The door stays quiet now.` });
    } else next.push({ text: "Waiting for them to come back into view." });
    next.push({ text: `If they walk out of view, a ${doorWait} s exit timer starts, then the family is called.` });
    sub = verdictText();
  } else if (st === "DOOR_OPEN") {
    headline = "Out of view. Waiting to see if they come back.";
    const left = at(inc.door_opened_at) + doorWait * 1000 - nowMs;
    if (inc.verdict === "ignore") next.push({ in_s: secs(left), text: "Stands down: this is not treated as a wander." });
    else if (inc.verdict === "speak_only") next.push({ in_s: secs(left), text: "Keeps watching only. No calls." });
    else next.push({ in_s: secs(left), text: `Calls ${names(1)}, unless they walk back into view.` });
    sub = verdictText();
  } else if (st === "WATCHING") {
    headline = "They left, but this does not look like a wander. Watching only.";
    next.push({ text: "No calls will be made unless the check changes." });
    sub = verdictText();
  } else if (st === "ESCALATING") {
    headline = "Calling the family. Nobody has answered yet.";
    const ex = at(inc.exited_at) || nowMs;
    let cum = 0;
    const done = [];
    ladder.forEach(([tier, wait], i) => {
      const when = ex + cum * 1000;
      if (when <= nowMs) done.push(names(tier));
      else next.push({ in_s: secs(when - nowMs), text: `Calls ${names(tier)}${tier >= 3 ? " (everyone)" : ""}.` });
      cum += wait;
    });
    if (inc.deadline_at) next.push({ in_s: secs(at(inc.deadline_at) - nowMs), text: "Suggests calling 911. You dial; Nightfall never does." });
    sub = done.length ? `Already called: ${done.join(" → ")}.` : "";
  } else if (st === "ACKED") {
    const m = tree.find((x) => x.id === inc.acked_by);
    headline = `${m ? m.name : "A family member"} answered. Calls stopped.`;
    next.push({ text: `If ${who} walks back into view, it is marked as back inside.` });
    if (inc.deadline_at) next.push({ in_s: secs(at(inc.deadline_at) - nowMs), text: "Suggests calling 911 if still not found. You dial." });
  } else if (st === "EXHAUSTED") {
    headline = "15 minutes since they left. Consider calling 911.";
    next.push({ text: "Nightfall never dials. Use the Call 911 button on the phone." });
  } else if (st === "VISITOR") {
    headline = "Someone is at the door. Treated as a visitor.";
    next.push({ text: "Family phones get a doorbell alert. No calls are made." });
  } else if (st === "RETURNED") {
    headline = `${who} is back inside. Alerts are cancelled.`;
    next.push({ text: "Goes back to watching the door." });
  } else if (st === "CLOSED") {
    headline = "Stood down. That was not treated as a wander.";
    next.push({ text: "Goes back to watching the door." });
  } else if (!last.night_mode) {
    const sch = last.schedule || {};
    const clock = (hhmm) => { const [h, m] = hhmm.split(":").map(Number); return ((h + 11) % 12 + 1) + ":" + String(m).padStart(2, "0") + " " + (h < 12 ? "AM" : "PM"); };
    if (sch.enabled === false) {
      headline = "Night watch is switched off. People in view are ignored.";
      next.push({ text: "Turn it on under Active times in the app." });
    } else {
      headline = "Outside the active times. People in view are ignored.";
      next.push({ text: sch.start ? `Starts watching at ${clock(sch.start)}.` : "Waits for the active times." });
    }
  } else {
    headline = "Watching the front door. No one in view.";
    next.push({ text: "If someone walks into view, the door says hello in the family's voice within a second." });
    next.push({ text: `If they leave view without stopping, the same happens, then a ${doorWait} s exit timer starts.` });
  }

  const STATE = { CONVERSATION: "The door spoke to them", DOOR_OPEN: "Exit timer started", ESCALATING: "Calling the family", RETURNED: "Back inside, alerts cancelled", CLOSED: "Stood down", EXHAUSTED: "15 minutes passed", ACKED: "A family member answered", WATCHING: "Watching only", VISITOR: "Visitor at the door" };
  const KIND = { sos: "HELP button pressed", person_enter: "Someone came into view", person_lost: "They left the camera's view", person_back: "They came back into view" };
  const recent = [];
  for (const e of last.log || []) {
    let text = "";
    if (e.type === "state" && e.rule !== "ignored") text = [KIND[e.kind], STATE[e.to]].filter(Boolean).join(" → ");
    else if (e.type === "ring") text = `Called ${(e.members || []).join(", ")} (step ${e.tier})`;
    else if (e.type === "speak") text = `Door said: “${e.text}”`;
    else if (e.type === "clothing") text = `Clothing read: ${e.line}`;
    if (text) recent.push({ ago_s: secs(nowMs - at(e.ts)), text });
  }
  return { headline, sub, next: next.slice(0, 5), recent: recent.slice(-6).reverse() };
}
if (typeof module !== "undefined") module.exports = { doorPlan };
