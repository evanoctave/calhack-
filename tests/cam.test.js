// Pure detection logic from static/cam.js. Run with: node --test tests/
// The browser glue is not covered here; only the decisions that produce events.
const { test } = require("node:test");
const assert = require("node:assert");
const { zoneOf, decide, newState, DOOR_DEFAULT, HIT_FRAMES, MISS_FRAMES, POST_EVERY_MS } =
  require("../static/cam.js");

const Z = DOOR_DEFAULT;                 // {x: 0.66, w: 0.34}
const atDoor = { centreX: 0.8 };
const inRoom = { centreX: 0.2 };

function feed(state, seen, frames, t0 = 0) {
  let out = [];
  for (let i = 0; i < frames; i++) out = out.concat(decide(state, seen, t0 + i, Z));
  return out;
}

test("zoneOf splits the frame at the configured door zone", () => {
  assert.equal(zoneOf(0.2, Z), "room");
  assert.equal(zoneOf(0.65, Z), "room");
  assert.equal(zoneOf(0.66, Z), "door", "left edge is inside the zone");
  assert.equal(zoneOf(0.99, Z), "door");
});

test("a person must be seen for several frames before anything is posted", () => {
  const s = newState();
  assert.deepEqual(decide(s, atDoor, 0, Z), [], "one frame is not enough");
  const out = decide(s, atDoor, 1, Z);
  assert.equal(out.length, 2);
  assert.equal(out[0].kind, "motion");
  assert.equal(out[1].kind, "person_seen");
});

test("appearing at the door reports not-inside", () => {
  const out = feed(newState(), atDoor, HIT_FRAMES);
  const seen = out.find(e => e.kind === "person_seen");
  assert.deepEqual(seen.payload, { inside: false, zone: "door" });
});

test("appearing away from the door reports inside, which returns the incident", () => {
  const out = feed(newState(), inRoom, HIT_FRAMES);
  const seen = out.find(e => e.kind === "person_seen");
  assert.deepEqual(seen.payload, { inside: true, zone: "room" });
});

test("sightings are throttled while the person stays visible", () => {
  const s = newState();
  feed(s, atDoor, HIT_FRAMES);
  assert.deepEqual(feed(s, atDoor, 20, 1), [], "nothing within the throttle window");
  const out = decide(s, atDoor, POST_EVERY_MS + 5, Z);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, "person_seen");
});

test("absence posts nothing: the server ticker owns that decision", () => {
  const s = newState();
  feed(s, atDoor, HIT_FRAMES);
  assert.deepEqual(feed(s, null, MISS_FRAMES + 3, 100), []);
  assert.equal(s.present, false);
});

test("a single dropped frame does not count as leaving", () => {
  const s = newState();
  feed(s, atDoor, HIT_FRAMES);
  decide(s, null, 10, Z);
  assert.equal(s.present, true, "one miss is flicker, not an exit");
});

test("walking back in and out again re-announces", () => {
  const s = newState();
  feed(s, atDoor, HIT_FRAMES);
  feed(s, null, MISS_FRAMES, 100);
  const out = feed(s, atDoor, HIT_FRAMES, 200);
  assert.equal(out.filter(e => e.kind === "motion").length, 1);
});

test("moving from the door into the room flips inside", () => {
  const s = newState();
  feed(s, atDoor, HIT_FRAMES);
  const out = decide(s, inRoom, POST_EVERY_MS + 5, Z);
  assert.deepEqual(out[0].payload, { inside: true, zone: "room" });
});
