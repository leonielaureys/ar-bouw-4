// geo.js — kleine geometrie-helpers (buizen, balken, labels, polygonen)
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export const V3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const UP = new THREE.Vector3(0, 1, 0);

/** Cilinder tussen twee punten (open uiteinden). */
export function cylBetween(a, b, r, radial = 8) {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  if (len < 1e-5) return null;
  const g = new THREE.CylinderGeometry(r, r, len, radial, 1, true);
  const q = new THREE.Quaternion().setFromUnitVectors(UP, dir.normalize());
  const m = new THREE.Matrix4().compose(new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1));
  g.applyMatrix4(m);
  return g;
}

/** Buis langs een polylijn. dash>0 => gestreepte buis (aanname). */
export function tubeGeo(pts, r, { dash = 0, gap = 0, joints = true, radial = 8 } = {}) {
  const geos = [];
  let phase = 0; // afgelegde lengte binnen het streep/gat-patroon
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const seg = a.distanceTo(b);
    if (seg < 1e-6) continue;
    if (dash > 0) {
      const period = dash + gap;
      let t = 0;
      while (t < seg) {
        const inDash = phase < dash;
        const left = inDash ? dash - phase : period - phase;
        const step = Math.min(left, seg - t);
        if (inDash) {
          const p0 = a.clone().lerp(b, t / seg), p1 = a.clone().lerp(b, (t + step) / seg);
          const g = cylBetween(p0, p1, r, radial); if (g) geos.push(g);
        }
        t += step; phase = (phase + step) % period;
      }
    } else {
      const g = cylBetween(a, b, r, radial); if (g) geos.push(g);
    }
    if (joints && i > 0 && dash === 0) {
      const s = new THREE.SphereGeometry(r, radial, 6); s.translate(a.x, a.y, a.z); geos.push(s);
    }
  }
  return merge(geos);
}

export function boxGeo(center, size, rotY = 0) {
  const g = new THREE.BoxGeometry(size.x, size.y, size.z);
  const m = new THREE.Matrix4().compose(center, new THREE.Quaternion().setFromAxisAngle(UP, rotY), new THREE.Vector3(1, 1, 1));
  g.applyMatrix4(m);
  return g;
}

/** Balk tussen twee punten met rechthoekige doorsnede (b breedte horizontaal, h hoogte). */
export function beamGeo(a, b, w, h) {
  const d = new THREE.Vector3().subVectors(b, a);
  const len = d.length();
  const g = new THREE.BoxGeometry(len, h, w);
  const yaw = Math.atan2(-d.z, d.x);
  const pitch = Math.atan2(d.y, Math.hypot(d.x, d.z));
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, pitch, 'YZX'));
  g.applyMatrix4(new THREE.Matrix4().compose(a.clone().add(b).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1)));
  return g;
}

export function merge(geos) {
  const list = geos.filter(Boolean).map(g => {
    const n = g.index ? g.toNonIndexed() : g;
    // zorg dat alle geometrieën dezelfde attributen hebben
    if (!n.attributes.normal) n.computeVertexNormals();
    for (const k of Object.keys(n.attributes)) if (k !== 'position' && k !== 'normal') n.deleteAttribute(k);
    return n;
  });
  if (!list.length) return null;
  return list.length === 1 ? list[0] : mergeGeometries(list, false);
}

// ---------- Labels ----------
const labelCache = new Map();
export function makeLabel(text, { size = 0.03, color = '#ffffff', bg = 'rgba(12,16,24,0.86)', border = null } = {}) {
  const lines = String(text).split('\n');
  const fs = 30, pad = 14, lh = fs * 1.25;
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  ctx.font = `600 ${fs}px system-ui, sans-serif`;
  const w = Math.ceil(Math.max(...lines.map(l => ctx.measureText(l).width)) + pad * 2);
  const h = Math.ceil(lines.length * lh + pad * 1.4);
  c.width = w; c.height = h;
  ctx.font = `600 ${fs}px system-ui, sans-serif`;
  ctx.fillStyle = bg; roundRect(ctx, 0, 0, w, h, 12); ctx.fill();
  if (border) { ctx.strokeStyle = border; ctx.lineWidth = 4; roundRect(ctx, 2, 2, w - 4, h - 4, 10); ctx.stroke(); }
  ctx.fillStyle = color; ctx.textBaseline = 'top';
  lines.forEach((l, i) => ctx.fillText(l, pad, pad * 0.7 + i * lh));
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, depthWrite: false, transparent: true });
  const s = new THREE.Sprite(mat);
  const scale = size / lh * (h / lines.length) * lines.length / h; // hoogte per regel = size
  s.scale.set(w * size / lh, h * size / lh, 1);
  s.renderOrder = 999;
  s.userData.isLabel = true;
  void scale; void labelCache;
  return s;
}
export function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

