// Live transit layer: Ruter positions estimated from real-time departures (Entur Journey Planner),
// plus vehicles that report actual GPS positions (Entur vehicle positions: trains, regional buses).
(() => {
const JP = "https://api.entur.io/journey-planner/v3/graphql";
const VP = "https://api.entur.io/realtime/v2/vehicles/graphql";
const HEADERS = { "Content-Type": "application/json", "ET-Client-Name": "oslo-traffic-registry" };
const BBOX = { minLat: 59.80, minLon: 10.45, maxLat: 60.05, maxLon: 11.05 };
const SCHEDULE_MS = 60e3, GPS_MS = 15e3, TICK_MS = 1000, DETAIL_BATCH = 30, CALLS_BATCH = 50;
// Saturated, light tones that read well on the dark map
const COLORS = { bus: "#ff453a", tram: "#40b4ff", metro: "#ffa31a", rail: "#4cd964", water: "#bf8cff", coach: "#f0c060" };
const color = m => COLORS[m?.toLowerCase()] ?? "#666";

// --- passenger estimates ----------------------------------------------------
// Feeds only give an occupancy category, so we turn it into an approximate head count:
// category -> share of seats (or of standing room once seats are full) x assumed vehicle capacity.
// Capacities are rough assumptions for typical rolling stock; adjust as needed.
function capacity(op, mode, line) {
  mode = mode?.toLowerCase();
  if (op === "FLT") return { seats: 230, standing: 150 };                 // Flytoget, Type 78 unit
  if (mode === "rail") return /^L/.test(line) ? { seats: 500, standing: 400 } // local trains, often double units
                                              : { seats: 300, standing: 200 }; // regional R / RE
  if (mode === "coach") return { seats: 50, standing: 0 };
  if (mode === "tram") return { seats: 90, standing: 120 };
  if (mode === "metro") return { seats: 360, standing: 600 };
  return { seats: 40, standing: 50 };                                     // city / regional bus
}
// [share of seats taken, share of standing room taken]
const OCCUPANCY = {
  empty: [0.03, 0], manyseatsavailable: [0.25, 0], seatsavailable: [0.5, 0], fewseatsavailable: [0.85, 0],
  standingavailable: [1, 0.2], standingroomonly: [1, 0.4], crushedstandingroomonly: [1, 0.9],
  full: [1, 1], notacceptingpassengers: [1, 1]
};
function estimatePassengers(status, cap) {
  const k = OCCUPANCY[status?.toLowerCase().replace(/_/g, "")];
  if (!k) return null; // noData / unknown
  const n = k[0] * cap.seats + k[1] * cap.standing, total = cap.seats + cap.standing;
  const step = n < 20 ? 1 : n < 100 ? 5 : 10;
  return { n: Math.round(n / step) * step, frac: n / total, total };
}
// --- simulated boardings / alightings (Ruter) -----------------------------------
// No open data exists for this, so every stop visit gets a loosely predicted, *simulated* pair of numbers.
// Grounds: time of day, how busy the stop is (departures in the next 15 min, from Entur), and the delay —
// a late vehicle meets more people who have gathered at the stop, so boarding grows with delay; alighting doesn't.
const stopBusyness = new Map(); // stopPlace id -> departures (all operators) in the next 15 min, max 100
// Relative demand by hour of day (weekday shape, peaks around 08 and 16)
const HOUR_DEMAND = [.05, .03, .02, .02, .05, .2, .55, .95, 1, .7, .55, .55, .6, .6, .7, .9, 1, .9, .65, .5, .4, .3, .2, .1];
// base: boardings per stop at peak at a typical stop; headway (s): how long it takes a full
// "load" of waiting passengers to build up, so a delay of one headway doubles boarding
const SIM = { bus: { base: 4, headway: 600 }, tram: { base: 6, headway: 600 },
  metro: { base: 22, headway: 450 }, water: { base: 15, headway: 1800 } };
const EVENT_SHOW_MS = 20000; // numbers stay on the map this long after the vehicle leaves a stop

// Stable pseudo-random numbers per stop visit (same trip + stop → same numbers on every redraw)
function seeded(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) { h = Math.imul(h ^ str.charCodeAt(i), 3432918353); h = h << 13 | h >>> 19; }
  return () => {
    h = Math.imul(h ^ h >>> 16, 2246822507); h = Math.imul(h ^ h >>> 13, 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

// Commuter tide: in the morning people travel from the outer city into the centre, in the afternoon back out.
// tide(h): +1 around 08:00 (inbound), −1 around 16:30 (outbound), ~0 midday and at night.
// pos: −1 at the centre (Jernbanetorget) … +1 from ~7.5 km out. inward: +1 if the rest of the trip heads
// toward the centre, −1 if away. In the morning, boarding rises on inbound vehicles and at outer stops,
// and alighting rises near the centre; in the afternoon the same flows reverse.
const CITY_CENTRE = [59.9111, 10.7503], TIDE_STRENGTH = 0.6; // 0 = off, 1 = very strong
function tide(ms) {
  const d = new Date(ms), h = d.getHours() + d.getMinutes() / 60;
  return Math.exp(-((h - 8) ** 2) / (2 * 1.5 ** 2)) - Math.exp(-((h - 16.5) ** 2) / (2 * 1.8 ** 2));
}
function commuteFactors(c, end) {
  const km = dist(c.pos, CITY_CENTRE) / 1000;
  const pos = Math.max(-1, Math.min(1, (km - 1.5) / 3 - 1));                         // 1.5 km → −1, 7.5 km → +1
  const inward = Math.max(-1, Math.min(1, (km - dist(end.pos, CITY_CENTRE) / 1000) / 3)); // heading in over the remaining trip
  const t = tide(c.arr), k = TIDE_STRENGTH * t;
  // secondary destinations pull a little centre-like traffic: a few more alight in the morning, board in the afternoon
  const w = DEST_WEIGHT * t * destinationProximity(c.pos);
  return {
    boardF: Math.max(0.2, (1 + k * (inward + pos) / 2) * (1 - w)),
    alightF: Math.max(0.2, (1 - k * pos) * (1 + w))
  };
}

// Business districts outside the centre that attract some commuters. Deliberately weak (DEST_WEIGHT):
// they nudge the flows, the centre still dominates. Full effect within `r` metres, fading out to 1.5 × r.
const DEST_WEIGHT = 0.06;
const DESTINATIONS = [
  { name: "Fornebu", pos: [59.8955, 10.6280], r: 1200 },
  { name: "Lysaker", pos: [59.9131, 10.6363], r: 700 },
  { name: "Skøyen", pos: [59.9223, 10.6787], r: 700 },
  { name: "Nydalen", pos: [59.9497, 10.7653], r: 700 },
  { name: "Helsfyr", pos: [59.9128, 10.8008], r: 700 }
];
function destinationProximity(p) {
  let best = 0;
  for (const d of DESTINATIONS) {
    const m = dist(p, d.pos);
    best = Math.max(best, m <= d.r ? 1 : Math.max(0, 1 - (m - d.r) / (0.5 * d.r)));
  }
  return best;
}

function simulateStops(j) {
  const cap = capacity("RUT", j.mode, j.line), total = cap.seats + cap.standing;
  const m = SIM[j.mode?.toLowerCase()] ?? SIM.bus, now = Date.now(), old = j.sim ?? [];
  const sim = [];
  let onboard = 0;
  j.calls.forEach((c, i) => {
    // stops already served keep their numbers, so history doesn't shift when delays are revised
    if (old[i]?.stopId === c.stopId && c.dep < now) { sim.push(old[i]); onboard = old[i].onboard; return; }
    const rnd = seeded(`${j.id}:${i}`), noise = () => 0.6 + 0.8 * rnd(); // ±40 %
    const stopF = Math.min(3, Math.sqrt((stopBusyness.get(c.stopId) ?? 6) / 8)); // quiet ≈0.5x, hubs ≈3x
    const hourF = HOUR_DEMAND[new Date(c.arr).getHours()];
    const delayF = 1 + Math.min(Math.max(c.delay, 0), 900) / m.headway;
    const { boardF, alightF } = commuteFactors(c, j.calls.at(-1));
    const last = i === j.calls.length - 1;
    const alight = i === 0 ? 0 : last ? onboard
      : Math.min(onboard, Math.round(onboard * Math.min(0.9, Math.min(0.6, 0.06 + 0.1 * stopF) * alightF) * noise()));
    const board = last ? 0 : Math.min(Math.round(m.base * hourF * stopF * delayF * boardF * noise()), total - (onboard - alight));
    onboard += board - alight;
    sim.push({ stopId: c.stopId, board, alight, onboard, total });
  });
  j.sim = sim;
}
// Index of the stop the vehicle is at, or last left
const eventIdx = j => !j.cur ? -1 : j.cur.stopped ? j.cur.idx : j.cur.idx - 1;

// "+12 −5" beside the dot while at a stop and briefly after leaving it (zoomed in only)
function drawStopEvent(ctx, p, r, o, focused) {
  const e = o.stopEvent;
  ctx.save();
  ctx.globalAlpha = e.fade * (focused ? 1 : 0.85);
  ctx.font = `600 ${focused ? 13 : 10}px system-ui, sans-serif`;
  ctx.textAlign = "left"; ctx.textBaseline = "middle"; ctx.lineWidth = 3; ctx.strokeStyle = "#0e0f11";
  let x = p.x + r + (focused ? 16 : 6);
  for (const [txt, col] of [[`+${e.board}`, "#4cd964"], [` −${e.alight}`, "#ff8a80"]]) {
    ctx.strokeText(txt, x, p.y); ctx.fillStyle = col; ctx.fillText(txt, x, p.y);
    x += ctx.measureText(txt).width;
  }
  ctx.restore();
}

const loadColor = f => f < 0.5 ? "#4cd964" : f < 0.8 ? "#ffcc00" : "#ff453a";
const loadBar = f => `<span class="load"><span style="width:${Math.round(Math.min(f, 1) * 100)}%;background:${loadColor(f)}"></span></span>`;

// Tiny load bar under the dot (zoomed in only): share of total capacity in use
function drawLoadBar(ctx, p, r, o) {
  const w = 18, h = 3, x = p.x - w / 2, y = p.y + r + o.weight + 4;
  ctx.save();
  ctx.fillStyle = "#0e0f11"; ctx.fillRect(x - 1, y - 1, w + 2, h + 2);
  ctx.fillStyle = "#ffffff33"; ctx.fillRect(x, y, w, h);
  ctx.fillStyle = loadColor(o.load); ctx.fillRect(x, y, Math.max(1, w * Math.min(o.load, 1)), h);
  ctx.restore();
}

const layer = L.layerGroup().addTo(map);
const LABEL_ZOOM = 15; // line numbers appear above dots from this zoom level
const showLabel = l => l.options.label && l._map?.getZoom() >= LABEL_ZOOM;
// At-stop effect: only when zoomed in as far as labels, and only for a real dwell (departure after arrival)
const showStop = l => l.options.atStop && l._map?.getZoom() >= LABEL_ZOOM;

// Dots are stamped from pre-rendered sprites (one per colour/style), because a live canvas
// shadowBlur on every dot every frame is far too slow for smooth animation
const GLOW = 10, GLOW_PAD = Math.ceil(GLOW * 1.5);
const DPR = L.Browser.retina ? 2 : 1; // matches Leaflet's own canvas scaling
const sprites = new Map();
function sprite(o, r) {
  const key = [o.fillColor, o.fillOpacity, o.color, o.opacity, o.weight, r].join("|");
  let s = sprites.get(key);
  if (s) return s;
  const size = Math.ceil((r + o.weight + GLOW_PAD) * 2), c = document.createElement("canvas");
  c.width = c.height = size * DPR;
  const x = c.getContext("2d");
  x.scale(DPR, DPR);
  x.beginPath(); x.arc(size / 2, size / 2, r, 0, Math.PI * 2);
  x.shadowColor = o.fillColor + "cc"; x.shadowBlur = GLOW * DPR; // shadowBlur ignores the scale transform
  x.globalAlpha = o.fillOpacity; x.fillStyle = o.fillColor; x.fill();
  x.globalAlpha = o.opacity; x.lineWidth = o.weight; x.strokeStyle = o.color; x.stroke();
  sprites.set(key, s = { c, size });
  return s;
}

// Focused vehicle: a steady white ring plus two coloured rings pulsing outward
const RING_SPREAD = 22, PULSE_MS = 1600;
function drawFocusRings(ctx, p, r, col) {
  ctx.save();
  for (const offset of [0, 0.5]) {
    const ph = (performance.now() / PULSE_MS + offset) % 1;
    ctx.beginPath(); ctx.arc(p.x, p.y, r + 5 + ph * RING_SPREAD, 0, Math.PI * 2);
    ctx.globalAlpha = (1 - ph) * 0.9; ctx.lineWidth = 2.5; ctx.strokeStyle = col; ctx.stroke();
  }
  ctx.beginPath(); ctx.arc(p.x, p.y, r + 5, 0, Math.PI * 2);
  ctx.globalAlpha = 1; ctx.lineWidth = 2; ctx.strokeStyle = "#fff"; ctx.stroke();
  ctx.restore();
}

// At stop: a slow "breathing" halo under the dot, and a ring that fills up over the dwell time
// (full = departing). The focused vehicle gets the full version plus a countdown; others a subtle one.
const BREATH_MS = 2200;
function drawStopHalo(ctx, p, r, o, focused) {
  const b = (1 - Math.cos(performance.now() / BREATH_MS * Math.PI * 2)) / 2; // 0..1..0
  const R = r * (focused ? 3.2 : 2.2) * (0.85 + 0.15 * b);
  const g = ctx.createRadialGradient(p.x, p.y, r, p.x, p.y, R);
  const a = Math.round((focused ? 0.3 + 0.3 * b : 0.12 + 0.12 * b) * 255).toString(16).padStart(2, "0");
  g.addColorStop(0, o.fillColor + a); g.addColorStop(1, o.fillColor + "00");
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(p.x, p.y, R, 0, Math.PI * 2); ctx.fill();
  return true;
}
function drawStopTimer(ctx, p, r, o, focused) {
  const { arr, dep } = o.atStop, now = Date.now();
  const f = Math.min(1, Math.max(0, (now - arr) / (dep - arr)));
  const R = r + (focused ? 10 : 4), w = focused ? 3 : 1.5, start = -Math.PI / 2;
  ctx.save();
  ctx.lineWidth = w; ctx.lineCap = "round"; ctx.strokeStyle = o.fillColor;
  ctx.globalAlpha = focused ? 0.25 : 0.15;
  ctx.beginPath(); ctx.arc(p.x, p.y, R, 0, Math.PI * 2); ctx.stroke();
  ctx.globalAlpha = focused ? 1 : 0.75;
  ctx.beginPath(); ctx.arc(p.x, p.y, R, start, start + f * Math.PI * 2); ctx.stroke();
  if (focused) {
    const s = Math.max(0, Math.ceil((dep - now) / 1000));
    ctx.font = "600 11px system-ui, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "top";
    ctx.lineWidth = 3; ctx.strokeStyle = "#0e0f11"; ctx.fillStyle = "#fff"; ctx.globalAlpha = 1;
    const txt = `departs ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    ctx.strokeText(txt, p.x, p.y + R + 6); ctx.fillText(txt, p.x, p.y + R + 6);
  }
  ctx.restore();
}

// Canvas renderer that draws glowing sprite dots, plus each dot's line number when zoomed in
const DIM_ALPHA = 0.15; // opacity of vehicles that don't match an active search
const GlowCanvas = L.Canvas.extend({
  // Hit testing (adapted from Leaflet 1.9.4): with the enlarged hit areas (`tolerance`) overlapping in
  // busy areas, pick the dot nearest the cursor instead of Leaflet's default "last drawn wins"
  _nearestLayer(point, e) {
    let best = null, bestD = Infinity;
    for (let order = this._drawFirst; order; order = order.next) {
      const l = order.layer;
      if (!l.options.interactive || !l._containsPoint(point)) continue;
      if (e && (e.type === "click" || e.type === "preclick") && this._map._draggableMoved(l)) continue;
      const d = point.distanceTo(l._point) - (l.options.focused ? 1e6 : 0); // focused dot always wins
      if (d <= bestD) { best = l; bestD = d; }
    }
    return best;
  },
  _onClick(e) {
    const hit = this._nearestLayer(this._map.mouseEventToLayerPoint(e), e);
    this._fireEvent(hit ? [hit] : false, e);
  },
  _handleMouseHover(e, point) {
    if (this._mouseHoverThrottled) return;
    const hit = this._nearestLayer(point);
    if (hit !== this._hoveredLayer) {
      this._handleMouseOut(e);
      if (hit) {
        L.DomUtil.addClass(this._container, "leaflet-interactive"); // pointer cursor
        this._fireEvent([hit], e, "mouseover");
        this._hoveredLayer = hit;
      }
    }
    this._fireEvent(this._hoveredLayer ? [this._hoveredLayer] : false, e);
    this._mouseHoverThrottled = true;
    setTimeout(() => this._mouseHoverThrottled = false, 32);
  },
  _updateCircle(layer) {
    if (!this._drawing || layer._empty()) return;
    if (!layer.options.dimmed) return this._drawVehicle(layer);
    this._ctx.save(); this._ctx.globalAlpha = DIM_ALPHA; // search active and this vehicle doesn't match
    this._drawVehicle(layer);
    this._ctx.restore();
  },
  _drawVehicle(layer) {
    const ctx = this._ctx, p = layer._point, s = sprite(layer.options, layer._radius);
    const stop = showStop(layer) && drawStopHalo(ctx, p, layer._radius, layer.options, layer.options.focused);
    ctx.drawImage(s.c, p.x - s.size / 2, p.y - s.size / 2, s.size, s.size);
    if (layer.options.focused) drawFocusRings(ctx, p, layer._radius, layer.options.fillColor);
    if (stop) drawStopTimer(ctx, p, layer._radius, layer.options, layer.options.focused);
    if (layer.options.load != null && layer._map.getZoom() >= LABEL_ZOOM) drawLoadBar(ctx, p, layer._radius, layer.options);
    if (layer.options.stopEvent && layer._map.getZoom() >= LABEL_ZOOM) drawStopEvent(ctx, p, layer._radius, layer.options, layer.options.focused);
    if (!showLabel(layer)) return;
    ctx.save();
    ctx.font = "600 11px system-ui, sans-serif";
    ctx.textAlign = "center"; ctx.textBaseline = "bottom";
    ctx.lineWidth = 3; ctx.strokeStyle = "#0e0f11"; ctx.fillStyle = "#fff";
    const y = p.y - layer._radius - layer.options.weight - 2;
    ctx.strokeText(layer.options.label, p.x, y);
    ctx.fillText(layer.options.label, p.x, y);
    ctx.restore();
  }
});
// tolerance = extra hit radius in px around each dot (bigger on phones, where fingers are imprecise)
// padding: how far beyond the view the vehicle canvas is drawn (fraction of the view). Every full repaint covers
// it all, so keep it small; it must outlast the follow camera's MOVEEND_PX drift (~90-160 px at 10 %).
const CANVAS_PAD = 0.1;
const renderer = new GlowCanvas({ padding: CANVAS_PAD, tolerance: L.Browser.mobile ? 14 : 8 });

// Circle marker whose redraw area includes its glow and label, so moving dots don't leave trails
const VehicleMarker = L.CircleMarker.extend({
  options: { bubblingMouseEvents: false }, // a click on a vehicle must not also count as a click on the map
  _updateBounds() {
    L.CircleMarker.prototype._updateBounds.call(this);
    const b = this._pxBounds;
    const extra = this.options.stopEvent ? 64 : showStop(this) || this.options.load != null ? 8 : 0; // 64: room for "+12 −5"
    const pad = GLOW_PAD + Math.max(this.options.focused ? RING_SPREAD + 16 : 0, extra);
    this._pxBounds = L.bounds(b.min.subtract([pad, pad]), b.max.add([pad, pad]));
    if (!showLabel(this)) return;
    const p = this._point, half = this.options.label.length * 4 + 4, top = this._radius + this.options.weight + 18;
    this._pxBounds.extend(L.point(p.x - half, p.y - top)).extend(L.point(p.x + half, p.y));
  }
});

// Hover tooltip that follows its moving vehicle and re-renders its content; click focuses the vehicle.
// opts: info() for tooltip/panel; optional calls() / sim() (stop list, simulated passengers),
// route() (the journey, for the route preview) and heading() ({ deg, kmh } for the compass).
function attachVehicle(marker, opts) {
  marker.bindTooltip(() => tooltipHtml(opts.info()), { direction: "top", offset: [0, -10], className: "veh-tip" });
  marker.on("click", () => focusOn({ marker, ...opts }));
}
function moveTooltip(marker, pos) {
  if (marker.isTooltipOpen()) marker.getTooltip().setLatLng(pos);
}

// --- focus: info panel + camera follow ---------------------------------------
const FOCUS_ZOOM = 17, FOCUS_GROW = 3;
let focus = null, following = false, flying = false;
// While following, wheel / double-click / pinch zoom around the screen centre (the vehicle) instead of the cursor
// Anti-flicker while following: very thin map lines flicker under any camera motion (sub-pixel smear or
// uneven whole-pixel steps). A ~half-pixel blur on the map tiles removes that detail, letting the camera glide.
const ANTI_FLICKER = true;
function setFollowing(on) {
  following = on;
  const mode = on ? "center" : true;
  map.options.scrollWheelZoom = map.options.doubleClickZoom = map.options.touchZoom = mode;
  if (on && ANTI_FLICKER) baseTiles.ensureSoft(); // prepare softened tiles before they're shown
  map.getContainer().classList.toggle("anti-flicker", on && ANTI_FLICKER);
  if (!on) { // settle the map back onto whole pixels so it's fully crisp again
    const p = map._getMapPanePos(), r = p.round();
    if (!r.equals(p)) { L.DomUtil.setPosition(map._mapPane, r); map.fire("move"); }
    map.fire("moveend"); // the follow camera throttles moveend, so give layers one final settle
  }
}

// Info panel floats over the map just right of centre, beside the followed vehicle (positioned in CSS)
const panelEl = L.DomUtil.create("div", "info-panel", map.getContainer());
panelEl.hidden = true;
L.DomEvent.disableClickPropagation(panelEl); L.DomEvent.disableScrollPropagation(panelEl);
panelEl.addEventListener("click", e => {
  if (e.target.closest("[data-close]")) unfocus();
  if (e.target.closest("[data-follow]")) follow();
});

function focusOn(f) {
  clearTimeout(exitTimer); // a pending "click outside" must not undo this focus
  if (focus?.marker === f.marker) return follow();
  unfocus();
  focus = f;
  f.marker.options.focused = true;
  f.marker.setRadius(f.marker.getRadius() + FOCUS_GROW);
  f.marker.bringToFront();
  showRoute(f);
  follow();
  renderInfo();
}
// Fetch the map tiles covering the view at `center`/`zoom` into the browser cache (tiles are cacheable),
// so the camera move can land on a fully drawn map. Resolves when loaded or after `timeout` ms.
function preloadTiles(center, zoom, timeout = 2000) {
  const tiles = [];
  map.eachLayer(l => { if (l.tileUrl) tiles.push(l); }); // DarkTiles (index.html)
  const size = 256, c = map.project(center, zoom), half = map.getSize().divideBy(2);
  const min = c.subtract(half).divideBy(size).floor().subtract([1, 1]), max = c.add(half).divideBy(size).floor().add([1, 1]);
  const loads = [];
  for (const tl of tiles) for (let x = min.x; x <= max.x; x++) for (let y = min.y; y <= max.y; y++) {
    const img = new Image();
    img.crossOrigin = "anonymous"; // same request mode as DarkTiles, so the browser cache serves both
    loads.push(new Promise(done => { img.onload = img.onerror = done; }));
    img.src = tl.tileUrl({ x, y, z: zoom });
  }
  return Promise.race([Promise.all(loads), new Promise(done => setTimeout(done, timeout))]);
}

// Camera move in stages: 1) load the destination tiles, 2) one smooth pan+zoom onto the vehicle's
// current position, 3) hand over to per-frame tracking. Clicking another vehicle mid-load cancels this one.
let moveToken = 0;
async function follow() {
  if (!focus) return;
  const token = ++moveToken, f = focus, zoom = Math.max(map.getZoom(), FOCUS_ZOOM);
  setFollowing(true); flying = true;
  renderInfo();
  await preloadTiles(f.marker.getLatLng(), zoom);
  if (token !== moveToken) return; // a newer camera move took over
  if (focus !== f || !following) { flying = false; renderInfo(); return; } // closed or dragged while loading
  const target = f.marker.getLatLng(); // it moved while we waited
  if (zoom === map.getZoom()) map.panTo(target, { duration: 0.5 });
  else map.setView(target, zoom, { animate: true });
  const done = () => { if (token === moveToken) { flying = false; renderInfo(); } };
  map.once("moveend", done);
  setTimeout(done, 1000); // fallback if the map was already in place and no moveend fires
}
function unfocus() {
  if (focus) { focus.marker.options.focused = false; focus.marker.setRadius(focus.marker.getRadius() - FOCUS_GROW); }
  focus = null; setFollowing(false); clearRoute();
  panelEl.hidden = true;
}
map.on("dragstart", () => { if (following) { setFollowing(false); renderInfo(); } }); // manual pan releases the camera
// Clicking anywhere on the map outside a vehicle exits focus (vehicle clicks don't bubble to the map, see
// VehicleMarker; Leaflet already ignores the click that ends a drag, and the panels stop their own clicks)
// A short delay tells a single click from a double-click, which should zoom (around the vehicle) instead
let exitTimer = null;
map.on("click", () => { if (focus) { clearTimeout(exitTimer); exitTimer = setTimeout(unfocus, 250); } });
map.on("dblclick", () => clearTimeout(exitTimer));
document.addEventListener("keydown", e => { if (e.key === "Escape") unfocus(); });

// WGS84 lat/lon -> UTM (EUREF89 UTM zone 33N, the Norwegian national grid). Standard series expansion,
// accurate to well under a metre this close to the zone
function toUTM(lat, lon, zone = 33) {
  const a = 6378137, f = 1 / 298.257223563, k0 = 0.9996, e2 = f * (2 - f), ep2 = e2 / (1 - e2);
  const p = lat * Math.PI / 180, dl = (lon - (zone * 6 - 183)) * Math.PI / 180;
  const sin = Math.sin(p), cos = Math.cos(p), tan = Math.tan(p);
  const N = a / Math.sqrt(1 - e2 * sin * sin), T = tan * tan, C = ep2 * cos * cos, A = cos * dl;
  const M = a * ((1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256) * p
    - (3 * e2 / 8 + 3 * e2 ** 2 / 32 + 45 * e2 ** 3 / 1024) * Math.sin(2 * p)
    + (15 * e2 ** 2 / 256 + 45 * e2 ** 3 / 1024) * Math.sin(4 * p) - (35 * e2 ** 3 / 3072) * Math.sin(6 * p));
  const E = k0 * N * (A + (1 - T + C) * A ** 3 / 6 + (5 - 18 * T + T * T + 72 * C - 58 * ep2) * A ** 5 / 120) + 500000;
  const Nn = k0 * (M + N * tan * (A * A / 2 + (5 - T + 9 * C + 4 * C * C) * A ** 4 / 24
    + (61 - 58 * T + T * T + 600 * C - 330 * ep2) * A ** 6 / 720));
  return { E, N: Nn };
}
const fmtM = v => Math.round(v).toLocaleString("nb-NO");
function coordsHtml(ll) {
  const u = toUTM(ll.lat, ll.lng);
  return `<span>${ll.lat.toFixed(5)}° N, ${ll.lng.toFixed(5)}° E</span><span>UTM 33N ${fmtM(u.E)} E · ${fmtM(u.N)} N</span>`;
}
// Called every animation frame; throttled so the numbers stay readable and the route redraw stays cheap
let lastCoords = 0;
function updateCoords() {
  if (!focus || performance.now() - lastCoords < 100) return;
  lastCoords = performance.now();
  const el = panelEl.querySelector(".ip-coords");
  if (el) el.innerHTML = coordsHtml(focus.marker.getLatLng());
  updateCompass();
  updateRoute();
}

// --- compass (direction of travel, in the info panel) ---
const bearingOf = (a, b) => // degrees clockwise from north, a → b
  (Math.atan2((b[1] - a[1]) * Math.cos(a[0] * Math.PI / 180), b[0] - a[0]) * 180 / Math.PI + 360) % 360;
// Heading from the route shape just behind → just ahead of the vehicle; speed from the current stop-to-stop leg
function journeyHeading(j) {
  const l = j.cur;
  if (!l || l.d == null || j.cum.length < 2) return null;
  const total = j.cum.at(-1), d0 = Math.max(0, l.d - 15), d1 = Math.min(total, l.d + 25);
  if (d1 - d0 < 1) return null;
  const a = j.calls[l.idx - 1], b = j.calls[l.idx];
  const kmh = l.stopped || !a ? 0 : (b.d - a.d) / Math.max((b.arr - a.dep) / 1000, 1) * 3.6;
  return { deg: bearingOf(pointAt(j.shape, j.cum, d0), pointAt(j.shape, j.cum, d1)), kmh };
}
const COMPASS_POINTS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const compassHtml = () => `
  <div class="ip-compass">
    <svg viewBox="-24 -24 48 48" aria-hidden="true">
      <circle r="21" class="ring"/>
      ${[0, 90, 180, 270].map(a => `<line y1="-21" y2="-17" transform="rotate(${a})" class="tick"/>`).join("")}
      ${[45, 135, 225, 315].map(a => `<line y1="-21" y2="-19" transform="rotate(${a})" class="tick minor"/>`).join("")}
      <text y="-11" class="n">N</text>
      <g class="needle" style="transform: rotate(${needleDeg ?? 0}deg)"><path d="M0 -15 L5 5 L0 2 L-5 5 Z"/></g>
    </svg>
    <div><b class="hd"></b><span class="spd"></span></div>
  </div>`;
let needleDeg = null; // unwrapped angle, so the needle turns the short way across north
function updateCompass() {
  const el = panelEl.querySelector(".ip-compass");
  if (!el) return;
  const h = focus.heading?.();
  el.classList.toggle("none", !h);
  if (!h) { el.querySelector(".hd").textContent = "No heading"; el.querySelector(".spd").textContent = ""; return; }
  needleDeg = needleDeg == null ? h.deg : needleDeg + ((h.deg - needleDeg) % 360 + 540) % 360 - 180;
  el.querySelector(".needle").style.transform = `rotate(${needleDeg}deg)`;
  el.querySelector(".hd").textContent = `${COMPASS_POINTS[Math.round(h.deg / 45) % 8]} · ${Math.round(h.deg)}°`;
  el.querySelector(".spd").textContent = h.kmh == null ? "" : h.kmh < 1 ? "stationary" : `~${Math.round(h.kmh)} km/h`;
}

// --- route preview for the focused vehicle (kept subtle: thin, translucent, under the vehicles) ---
const routePane = map.createPane("route");
routePane.style.zIndex = 370; routePane.style.pointerEvents = "none"; // above zones, below vehicles
const routeLayer = L.layerGroup().addTo(map);
let route = null; // { j, past, ahead, stops: [circleMarker], col }
function showRoute(f) {
  clearRoute();
  needleDeg = null; // new vehicle: the compass needle starts fresh
  const j = f.route?.();
  if (!j?.shape || j.shape.length < 2) return; // GPS vehicles have no route shape
  const col = color(j.mode), o = { pane: "route", interactive: false, lineCap: "round", lineJoin: "round" };
  route = {
    j, col,
    past: L.polyline([], { ...o, color: col, weight: 2.5, opacity: 0.18, dashArray: "2 6" }).addTo(routeLayer),
    ahead: L.polyline([], { ...o, color: col, weight: 3, opacity: 0.45 }).addTo(routeLayer),
    stops: j.calls.map(c => L.circleMarker(c.pos, { ...o, radius: 3, weight: 1.5, color: col, fillColor: "#0e0f11", fillOpacity: 1 }).addTo(routeLayer))
  };
  updateRoute(true);
}
function clearRoute() { routeLayer.clearLayers(); route = null; }
function updateRoute() {
  if (!route || !route.j.cur) return;
  const { j } = route, d = route.j.cur.d ?? 0, here = route.j.cur.pos;
  let i = 0; // last shape vertex at or before the vehicle
  while (i < j.cum.length - 1 && j.cum[i + 1] <= d) i++;
  route.past.setLatLngs([...j.shape.slice(0, i + 1), here]);
  route.ahead.setLatLngs([here, ...j.shape.slice(i + 1)]);
  const now = Date.now(), nextIdx = j.cur.idx;
  route.stops.forEach((m, k) => {
    const done = j.calls[k].dep < now && k < nextIdx;
    const style = k === nextIdx ? { radius: 5.5, weight: 2.5, color: "#fff", opacity: 1 }
      : done ? { radius: 2.5, weight: 1, color: route.col, opacity: 0.3 } : { radius: 3, weight: 1.5, color: route.col, opacity: 0.75 };
    if (m.options.radius !== style.radius || m.options.opacity !== style.opacity) { m.setStyle(style); m.setRadius(style.radius); }
  });
}

const hhmm = ms => new Date(ms).toLocaleTimeString("nb-NO", { hour: "2-digit", minute: "2-digit" });
function renderInfo() {
  if (!focus) return;
  const i = focus.info(), mode = i.mode?.toLowerCase() ?? "", ended = !layer.hasLayer(focus.marker);
  const calls = focus.calls?.() ?? [], now = Date.now();
  const next = calls.findIndex(c => c.dep >= now), from = Math.max(next - 1, 0);
  const stops = next < 0 ? [] : calls.slice(from, next + 8), sim = focus.sim?.() ?? [];
  // simulated numbers only for stops already reached (or being served now)
  const simTxt = (c, k) => {
    const s = sim[from + k];
    return s && c.arr <= now ? `<span class="ip-sim"><b class="up">+${s.board}</b> <b class="down">−${s.alight}</b></span>` : "";
  };
  panelEl.hidden = false;
  panelEl.innerHTML = `
    <div class="ip-head"><i style="background:${color(mode)};box-shadow:0 0 8px ${color(mode)}"></i>
      <div><b>${mode} ${i.line}</b><div class="ip-dest">→ ${i.dest}</div></div>
      <button data-close title="Close (Esc)">×</button></div>
    <div class="ip-row"><span>Delay</span><b>${fmtDelay(i.delay)}</b></div>
    ${i.occ ? `<div class="ip-row"><span>Passengers</span><b>${loadBar(i.occ.frac)} ~${i.occ.n}
      <span class="ip-est">est. · capacity ~${i.occ.total}</span></b></div>` : ""}
    ${i.sim ? `<div class="ip-row"><span>On board</span><b>${loadBar(i.sim.onboard / i.sim.total)} ~${i.sim.onboard}
      <span class="ip-est">simulated · capacity ~${i.sim.total}</span></b></div>` : ""}
    ${i.next ? `<div class="ip-row"><span>${i.stopped ? "At stop" : "Next stop"}</span><b>${i.next}</b></div>` : ""}
    <div class="ip-row"><span>Position</span><b>${i.real ? `GPS · ${i.op}` : i.rt ? "Estimated (live times)" : "Estimated (timetable)"}</b></div>
    <div class="ip-row ip-heading"><span>Heading</span>${compassHtml()}</div>
    <div class="ip-row"><span>Coordinates</span><b class="ip-coords">${coordsHtml(focus.marker.getLatLng())}</b></div>
    ${stops.length ? `<ol class="ip-stops">${stops.map((c, k) => `<li class="${c.dep < now ? "past" : ""}">
      <span class="n">${c.name}${simTxt(c, k)}</span><span class="v">${hhmm(c.dep)}${Math.abs(c.delay) >= 60 ? ` <em>${fmtDelay(c.delay)}</em>` : ""}</span></li>`).join("")}</ol>
      ${sim.length ? `<div class="ip-note">Boarding (+) and alighting (−) numbers are simulated from time of day, stop size and delay.</div>` : ""}` : ""}
    <div class="ip-foot">${ended ? "Trip ended" : flying ? "Loading map…" : following ? "● Following" : `<button data-follow>Follow again</button>`}</div>`;
  updateCompass(); // fill heading text straight away (the needle is already at its last angle)
}
const journeys = new Map(); // id -> { id, date, line, mode, dest, shape, cum, calls, marker }
const gps = new Map();      // vehicleId -> { marker, ... }

async function gql(url, query) {
  const r = await fetch(url, { method: "POST", headers: HEADERS, body: JSON.stringify({ query }) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  if (j.errors && !j.data) throw new Error(j.errors[0].message);
  return j.data;
}

// --- geometry -------------------------------------------------------------
function decodePolyline(str) {
  const pts = []; let i = 0, lat = 0, lon = 0;
  while (i < str.length) {
    for (const k of [0, 1]) {
      let b, shift = 0, res = 0;
      do { b = str.charCodeAt(i++) - 63; res |= (b & 31) << shift; shift += 5; } while (b >= 32);
      const d = res & 1 ? ~(res >> 1) : res >> 1;
      if (k === 0) lat += d; else lon += d;
    }
    pts.push([lat / 1e5, lon / 1e5]);
  }
  return pts;
}
const dist = (a, b) => {
  const x = (b[1] - a[1]) * Math.cos((a[0] + b[0]) * Math.PI / 360), y = b[0] - a[0];
  return Math.sqrt(x * x + y * y) * 111320;
};
function pointAt(shape, cum, d) {
  let lo = 0, hi = cum.length - 1;
  while (lo < hi - 1) { const m = (lo + hi) >> 1; if (cum[m] <= d) lo = m; else hi = m; }
  const seg = cum[hi] - cum[lo], f = seg > 0 ? (d - cum[lo]) / seg : 0;
  return [shape[lo][0] + f * (shape[hi][0] - shape[lo][0]), shape[lo][1] + f * (shape[hi][1] - shape[lo][1])];
}

// Attach each stop to a distance along the route shape, searching forward so loops stay ordered
function projectCalls(calls, shape, cum) {
  let from = 0;
  for (const c of calls) {
    let best = from, bd = Infinity;
    for (let i = from; i < shape.length; i++) { const d = dist(shape[i], c.pos); if (d < bd) { bd = d; best = i; } }
    c.d = cum[best]; from = best;
  }
}

function buildJourney(sj, date) {
  // raw: index in the API's full stop list, so the light per-minute refresh can match times back by position
  const calls = sj.estimatedCalls.map((c, raw) => ({ c, raw })).filter(({ c }) => !c.cancellation && c.quay).map(({ c, raw }) => ({
    pos: [c.quay.latitude, c.quay.longitude], name: c.quay.name, stopId: c.quay.stopPlace?.id, raw,
    arr: Date.parse(c.expectedArrivalTime), dep: Date.parse(c.expectedDepartureTime),
    delay: (Date.parse(c.expectedDepartureTime) - Date.parse(c.aimedDepartureTime)) / 1000,
    rt: c.realtime
  }));
  let shape = sj.pointsOnLink?.points ? decodePolyline(sj.pointsOnLink.points) : null;
  if (!shape || shape.length < 2) shape = calls.map(c => c.pos);
  const cum = [0];
  for (let i = 1; i < shape.length; i++) cum.push(cum[i - 1] + dist(shape[i - 1], shape[i]));
  projectCalls(calls, shape, cum);
  return {
    id: sj.id, date, line: sj.line.publicCode, mode: sj.line.transportMode,
    dest: sj.estimatedCalls[0]?.destinationDisplay?.frontText ?? "", shape, cum, calls,
    rawCount: sj.estimatedCalls.length, li: 0 // li: locate() hint, the stop index it last found the vehicle at
  };
}

// Refresh times on a known journey, keeping its cached route shape
function updateCalls(j, sj) {
  const fresh = buildJourney({ ...sj, line: { publicCode: j.line, transportMode: j.mode } }, j.date);
  if (fresh.calls.length === j.calls.length) fresh.calls.forEach((c, i) => c.d = j.calls[i].d);
  else projectCalls(fresh.calls, j.shape, j.cum);
  j.calls = fresh.calls; j.rawCount = fresh.rawCount; j.li = 0; j.needsFull = false;
  simulateStops(j);
}

// Per-minute refresh only fetches times (stops and coordinates never change within a trip), about a third of
// the data. Times are matched back by the stop's position in the full list. If the list changed length or a
// stop got cancelled, the trip is fetched in full on the next refresh instead. (A stop being *un*-cancelled
// isn't noticed until then; rare.)
const timeFields = `estimatedCalls(date:"DATE") { aimedDepartureTime expectedArrivalTime expectedDepartureTime realtime cancellation }`;
function applyTimes(j, sj) {
  const raw = sj.estimatedCalls;
  if (raw.length !== j.rawCount || j.calls.some(c => raw[c.raw].cancellation)) { j.needsFull = true; return; }
  for (const c of j.calls) {
    const r = raw[c.raw];
    c.arr = Date.parse(r.expectedArrivalTime); c.dep = Date.parse(r.expectedDepartureTime);
    c.delay = (c.dep - Date.parse(r.aimedDepartureTime)) / 1000; c.rt = r.realtime;
  }
  j.li = 0; // times changed; let locate() search from the start once
  simulateStops(j);
}

// Where is this journey at time t? null when not running
function locate(j, t) {
  const c = j.calls;
  if (c.length < 2 || t < c[0].dep || t > c.at(-1).arr) return null;
  // resume from the stop found last time (time only moves forward); restart if the vehicle is now earlier
  let start = j.li ?? 0;
  if (start >= c.length - 1 || (start > 0 && t < c[start].arr)) start = 0;
  for (let i = start; i < c.length - 1; i++) {
    const a = c[i], b = c[i + 1];
    if (t < a.dep) { j.li = i; return { pos: a.pos, d: a.d, next: a, idx: i, stopped: true }; }
    if (t < b.arr) {
      j.li = i;
      const f = (t - a.dep) / Math.max(b.arr - a.dep, 1);
      const d = a.d + f * (b.d - a.d); // distance along the route shape, used by the route preview and compass
      return { pos: pointAt(j.shape, j.cum, d), d, next: b, idx: i + 1, stopped: false };
    }
  }
  return { pos: c.at(-1).pos, d: c.at(-1).d, next: c.at(-1), idx: c.length - 1, stopped: true };
}

// --- data loading ---------------------------------------------------------
const sjFields = `estimatedCalls(date:"DATE") { quay { name latitude longitude stopPlace { id } } aimedDepartureTime
  expectedArrivalTime expectedDepartureTime realtime cancellation destinationDisplay { frontText } }`;

async function discover() {
  const d = await gql(JP, `{ stopPlacesByBbox(minimumLatitude:${BBOX.minLat}, minimumLongitude:${BBOX.minLon},
    maximumLatitude:${BBOX.maxLat}, maximumLongitude:${BBOX.maxLon}) { id
      estimatedCalls(timeRange: 900, numberOfDepartures: 100) { date serviceJourney { id } } } }`);
  const found = new Map();
  for (const sp of d.stopPlacesByBbox) {
    stopBusyness.set(sp.id, sp.estimatedCalls.length); // feeds the passenger simulation
    for (const c of sp.estimatedCalls)
      if (c.serviceJourney.id.startsWith("RUT:")) found.set(c.serviceJourney.id, c.date);
  }
  return found;
}

async function batched(ids, size, build, apply) {
  for (let i = 0; i < ids.length; i += size) {
    const chunk = ids.slice(i, i + size);
    try {
      const d = await gql(JP, "{" + chunk.map((id, k) => `j${k}: ${build(id)}`).join("\n") + "}");
      chunk.forEach((id, k) => d[`j${k}`] && apply(id, d[`j${k}`]));
    } catch (e) { console.warn("transit batch failed", e); }
  }
}

async function refreshSchedule() {
  const found = await discover();
  const now = Date.now();
  // forget journeys that have finished
  for (const [id, j] of journeys) if (!found.has(id) && (j.calls.at(-1)?.arr ?? 0) < now) {
    if (j.marker && layer.hasLayer(j.marker)) layer.removeLayer(j.marker);
    journeys.delete(id);
  }
  const fresh = [...found.keys()].filter(id => !journeys.has(id));
  const refull = [...journeys.keys()].filter(id => journeys.get(id).needsFull);
  const known = [...journeys.keys()].filter(id => !journeys.get(id).needsFull);
  await batched(fresh, DETAIL_BATCH,
    id => `serviceJourney(id:"${id}") { id line { publicCode transportMode } pointsOnLink { points } ${sjFields.replace("DATE", found.get(id))} }`,
    (id, sj) => { const j = buildJourney(sj, found.get(id)); simulateStops(j); journeys.set(id, j); });
  await batched(refull, CALLS_BATCH,
    id => `serviceJourney(id:"${id}") { id ${sjFields.replace("DATE", journeys.get(id).date)} }`,
    (id, sj) => updateCalls(journeys.get(id), sj));
  await batched(known, CALLS_BATCH,
    id => `serviceJourney(id:"${id}") { id ${timeFields.replace("DATE", journeys.get(id).date)} }`,
    (id, sj) => applyTimes(journeys.get(id), sj));
}

async function refreshGps() {
  const d = await gql(VP, `{ vehicles(boundingBox:{minLat:${BBOX.minLat}, minLon:${BBOX.minLon},
    maxLat:${BBOX.maxLat}, maxLon:${BBOX.maxLon}}) { vehicleId mode lastUpdated delay destinationName
    occupancyStatus bearing codespace { codespaceId } line { publicCode } location { latitude longitude } } }`);
  const seen = new Set(), stale = Date.now() - 5 * 60e3;
  for (const v of d.vehicles) {
    if (v.codespace?.codespaceId === "RUT" || Date.parse(v.lastUpdated) < stale) continue; // Ruter is drawn from estimates
    const key = v.codespace?.codespaceId + ":" + v.vehicleId; seen.add(key);
    const pos = [v.location.latitude, v.location.longitude];
    let g = gps.get(key);
    if (!g) {
      g = { marker: new VehicleMarker(pos, { renderer, radius: 8, weight: 2.5, color: "#fff", fillOpacity: 1, fillColor: color(v.mode) }).addTo(layer) };
      attachVehicle(g.marker, { info: () => g.info, heading: () => g.bearing == null ? null : { deg: g.bearing, kmh: g.kmh } });
      gps.set(key, g);
    }
    g.mode = v.mode; g.delay = v.delay;
    const op = v.codespace?.codespaceId, line = v.line?.publicCode ?? "";
    g.info = { line, mode: v.mode, dest: v.destinationName ?? "", delay: v.delay, real: true, op,
      occ: estimatePassengers(v.occupancyStatus, capacity(op, v.mode, line)) };
    g.marker.options.label = line;
    g.marker.options.load = g.info.occ?.frac ?? null;
    if (g.marker.options.fillColor !== color(v.mode)) g.marker.setStyle({ fillColor: color(v.mode) });
    // glide from where the dot is now to the new fix; snap if it jumped far (e.g. after a data gap)
    const cur = g.marker.getLatLng();
    g.from = dist([cur.lat, cur.lng], pos) > 2000 ? pos : [cur.lat, cur.lng];
    g.to = pos; g.t0 = Date.now();
    // compass data: the feed's own bearing when given, else from movement; speed from consecutive fixes
    const fixT = Date.parse(v.lastUpdated);
    if (g.fix && fixT > g.fix.t) {
      const m = dist(g.fix.pos, pos);
      g.kmh = m / ((fixT - g.fix.t) / 1000) * 3.6;
      if (v.bearing == null && m > 5) g.bearing = bearingOf(g.fix.pos, pos);
    }
    if (v.bearing != null) g.bearing = v.bearing;
    if (!g.fix || fixT > g.fix.t) g.fix = { pos, t: fixT };
  }
  for (const [k, g] of gps) if (!seen.has(k)) { layer.removeLayer(g.marker); gps.delete(k); }
}

// --- rendering ------------------------------------------------------------
const fmtDelay = s => s == null ? "–" : Math.abs(s) < 60 ? "on time" : (s > 0 ? "+" : "−") + Math.round(Math.abs(s) / 60) + " min";

function tooltipHtml(i) {
  const mode = i.mode?.toLowerCase() ?? "";
  return `<div class="t-head"><i style="background:${color(mode)}"></i><b>${mode} ${i.line}</b> → ${i.dest}</div>` +
    (i.next ? `<div>${i.stopped ? "At" : "Next"}: ${i.next}</div>` : "") +
    `<div>${fmtDelay(i.delay)}</div>` +
    (i.occ ? `<div>${loadBar(i.occ.frac)} ~${i.occ.n} passengers <span class="t-est">est.</span></div>` : "") +
    (i.sim ? `<div>${loadBar(i.sim.onboard / i.sim.total)} ~${i.sim.onboard} on board <span class="t-est">sim.</span></div>` : "") +
    `<div class="t-src">${i.real ? `GPS position · ${i.op}` : i.rt ? "Estimated from live departure times" : "Estimated from timetable"}</div>`;
}

// --- simulated passenger totals for the dashboard ------------------------------
// Each stop visit is tallied once, when the vehicle reaches it. Counting starts at page load: trips already
// under way when first seen skip their earlier stops (we didn't watch those happen).
const PAX_WINDOW_MIN = 30;
const pax = { since: Date.now(), board: 0, alight: 0, onboard: 0, byMode: {}, byStop: new Map(), minutes: new Map(),
  zoneMinutes: new Map(), dir: { in: 0, out: 0, cross: 0 } }; // zoneMinutes: minute -> { zone: { board, alight } }
const addTo = (o, s) => { o.board += s.board; o.alight += s.alight; return o; };

function tallyStops(j, ev, t) {
  if (j.tallied === undefined) j.tallied = t - (j.calls[0]?.dep ?? 0) < 60e3 ? -1 : ev; // just left its first stop → count it
  for (let k = j.tallied + 1; k <= ev; k++) {
    const s = j.sim?.[k], c = j.calls[k];
    if (!s || !c) continue;
    addTo(pax, s);
    addTo(pax.byMode[j.mode] ??= { board: 0, alight: 0 }, s);
    if (!pax.byStop.has(c.name)) pax.byStop.set(c.name, { board: 0, alight: 0 });
    addTo(pax.byStop.get(c.name), s);
    const minute = Math.floor(t / 60e3);
    if (!pax.minutes.has(minute)) pax.minutes.set(minute, { board: 0, alight: 0 });
    addTo(pax.minutes.get(minute), s);
    const zm = pax.zoneMinutes.get(minute) ?? {}, zone = c.zone ??= zoneOf(c.pos);
    addTo(zm[zone] ??= { board: 0, alight: 0 }, s);
    pax.zoneMinutes.set(minute, zm);
  }
  j.tallied = Math.max(j.tallied, ev);
}

// Animation: every frame (rate set by zoom, see frameMsForZoom) moves the dots in view; once a second a full pass also
// updates off-screen dots, adds/removes vehicles and recomputes the panel stats.
const GPS_TWEEN_MS = 3000;
// Animation interval by zoom. At z12 a 30 km/h bus moves ~0.2 px/s on screen, so 4 fps looks identical to 30
// while repainting the vehicle canvas ~85 % less. The pulsing stop/focus effects only appear from z15 (30 fps).
const frameMsForZoom = z => z <= 12 ? 250 : z <= 13 ? 125 : z <= 14 ? 66 : 33;
// ~60 fps cap while following. Slightly under 16.7 ms so a 60 Hz screen still gets every frame;
// 120 Hz runs every 2nd display frame (60 fps), 144 Hz every 2nd (72 fps).
const FOLLOW_FRAME_MS = 12.5;
// Follow camera: a critically damped spring (no overshoot) that smooths both position and speed, so
// sudden speed changes of the vehicle (leaving a stop, a new GPS fix) are eased out too.
// CAMERA_SMOOTH_MS ≈ how far the camera trails: higher = smoother, but the vehicle sits further off centre.
const CAMERA_SMOOTH_MS = 350;
let camFloat = null, camVel = L.point(0, 0); // camera position (fractional px) and speed (px/s); map sits on whole px
// "moveend" makes Leaflet reset the vehicle canvas (resize = reallocate + redraw every vehicle) and re-fit the
// SVG layers. Firing it every frame while following halved the frame rate, so the camera fires it only after
// drifting MOVEEND_PX or every MOVEEND_MS. The canvas is drawn 20 % beyond the view (padding), so it stays covered.
const MOVEEND_PX = 60, MOVEEND_MS = 500;
let lastMoveEnd = { pos: null, t: 0 };
function cameraMoveEnd(pos) {
  const now = performance.now();
  if (lastMoveEnd.pos && lastMoveEnd.pos.distanceTo(pos) < MOVEEND_PX && now - lastMoveEnd.t < MOVEEND_MS) return;
  lastMoveEnd = { pos, t: now };
  map.fire("moveend");
}
function smoothDamp(cur, goal, vel, smoothTime, dt) { // standard "SmoothDamp" spring step
  const omega = 2 / smoothTime, x = omega * dt, decay = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = cur - goal, temp = (vel + omega * change) * dt;
  return [goal + (change + temp) * decay, (vel - omega * temp) * decay];
}
let stats = { modes: {}, est: 0, delays: [] }, lastFull = 0, lastFrame = 0;

function frame(now) {
  requestAnimationFrame(frame);
  // Following: up to ~60 fps (smooth camera without paying 2-2.4x on 120/144 Hz screens). Otherwise the rate
  // depends on zoom: zoomed out, vehicles move far less than a pixel between frames, so redraw less often.
  if (now - lastFrame < (following ? FOLLOW_FRAME_MS : frameMsForZoom(map.getZoom())) || !map.hasLayer(layer)) return;
  const dt = now - lastFrame;
  lastFrame = now;
  const t = Date.now(), full = t - lastFull >= TICK_MS, view = map.getBounds().pad(CANVAS_PAD);
  const modes = {}, delays = [];
  let est = 0, onboard = 0;
  const dir = { in: 0, out: 0, cross: 0 };
  let matched = 0; // vehicles matching the active search
  for (const j of journeys.values()) {
    if (!full && !(j.marker && j.visible && view.contains(j.marker.getLatLng()))) continue;
    const loc = locate(j, t);
    if (!loc) {
      if (j.calls.length && t > j.calls.at(-1).arr) tallyStops(j, j.calls.length - 1, t); // trip ended: everyone alights at the last stop
      if (j.visible) { layer.removeLayer(j.marker); j.visible = false; }
      continue;
    }
    if (!j.marker) {
      j.marker = new VehicleMarker(loc.pos, { renderer, radius: 6, weight: 1.5, color: "#fff", label: j.line, fillColor: color(j.mode) });
      attachVehicle(j.marker, { info: () => ({ line: j.line, mode: j.mode, dest: j.dest, delay: j.cur?.next.delay,
        next: j.cur?.next.name, stopped: j.cur?.stopped, rt: j.cur?.next.rt, real: false,
        sim: j.sim?.[eventIdx(j)] }), calls: () => j.calls, sim: () => j.sim, route: () => j, heading: () => journeyHeading(j) });
    }
    if (!j.visible) { layer.addLayer(j.marker); j.visible = true; }
    j.cur = loc;
    j.marker.options.atStop = loc.stopped && loc.next.dep > loc.next.arr && t >= loc.next.arr ? loc.next : null;
    // simulated "+board −alight" while at a stop and for a short while after leaving it
    const ev = eventIdx(j), s = j.sim?.[ev], since = t - (j.calls[ev]?.dep ?? 0);
    j.marker.options.stopEvent = s && (s.board || s.alight) && (loc.stopped || since < EVENT_SHOW_MS)
      ? { board: s.board, alight: s.alight, fade: loc.stopped ? 1 : 1 - since / EVENT_SHOW_MS } : null;
    const fillOpacity = loc.next.rt ? 1 : 0.55;
    if (j.marker.options.fillOpacity !== fillOpacity) j.marker.setStyle({ fillOpacity });
    j.marker.setLatLng(loc.pos);
    moveTooltip(j.marker, loc.pos);
    if (full) {
      modes[j.mode] = (modes[j.mode] ?? 0) + 1; est++;
      if (loc.next.rt) delays.push({ line: j.line, mode: j.mode, dest: j.dest, delay: loc.next.delay });
      tallyStops(j, ev, t);
      const hit = matchesJourney(j, t); setDim(j.marker, hit); if (highlight && hit) matched++;
      onboard += j.sim?.[ev]?.onboard ?? 0;
      addDirection(dir, j, ev);
    }
  }
  for (const g of gps.values()) {
    if (full) {
      const m = g.mode?.toLowerCase(); modes[m] = (modes[m] ?? 0) + 1;
      const hit = matchesGps(g); setDim(g.marker, hit); if (highlight && hit) matched++;
    }
    if (!g.to) continue;
    const f = Math.min(1, (t - g.t0) / GPS_TWEEN_MS), e = f * (2 - f); // ease-out
    const pos = [g.from[0] + e * (g.to[0] - g.from[0]), g.from[1] + e * (g.to[1] - g.from[1])];
    g.marker.setLatLng(pos);
    moveTooltip(g.marker, pos);
    if (f === 1) g.to = null;
  }
  if (focus) focus.marker.redraw(); // keeps the focus pulse animating even while the vehicle waits at a stop
  updateCoords();
  // Keep the focused vehicle centred. The camera eases toward it (exponential smoothing, ~CAMERA_SMOOTH_MS
  // behind). Its position is tracked in fractional pixels (camFloat) so the motion stays smooth, but the map
  // is only ever placed on whole (physical) pixels: tiles between pixels make their fine lines shimmer. Rounding the
  // absolute position (not each step, as Leaflet's panBy does) keeps the error under half a pixel, with no drift.
  if (focus && following && !flying && !map._animatingZoom && layer.hasLayer(focus.marker)) {
    const pane = map._getMapPanePos();
    if (!camFloat || camFloat.distanceTo(pane) > 1) { camFloat = pane.clone(); camVel = L.point(0, 0); } // (re)sync after zoom, drag, etc.
    // vehicle offset from centre as seen by the fractional camera
    const off = map.latLngToContainerPoint(focus.marker.getLatLng()).subtract(map.getSize().divideBy(2))
      .add(camFloat.subtract(pane));
    if (!map.getSize().contains(off)) { map.panBy(off, { animate: false }); camFloat = null; } // far off (tab was hidden): snap
    else {
      const goal = camFloat.subtract(off), s = Math.min(dt, 100) / 1000;
      [camFloat.x, camVel.x] = smoothDamp(camFloat.x, goal.x, camVel.x, CAMERA_SMOOTH_MS / 1000, s);
      [camFloat.y, camVel.y] = smoothDamp(camFloat.y, goal.y, camVel.y, CAMERA_SMOOTH_MS / 1000, s);
      // Anti-flicker on: glide at fractional positions while the map shows pre-softened tiles (DarkTiles in
      // index.html), which removes the sub-pixel detail that would shimmer. Off: snap to physical pixels instead.
      const dpr = window.devicePixelRatio || 1;
      const target = ANTI_FLICKER ? camFloat.clone()
        : L.point(Math.round(camFloat.x * dpr) / dpr, Math.round(camFloat.y * dpr) / dpr);
      if (!target.equals(pane)) {
        L.DomUtil.setPosition(map._mapPane, target);
        map.fire("move"); // cheap: tooltips and the tile layer's throttled loading listen to this
        cameraMoveEnd(target);
      }
    }
  }
  if (full) {
    stats = { modes, est, delays }; lastFull = t;
    pax.onboard = onboard;
    pax.dir = dir;
    renderSearchStatus(matched);
    for (const m of pax.zoneMinutes.keys()) if (m < Math.floor(t / 60e3) - PAX_WINDOW_MIN) pax.zoneMinutes.delete(m);
    for (const m of pax.minutes.keys()) if (m < Math.floor(t / 60e3) - PAX_WINDOW_MIN) pax.minutes.delete(m);
    if (focus) { if (!layer.hasLayer(focus.marker) && following) setFollowing(false); renderInfo(); }
  }
}

function renderPanel() {
  const { modes, est, delays } = stats;
  const total = Object.values(modes).reduce((a, b) => a + b, 0);
  document.getElementById("tTotal").textContent = total.toLocaleString("nb-NO") + " vehicles";
  document.getElementById("tSub").textContent = `${gps.size} GPS · ${est} estimated (Ruter)`;
  document.getElementById("tModes").innerHTML = Object.entries(modes).sort((a, b) => b[1] - a[1])
    .map(([m, n]) => `<span><i style="background:${color(m)}"></i>${m} <b>${n}</b></span>`).join("");
  const late = delays.filter(d => d.delay >= 60);
  const avg = delays.length ? delays.reduce((a, d) => a + Math.max(d.delay, 0), 0) / delays.length : 0;
  document.getElementById("tDelay").textContent = delays.length
    ? `${Math.round(100 * late.length / delays.length)}% running ≥1 min late · avg ${(avg / 60).toFixed(1)} min` : "";
  document.getElementById("tLate").innerHTML = late.sort((a, b) => b.delay - a.delay).slice(0, 5)
    .map(d => `<li><span class="n"><i style="background:${color(d.mode)}"></i>${d.line} → ${d.dest}</span><span class="v">${fmtDelay(d.delay)}</span></li>`).join("");
  renderPax();
  renderTrends();
}

const fmtN = n => Math.round(n).toLocaleString("nb-NO");
function renderPax() {
  const $ = id => document.getElementById(id);
  $("pOnboard").textContent = "~" + fmtN(pax.onboard);
  $("pBoard").textContent = fmtN(pax.board);
  $("pAlight").textContent = fmtN(pax.alight);
  $("pSince").textContent = `since ${hhmm(pax.since)}`;
  $("pModes").innerHTML = Object.entries(pax.byMode).sort((a, b) => b[1].board - a[1].board)
    .map(([m, v]) => `<li><span class="n"><i style="background:${color(m)}"></i>${m}</span>
      <span class="v"><b class="up">+${fmtN(v.board)}</b> <b class="down">−${fmtN(v.alight)}</b></span></li>`).join("");
  $("pStops").innerHTML = [...pax.byStop].sort((a, b) => (b[1].board + b[1].alight) - (a[1].board + a[1].alight)).slice(0, 5)
    .map(([name, v]) => `<li><span class="n">${name}</span>
      <span class="v"><b class="up">+${fmtN(v.board)}</b> <b class="down">−${fmtN(v.alight)}</b></span></li>`).join("");
  drawPaxChart($("pChart"));
}

// Per-minute boardings (up, green) and alightings (down, red) over the last PAX_WINDOW_MIN minutes
function drawPaxChart(svg) {
  const W = svg.clientWidth || 300, H = 80, mid = H / 2, nowMin = Math.floor(Date.now() / 60e3);
  const rows = [];
  for (let m = nowMin - PAX_WINDOW_MIN + 1; m <= nowMin; m++) rows.push({ m, ...(pax.minutes.get(m) ?? { board: 0, alight: 0 }) });
  const max = Math.max(1, ...rows.map(r => Math.max(r.board, r.alight))), bw = W / rows.length;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.innerHTML = `<line x1="0" x2="${W}" y1="${mid}" y2="${mid}" class="axis"/>` + rows.map((r, i) => {
    const hb = (r.board / max) * (mid - 2), ha = (r.alight / max) * (mid - 2), x = i * bw + 0.5, w = Math.max(bw - 1, 1);
    return `<g><title>${hhmm(r.m * 60e3)} · +${r.board} boarded, −${r.alight} alighted</title>
      <rect x="${x}" y="${mid - hb}" width="${w}" height="${hb}" class="up"/>
      <rect x="${x}" y="${mid}" width="${w}" height="${ha}" class="down"/></g>`;
  }).join("");
}

// --- search: highlight a line or a stop -------------------------------------------
// Line: its vehicles stay bright (others dim) and its route(s) are drawn. Stop: the map flies there and the
// vehicles due at it within SEARCH_STOP_MIN stay bright.
const SEARCH_STOP_MIN = 20;
const searchInput = document.getElementById("search"), searchResults = document.getElementById("searchResults");
const searchStatus = document.getElementById("searchStatus");
const searchLayer = L.layerGroup().addTo(map);
let highlight = null; // { type: "line", line } | { type: "stop", name, ids: Set<stopPlaceId>, pos }

function searchIndex() {
  const lines = new Map(), stops = new Map(); // line -> { line, mode, count }; name -> { name, ids, pos }
  const addLine = (line, mode) => {
    if (!line) return;
    const e = lines.get(line) ?? { line, mode: mode?.toLowerCase(), count: 0 };
    e.count++; lines.set(line, e);
  };
  for (const j of journeys.values()) {
    if (j.visible) addLine(j.line, j.mode);
    for (const c of j.calls) {
      if (!c.name) continue;
      const s = stops.get(c.name) ?? { name: c.name, ids: new Set(), pos: c.pos };
      if (c.stopId) s.ids.add(c.stopId);
      stops.set(c.name, s);
    }
  }
  for (const g of gps.values()) addLine(g.info?.line, g.mode);
  return { lines, stops };
}

function renderResults() {
  const q = searchInput.value.trim().toLowerCase();
  if (!q) { searchResults.innerHTML = ""; return; }
  const { lines, stops } = searchIndex();
  const ls = [...lines.values()].filter(l => l.line.toLowerCase().startsWith(q))
    .sort((a, b) => (a.line.toLowerCase() === q ? -1 : 0) - (b.line.toLowerCase() === q ? -1 : 0) || a.line.localeCompare(b.line, "nb", { numeric: true }))
    .slice(0, 5);
  const ss = [...stops.values()].filter(s => s.name.toLowerCase().includes(q))
    .sort((a, b) => a.name.toLowerCase().indexOf(q) - b.name.toLowerCase().indexOf(q) || a.name.localeCompare(b.name, "nb"))
    .slice(0, 6);
  searchResults.innerHTML = [
    ...ls.map(l => `<li data-line="${l.line}"><span class="n"><i style="background:${color(l.mode)}"></i>Line ${l.line}
      <span class="r">${l.mode ?? ""}</span></span><span class="v">${l.count} running</span></li>`),
    ...ss.map(s => `<li data-stop="${s.name.replace(/"/g, "&quot;")}"><span class="n"><i class="stop"></i>${s.name}</span><span class="v">stop</span></li>`)
  ].join("") || `<li class="empty">No running line or known stop matches</li>`;
}

function selectLine(line) {
  clearHighlight(false);
  highlight = { type: "line", line };
  // draw each distinct route shape of the line once (directions / variants differ)
  const seen = new Set(), bounds = L.latLngBounds([]);
  for (const j of journeys.values()) {
    if (j.line !== line || !j.shape || j.shape.length < 2) continue;
    const key = j.shape[0] + "|" + j.shape.at(-1) + "|" + j.shape.length;
    if (seen.has(key)) continue;
    seen.add(key);
    const pl = L.polyline(j.shape, { pane: "route", interactive: false, color: color(j.mode), weight: 2.5, opacity: 0.35 }).addTo(searchLayer);
    bounds.extend(pl.getBounds());
  }
  for (const g of gps.values()) if (g.info?.line === line) bounds.extend(g.marker.getLatLng());
  if (bounds.isValid()) { unfocus(); map.flyToBounds(bounds, { padding: [40, 40], maxZoom: 15, duration: 0.8 }); }
  afterSelect(`Line ${line}`);
}
function selectStop(name) {
  const s = searchIndex().stops.get(name);
  if (!s) return;
  clearHighlight(false);
  highlight = { type: "stop", name, ids: s.ids, pos: s.pos };
  L.circleMarker(s.pos, { pane: "route", interactive: false, radius: 9, weight: 2.5, color: "#fff", fill: false }).addTo(searchLayer);
  L.marker(s.pos, { pane: "route", interactive: false, keyboard: false,
    icon: L.divIcon({ className: "zone-label", html: `<div class="zl stop-label"><b>${name}</b></div>`, iconSize: null }) }).addTo(searchLayer);
  unfocus();
  map.flyTo(s.pos, Math.max(map.getZoom(), 16), { duration: 0.8 });
  afterSelect(name);
}
function afterSelect(label) {
  searchInput.value = label; searchResults.innerHTML = "";
  lastFull = 0; // re-evaluate matches on the next frame
}
function clearHighlight(clearInput = true) {
  highlight = null; searchLayer.clearLayers();
  if (clearInput) { searchInput.value = ""; searchResults.innerHTML = ""; }
  searchStatus.textContent = "";
  lastFull = 0;
}
// Does this vehicle match the current search? (called once a second for every vehicle)
function matchesJourney(j, t) {
  if (!highlight) return true;
  if (highlight.type === "line") return j.line === highlight.line;
  return j.calls.some(c => highlight.ids.has(c.stopId) && c.arr >= t && c.arr - t <= SEARCH_STOP_MIN * 60e3);
}
const matchesGps = g => !highlight || (highlight.type === "line" && g.info?.line === highlight.line);
function setDim(marker, match) {
  const dim = !!highlight && !match;
  if (marker.options.dimmed !== dim) { marker.options.dimmed = dim; marker.redraw(); }
}
function renderSearchStatus(count) {
  if (!highlight) return;
  searchStatus.textContent = highlight.type === "line"
    ? `${count} vehicle${count === 1 ? "" : "s"} on line ${highlight.line}`
    : `${count} vehicle${count === 1 ? "" : "s"} due at ${highlight.name} within ${SEARCH_STOP_MIN} min`;
}

searchInput.addEventListener("input", renderResults);
searchInput.addEventListener("keydown", e => {
  if (e.key === "Escape") { clearHighlight(); searchInput.blur(); e.stopPropagation(); }
  if (e.key === "Enter") searchResults.querySelector("li[data-line], li[data-stop]")?.click();
});
searchResults.addEventListener("click", e => {
  const li = e.target.closest("li");
  if (li?.dataset.line) selectLine(li.dataset.line);
  else if (li?.dataset.stop) selectStop(li.dataset.stop);
});
document.getElementById("searchClear").addEventListener("click", () => clearHighlight());

// --- zones & movement trends (left panel + zone map) ----------------------------
// Everything here is read from the passenger *simulation*, so it shows the model's predicted movement.
// Zones: the business districts (DESTINATIONS, out to 1.5 × r) take priority; the rest of the city is split
// into rings around CITY_CENTRE matching the commute model (centre pulls in the morning, outer city feeds it).
const ZONE_WINDOW_MIN = 15, TREND_MIN = 10;
const RING_ZONES = [
  { name: "Centre", inner: 0, outer: 1500, weight: () => `commute pull ${Math.round(TIDE_STRENGTH * 100)}%` },
  { name: "Inner city", inner: 1500, outer: 4500, weight: () => "transition (neutral)" },
  { name: "Outer city", inner: 4500, outer: 7500, weight: () => `commute source ${Math.round(TIDE_STRENGTH * 100)}%` }
];
const zoneDefs = () => [
  ...RING_ZONES.map(z => ({ name: z.name, weight: z.weight() })),
  ...DESTINATIONS.map(d => ({ name: d.name, weight: `destination ${Math.round(DEST_WEIGHT * 100)}%` }))
];
function zoneOf(p) {
  for (const d of DESTINATIONS) if (dist(p, d.pos) <= d.r * 1.5) return d.name;
  const m = dist(p, CITY_CENTRE);
  return m < 1500 ? "Centre" : m < 4500 ? "Inner city" : "Outer city";
}

// Passengers on board, split by whether the rest of their trip heads into or out of the centre
function addDirection(dir, j, ev) {
  const s = j.sim?.[ev], c = j.calls[ev], end = j.calls.at(-1);
  if (!s?.onboard || !c || !end) return;
  const d = dist(c.pos, CITY_CENTRE) - dist(end.pos, CITY_CENTRE);
  dir[d > 500 ? "in" : d < -500 ? "out" : "cross"] += s.onboard;
}

// Sum of boardings/alightings per zone over [fromMin, toMin)
function zoneFlow(fromMin, toMin) {
  const out = {};
  for (const [m, zm] of pax.zoneMinutes) if (m >= fromMin && m < toMin)
    for (const z in zm) addTo(out[z] ??= { board: 0, alight: 0 }, zm[z]);
  return out;
}
// net = alighted − boarded: positive means people are arriving in the zone
function zoneStatus(f) {
  const total = f ? f.board + f.alight : 0, net = f ? f.alight - f.board : 0;
  if (total < 5) return { key: "quiet", label: "quiet", net, total };
  const r = net / total;
  return r > 0.1 ? { key: "in", label: "arriving", net, total }
    : r < -0.1 ? { key: "out", label: "departing", net, total } : { key: "bal", label: "balanced", net, total };
}
const STATUS_COLOR = { in: "#64d2ff", out: "#ff9f0a", bal: "#9a9ea6", quiet: "#5a5f66" };
const signed = n => (n > 0 ? "+" : n < 0 ? "−" : "±") + fmtN(Math.abs(n));

// Panel (top-left of the map; zoom buttons move to the bottom-right to make room)
map.zoomControl.setPosition("bottomright");
const trendEl = L.DomUtil.create("div", "trend-panel", map.getContainer());
L.DomEvent.disableClickPropagation(trendEl); L.DomEvent.disableScrollPropagation(trendEl);
const store = { get: k => { try { return localStorage.getItem(k); } catch { return null; } },
                set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
let trendsCollapsed = store.get("trendsCollapsed") === "1" || matchMedia("(max-width: 760px)").matches;
let zonesOn = store.get("zonesOn") === "1";
trendEl.innerHTML = `
  <div class="tp-head"><b>Movement trends</b><span class="tp-tag">simulated</span>
    <button data-collapse title="Collapse"></button></div>
  <div class="tp-body">
    <div class="tp-tide"><div id="tpTide"></div><svg id="tpCurve" class="tp-curve"></svg>
      <div class="tp-axis"><span>05</span><span>09</span><span>13</span><span>17</span><span>21</span><span>24</span></div></div>
    <h4>On board, heading</h4>
    <div class="tp-split" id="tpSplit"></div><div class="tp-legend" id="tpSplitLegend"></div>
    <h4>Zones · last ${ZONE_WINDOW_MIN} min</h4>
    <table class="tp-zones"><thead><tr><th>Zone</th><th title="alighted">In</th><th title="boarded">Out</th><th>Net</th><th></th></tr></thead>
      <tbody id="tpZones"></tbody></table>
    <div class="tp-note" id="tpNote"></div>
    <label class="tp-toggle"><input type="checkbox" id="tpZonesToggle"> Show zones on map</label>
  </div>`;
const tp = id => trendEl.querySelector("#" + id);
function applyCollapse() {
  trendEl.classList.toggle("collapsed", trendsCollapsed);
  trendEl.querySelector("[data-collapse]").textContent = trendsCollapsed ? "+" : "–";
}
trendEl.querySelector("[data-collapse]").addEventListener("click", () => {
  trendsCollapsed = !trendsCollapsed; store.set("trendsCollapsed", trendsCollapsed ? "1" : "0"); applyCollapse();
});
tp("tpZonesToggle").checked = zonesOn;
tp("tpZonesToggle").addEventListener("change", e => {
  zonesOn = e.target.checked; store.set("zonesOn", zonesOn ? "1" : "0");
  if (zonesOn) zoneLayer.addTo(map); else zoneLayer.remove();
  renderTrends();
});
applyCollapse();

function tidePhrase(v) {
  const s = Math.round(Math.abs(v) * 100);
  return Math.abs(v) < 0.15 ? `Off-peak · no strong commute direction`
    : v > 0 ? `Morning tide · flowing <b>into the centre</b> (${s}%)` : `Afternoon tide · flowing <b>out of the centre</b> (${s}%)`;
}

// Day curve: demand (shaded) and commute tide (line; above the middle = inbound, below = outbound)
function drawTideCurve(svg) {
  const W = svg.clientWidth || 270, H = 64, mid = H / 2, h0 = 5, h1 = 24;
  const x = h => (h - h0) / (h1 - h0) * W, base = new Date(); base.setHours(0, 0, 0, 0);
  let area = `M0 ${H}`, line = "";
  for (let h = h0; h <= h1; h += 0.25) {
    const dem = HOUR_DEMAND[Math.floor(h) % 24], tv = tide(base.getTime() + h * 3600e3);
    area += ` L${x(h).toFixed(1)} ${(H - dem * (H - 4)).toFixed(1)}`;
    line += `${line ? " L" : "M"}${x(h).toFixed(1)} ${(mid - tv * (mid - 4)).toFixed(1)}`;
  }
  const now = new Date(), nh = now.getHours() + now.getMinutes() / 60, nx = x(Math.min(Math.max(nh, h0), h1));
  const ny = mid - tide(now.getTime()) * (mid - 4);
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.innerHTML = `<path d="${area} L${W} ${H} Z" class="dem"/><line x1="0" x2="${W}" y1="${mid}" y2="${mid}" class="mid"/>
    <path d="${line}" class="tide"/><line x1="${nx}" x2="${nx}" y1="0" y2="${H}" class="now"/>
    <circle cx="${nx}" cy="${ny}" r="3.5" class="nowdot"/>
    <text x="3" y="10">in</text><text x="3" y="${H - 3}">out</text>`;
}

function renderTrends() {
  if (trendsCollapsed && !zonesOn) return;
  const nowMin = Math.floor(Date.now() / 60e3);
  tp("tpTide").innerHTML = tidePhrase(tide(Date.now()));
  drawTideCurve(tp("tpCurve"));

  const { in: inb, out, cross } = pax.dir, sum = inb + out + cross || 1;
  tp("tpSplit").innerHTML = [["in", inb, STATUS_COLOR.in], ["out", out, STATUS_COLOR.out], ["cross", cross, STATUS_COLOR.bal]]
    .map(([k, v, c]) => `<span style="width:${(100 * v / sum).toFixed(1)}%;background:${c}" title="${k}: ~${fmtN(v)}"></span>`).join("");
  tp("tpSplitLegend").innerHTML =
    `<span><i style="background:${STATUS_COLOR.in}"></i>into centre ~${fmtN(inb)}</span>` +
    `<span><i style="background:${STATUS_COLOR.out}"></i>out ~${fmtN(out)}</span>` +
    `<span><i style="background:${STATUS_COLOR.bal}"></i>across ~${fmtN(cross)}</span>`;

  const flow = zoneFlow(nowMin - ZONE_WINDOW_MIN + 1, nowMin + 1);
  const recent = zoneFlow(nowMin - TREND_MIN + 1, nowMin + 1), before = zoneFlow(nowMin - 2 * TREND_MIN + 1, nowMin - TREND_MIN + 1);
  const covered = (Date.now() - pax.since) / 60e3;
  tp("tpZones").innerHTML = zoneDefs().map(z => {
    const f = flow[z.name], st = zoneStatus(f);
    const a = recent[z.name], b = before[z.name];
    const na = a ? a.alight - a.board : 0, nb = b ? b.alight - b.board : 0;
    const arrow = covered < 2 * TREND_MIN ? "" : na - nb > 5 ? "▲" : nb - na > 5 ? "▼" : "▶";
    return `<tr title="${z.weight}"><td><i style="background:${STATUS_COLOR[st.key]}"></i>${z.name}</td>
      <td>${fmtN(f?.alight ?? 0)}</td><td>${fmtN(f?.board ?? 0)}</td>
      <td style="color:${STATUS_COLOR[st.key]}">${signed(st.net)}</td><td class="tp-arrow">${arrow}</td></tr>`;
  }).join("");
  tp("tpNote").textContent = covered < ZONE_WINDOW_MIN
    ? `Collecting… ${Math.floor(covered)} of ${ZONE_WINDOW_MIN} min observed since page load.`
    : `Net = arriving (alighted) − leaving (boarded). Arrows compare the last ${TREND_MIN} min with the ${TREND_MIN} before.`;

  if (zonesOn) updateZoneLayer(flow);
}

// --- zone map overlay ---
const zonePane = map.createPane("zones");
zonePane.style.zIndex = 360; zonePane.style.pointerEvents = "none"; // above tiles, below vehicles
const zoneLayer = L.layerGroup();
const zoneParts = {}; // name -> { fills: [circles to colour], label: marker }
const north = (p, m) => [p[0] + m / 111320, p[1]];
function zoneLabel(pos) {
  return L.marker(pos, { pane: "zones", interactive: false, keyboard: false,
    icon: L.divIcon({ className: "zone-label", html: "", iconSize: null }) }).addTo(zoneLayer);
}
const circle = (pos, radius, o) => L.circle(pos, { pane: "zones", interactive: false, radius, ...o }).addTo(zoneLayer);
// rings: centre disc + dashed boundaries; ring labels sit at the north side, halfway through each band
for (const z of RING_ZONES) {
  const fill = z.inner === 0
    ? circle(CITY_CENTRE, z.outer, { weight: 2, fillOpacity: 0.14 })
    : circle(CITY_CENTRE, z.outer, { weight: 1.5, dashArray: "6 6", fill: false });
  zoneParts[z.name] = { fills: [fill], label: zoneLabel(z.inner === 0 ? CITY_CENTRE : north(CITY_CENTRE, (z.inner + z.outer) / 2)) };
}
for (const d of DESTINATIONS) {
  zoneParts[d.name] = {
    fills: [circle(d.pos, d.r, { weight: 1.5, fillOpacity: 0.16 }), circle(d.pos, d.r * 1.5, { weight: 1, dashArray: "3 5", fill: false })],
    label: zoneLabel(d.pos)
  };
}
function updateZoneLayer(flow) {
  for (const z of zoneDefs()) {
    const part = zoneParts[z.name], st = zoneStatus(flow[z.name]), col = STATUS_COLOR[st.key];
    for (const c of part.fills) c.setStyle({ color: col, fillColor: col });
    const el = part.label.getElement();
    if (el) el.innerHTML = `<div class="zl"><b>${z.name}</b><span>${z.weight}</span>` +
      `<span style="color:${col}">${st.key === "quiet" ? "quiet" : `${st.label} ${signed(st.net)}`} · ${ZONE_WINDOW_MIN} min</span></div>`;
  }
}
if (zonesOn) zoneLayer.addTo(map);

// --- loops ----------------------------------------------------------------
const status = msg => document.getElementById("tStatus").textContent = msg;
async function scheduleLoop() {
  if (map.hasLayer(layer)) {
    try { await refreshSchedule(); status(`Schedules updated ${new Date().toLocaleTimeString("nb-NO")}`); }
    catch (e) { status("Transit update failed: " + e.message); }
  }
  setTimeout(scheduleLoop, SCHEDULE_MS);
}
async function gpsLoop() {
  if (map.hasLayer(layer)) { try { await refreshGps(); } catch (e) { console.warn("GPS update failed", e); } }
  setTimeout(gpsLoop, GPS_MS);
}
scheduleLoop(); gpsLoop();
requestAnimationFrame(frame);
setInterval(renderPanel, 3000);

})();
