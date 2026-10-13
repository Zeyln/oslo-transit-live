// Map setup and the dark base map (DarkTiles). Loaded before transit.js, which uses `map` and `baseTiles`.
const map = L.map("map").setView([59.92, 10.77], 12);

// Kartverket's grey map, turned dark *once per tile* as it loads, instead of with a CSS filter that the browser
// re-applies while the map moves. Same maths as the old filter: invert(1) grayscale(1) contrast(.85) brightness(.5).
// A softened copy (≈ CSS blur(0.5px)) is made on demand for the anti-flicker mode used while following a vehicle;
// switching between the two is just showing/hiding prepared canvases.
const TILE_CONTRAST = 0.85, TILE_BRIGHTNESS = 0.5;
const TILE_LUT = new Uint8ClampedArray(256); // original luminance (0-255) -> final grey
for (let l = 0; l < 256; l++) TILE_LUT[l] = (((1 - l / 255) - 0.5) * TILE_CONTRAST + 0.5) * TILE_BRIGHTNESS * 255;
const SOFT_W = 0.107; // 3-tap Gaussian, sigma 0.5 px: [0.107, 0.786, 0.107]

function tileCanvas(gray, cls) {
  const c = document.createElement("canvas");
  c.width = c.height = 256; c.className = cls;
  const ctx = c.getContext("2d"), img = ctx.createImageData(256, 256), p = img.data;
  for (let i = 0, k = 0; i < gray.length; i++, k += 4) { p[k] = p[k + 1] = p[k + 2] = gray[i]; p[k + 3] = 255; }
  ctx.putImageData(img, 0, 0);
  return c;
}
function softGray(g) { // separable blur, edges clamped (seams are invisible at this radius)
  const a = new Float32Array(g.length), out = new Uint8ClampedArray(g.length), c = 1 - 2 * SOFT_W;
  for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
    const i = y * 256 + x;
    a[i] = g[i] * c + SOFT_W * (g[x > 0 ? i - 1 : i] + g[x < 255 ? i + 1 : i]);
  }
  for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
    const i = y * 256 + x;
    out[i] = a[i] * c + SOFT_W * (a[y > 0 ? i - 256 : i] + a[y < 255 ? i + 256 : i]);
  }
  return out;
}

const DarkTiles = L.GridLayer.extend({
  initialize(url, options) { this._url = url; L.GridLayer.prototype.initialize.call(this, options); },
  tileUrl(coords) { return L.Util.template(this._url, coords); },
  createTile(coords, done) {
    const el = document.createElement("div");
    const img = new Image();
    img.crossOrigin = "anonymous"; // Kartverket allows it; needed to read the pixels
    img.onload = () => {
      const ctx = Object.assign(document.createElement("canvas"), { width: 256, height: 256 }).getContext("2d", { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      const src = ctx.getImageData(0, 0, 256, 256).data, gray = new Uint8ClampedArray(65536);
      for (let i = 0, k = 0; i < 65536; i++, k += 4) gray[i] = TILE_LUT[(0.2126 * src[k] + 0.7152 * src[k + 1] + 0.0722 * src[k + 2]) | 0];
      el._gray = gray;
      el.appendChild(tileCanvas(gray, "sharp"));
      if (map.getContainer().classList.contains("anti-flicker")) this._addSoft(el);
      done(null, el);
    };
    img.onerror = e => done(e, el);
    img.src = this.tileUrl(coords);
    return el;
  },
  _addSoft(el) { if (el._gray && !el._soft) el.appendChild(el._soft = tileCanvas(softGray(el._gray), "soft")); },
  // called when anti-flicker turns on: prepare softened copies of the tiles already on screen
  ensureSoft() { for (const k in this._tiles) this._addSoft(this._tiles[k].el); }
});
const baseTiles = new DarkTiles("https://cache.kartverket.no/v1/wmts/1.0.0/topograatone/default/webmercator/{z}/{y}/{x}.png", {
  maxZoom: 18, className: "dark-tiles", attribution: "© Kartverket · Transit data © Entur (NLOD)"
}).addTo(map);
