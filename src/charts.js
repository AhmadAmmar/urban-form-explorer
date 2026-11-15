// Small SVG charts. No library: each returns an SVG string.
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// Polar histogram of street bearings (36 bins of 10 degrees, shares summing to 1).
export function rose(bins, size = 200) {
  const c = size / 2, r = c - 18, max = Math.max(...bins) || 1, parts = [];
  for (let k = 0; k < 36; k++) {
    const a0 = ((k * 10 - 5 - 90) * Math.PI) / 180, a1 = ((k * 10 + 5 - 90) * Math.PI) / 180, rr = r * Math.sqrt(bins[k] / max);
    parts.push(`<path d="M${c},${c} L${c + rr * Math.cos(a0)},${c + rr * Math.sin(a0)} A${rr},${rr} 0 0 1 ${c + rr * Math.cos(a1)},${c + rr * Math.sin(a1)} Z" class="rose-bar"/>`);
  }
  const ring = [0.25, 0.5, 1].map((f) => `<circle cx="${c}" cy="${c}" r="${r * Math.sqrt(f)}" class="rose-grid"/>`).join("");
  const lab = [["N", c, 11], ["E", size - 7, c + 4], ["S", c, size - 3], ["W", 7, c + 4]].map(([t, x, y]) => `<text x="${x}" y="${y}" class="axis" text-anchor="middle">${t}</text>`).join("");
  return `<svg viewBox="0 0 ${size} ${size}" class="chart rose" role="img" aria-label="Street orientation rose">${ring}${parts.join("")}${lab}</svg>`;
}

// Horizontal bars for {label: value}.
export function bars(obj, { width = 300, fmt = (v) => v, max = null } = {}) {
  const items = Object.entries(obj);
  const m = max ?? Math.max(...items.map(([, v]) => v), 1), h = 16, lw = 128, out = [];
  items.forEach(([k, v], i) => {
    const y = i * (h + 4), w = Math.max(0, ((width - lw - 46) * v) / m);
    out.push(`<text x="${lw - 6}" y="${y + 12}" text-anchor="end" class="axis">${esc(k)}</text>`,
             `<rect x="${lw}" y="${y + 2}" width="${w}" height="${h - 4}" class="bar"/>`,
             `<text x="${lw + w + 4}" y="${y + 12}" class="value">${esc(fmt(v))}</text>`);
  });
  return `<svg viewBox="0 0 ${width} ${items.length * (h + 4)}" class="chart">${out.join("")}</svg>`;
}

// Histogram of a list of numbers with given bin edges.
export function hist(values, edges, { width = 300, height = 110, label = "" } = {}) {
  const counts = edges.slice(0, -1).map((e, i) => values.filter((v) => v >= e && v < edges[i + 1]).length);
  const m = Math.max(...counts, 1), bw = (width - 30) / counts.length, out = [];
  counts.forEach((n, i) => {
    const bh = ((height - 30) * n) / m, x = 25 + i * bw;
    out.push(`<rect x="${x + 1}" y="${height - 18 - bh}" width="${bw - 2}" height="${bh}" class="bar"><title>${n}</title></rect>`);
    out.push(`<text x="${x + bw / 2}" y="${height - 5}" text-anchor="middle" class="axis">${edges[i]}</text>`);
  });
  return `<svg viewBox="0 0 ${width} ${height}" class="chart">${out.join("")}<text x="${width}" y="10" text-anchor="end" class="axis">${esc(label)}</text></svg>`;
}

// A 0-100 gauge as a thin bar.
export const meter = (v) => `<span class="meter"><span style="width:${Math.max(0, Math.min(100, v)).toFixed(0)}%"></span></span>`;