// ---------- 2D-polygoon ----------
export function pointInPoly(x, z, poly) {
  let ins = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if (((zi > z) !== (zj > z)) && (x < (xj - xi) * (z - zi) / (zj - zi) + xi)) ins = !ins;
  }
  return ins;
}
export function polyArea(poly) {
  let a = 0; for (let i = 0; i < poly.length; i++) { const [x1, z1] = poly[i], [x2, z2] = poly[(i + 1) % poly.length]; a += x1 * z2 - x2 * z1; }
  return a / 2;
}
export function polyCentroid(poly) {
  let cx = 0, cz = 0, a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, z1] = poly[i], [x2, z2] = poly[(i + 1) % poly.length];
    const f = x1 * z2 - x2 * z1; a += f; cx += (x1 + x2) * f; cz += (z1 + z2) * f;
  }
  a /= 2; if (Math.abs(a) < 1e-9) return [poly[0][0], poly[0][1]];
  return [cx / (6 * a), cz / (6 * a)];
}
/** Polygoon naar binnen verschuiven over afstand d (werkt voor eenvoudige, niet-zelfsnijdende polygonen). */
export function insetPoly(poly, d) {
  const n = poly.length, ccw = polyArea(poly) > 0;
  const lines = [];
  for (let i = 0; i < n; i++) {
    const [x1, z1] = poly[i], [x2, z2] = poly[(i + 1) % n];
    let dx = x2 - x1, dz = z2 - z1; const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
    // binnennormaal: voor CCW (in x,z met z 'naar beneden') testen we gewoon
    let nx = -dz, nz = dx; if (!ccw) { nx = -nx; nz = -nz; }
    const mx = (x1 + x2) / 2 + nx * 0.001, mz = (z1 + z2) / 2 + nz * 0.001;
    if (!pointInPoly(mx, mz, poly)) { nx = -nx; nz = -nz; }
    lines.push({ px: x1 + nx * d, pz: z1 + nz * d, dx, dz });
  }
  const out = [];
  for (let i = 0; i < n; i++) {
    const A = lines[(i - 1 + n) % n], B = lines[i];
    const den = A.dx * B.dz - A.dz * B.dx;
    if (Math.abs(den) < 1e-9) { out.push([B.px, B.pz]); continue; }
    const t = ((B.px - A.px) * B.dz - (B.pz - A.pz) * B.dx) / den;
    out.push([A.px + A.dx * t, A.pz + A.dz * t]);
  }
  return out;
}
export function polyPerimeter(poly) { let L = 0; for (let i = 0; i < poly.length; i++) { const a = poly[i], b = poly[(i + 1) % poly.length]; L += Math.hypot(b[0] - a[0], b[1] - a[1]); } return L; }
/** Punt op de omtrek op afstand s (vanaf hoekpunt 0). */
export function pointAtPerim(poly, s) {
  const P = polyPerimeter(poly); s = ((s % P) + P) % P;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length]; const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (s <= L) { const t = s / L; return { x: a[0] + (b[0] - a[0]) * t, z: a[1] + (b[1] - a[1]) * t, edge: i, u: s }; }
    s -= L;
  }
  return { x: poly[0][0], z: poly[0][1], edge: 0, u: 0 };
}
/** Pad langs de omtrek van s0 naar s1 (in positieve richting), als lijst [x,z]. */
export function pathAlongPerim(poly, s0, s1) {
  const P = polyPerimeter(poly);
  s0 = ((s0 % P) + P) % P; s1 = ((s1 % P) + P) % P; if (s1 < s0) s1 += P;
  const pts = [pointAtPerim(poly, s0)];
  // hoekpunten tussenin
  let acc = 0; const cum = [];
  for (let i = 0; i < poly.length; i++) { cum.push(acc); const a = poly[i], b = poly[(i + 1) % poly.length]; acc += Math.hypot(b[0] - a[0], b[1] - a[1]); }
  for (let k = 0; k < 2; k++) for (let i = 0; i < poly.length; i++) {
    const c = cum[i] + k * P; if (c > s0 + 1e-6 && c < s1 - 1e-6) pts.push({ x: poly[i][0], z: poly[i][1] });
  }
  pts.push(pointAtPerim(poly, s1));
  return pts.map(p => [p.x, p.z]);
}
/** Projectie van punt op omtrek: geeft s (omtrekcoördinaat). */
export function perimParam(poly, x, z) {
  let best = { d: Infinity, s: 0 }, acc = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const dx = b[0] - a[0], dz = b[1] - a[1], L2 = dx * dx + dz * dz, L = Math.sqrt(L2);
    let t = L2 ? ((x - a[0]) * dx + (z - a[1]) * dz) / L2 : 0; t = Math.max(0, Math.min(1, t));
    const px = a[0] + dx * t, pz = a[1] + dz * t, d = Math.hypot(x - px, z - pz);
    if (d < best.d) best = { d, s: acc + t * L };
    acc += L;
  }
  return best.s;
}

/** Kleinste afstand van punt p tot een polylijn (Vector3[]) + dichtstbijzijnd punt. */
export function distToPolyline(p, pts) {
  let best = { d: Infinity, q: null };
  const ab = new THREE.Vector3(), ap = new THREE.Vector3();
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    ab.subVectors(b, a); ap.subVectors(p, a);
    const L2 = ab.lengthSq(); let t = L2 ? ap.dot(ab) / L2 : 0; t = Math.max(0, Math.min(1, t));
    const q = a.clone().addScaledVector(ab, t); const d = q.distanceTo(p);
    if (d < best.d) best = { d, q };
  }
  return best;
}
