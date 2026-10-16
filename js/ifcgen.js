// ifcgen.js — vult een eigen Revit/IFC-model aan met wapening (EN 1992-1-1) en technieken per ruimte (IfcSpace)
import * as THREE from 'three';
import { V3, tubeGeo, merge, makeLabel } from './geo.js';
import { plaatTerPlaatse, kiesWapening, dekking, fmt } from './ec2.js';
import { generate } from './generator.js';

const RE_BETON = /beton|concrete|c\d{2}\/\d{2}|gewapend|in situ|ter plaatse|prefab/i;
const RE_STAAL = /\b(ipe|hea|heb|hem|upn|unp|ipn|shs|rhs|chs|staal|steel|kokerprofiel)\b/i;
const RE_METSEL = /metsel|baksteen|brick|kalkzandsteen|snelbouw|cellenbeton|ytong|gips|stud|masonry|block/i;
const RE_HOUT = /\bclt\b|kruislaag|x-?lam|\bklh\b|massief ?hout|mass timber|cross[- ]?laminated|lamellenhout|glulam|gelamineerd|\bhout|timber|wood|\blvl\b|houtskelet|naaldhout|spruce|vuren|c24|gl2[48]/i;
const RE_CLT = /\bclt\b|kruislaag|x-?lam|\bklh\b|cross[- ]?laminated|massief ?hout/i;

/** Georiënteerde box: kleinste omhullende rechthoek (in plan) van het convexe omhulsel. */
function obb(geo) {
  const p = geo.attributes.position.array, n = p.length / 3;
  let y0 = Infinity, y1 = -Infinity; const pts = [];
  for (let i = 0; i < n; i++) { y0 = Math.min(y0, p[i * 3 + 1]); y1 = Math.max(y1, p[i * 3 + 1]); pts.push([p[i * 3], p[i * 3 + 2]]); }
  const hull = convexHull(pts);
  let best = null;
  const dirs = hull.length >= 2 ? hull.map((q, i) => { const r = hull[(i + 1) % hull.length]; const L = Math.hypot(r[0] - q[0], r[1] - q[1]) || 1; return { x: (r[0] - q[0]) / L, z: (r[1] - q[1]) / L }; }) : [{ x: 1, z: 0 }];
  for (const u of dirs) {
    const v = { x: -u.z, z: u.x };
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const [x, z] of hull) { const a = x * u.x + z * u.z, b = x * v.x + z * v.z; u0 = Math.min(u0, a); u1 = Math.max(u1, a); v0 = Math.min(v0, b); v1 = Math.max(v1, b); }
    const area = (u1 - u0) * (v1 - v0);
    if (!best || area < best.area - 1e-9) best = { area, u, v, u0, u1, v0, v1 };
  }
  const { u, v, u0, u1, v0, v1 } = best; const cu = (u0 + u1) / 2, cv = (v0 + v1) / 2;
  return { c: { x: u.x * cu + v.x * cv, z: u.z * cu + v.z * cv }, u, v, lu: u1 - u0, lv: v1 - v0, y0, y1, h: y1 - y0 };
}
/** punt in box-coördinaten (a langs u, b langs v) -> wereld */
const P = (B, a, b, y) => V3(B.c.x + B.u.x * a + B.v.x * b, y, B.c.z + B.u.z * a + B.v.z * b);

function soortMateriaal(el) {
  const t = `${el.naam} ${el.objType} ${el.materiaal || ''}`;
  if (RE_HOUT.test(t)) return RE_CLT.test(t) ? 'clt' : 'hout';
  if (RE_STAAL.test(t)) return 'staal';
  if (RE_METSEL.test(t)) return 'metselwerk';
  if (RE_BETON.test(t)) return 'beton';
  return 'onbekend';
}

export function genereerUitIFC(elementen, { wapening = true, technieken = true, onbekendIsBeton = false, vloerverwarming = true } = {}) {
  const group = new THREE.Group(); group.name = 'ifc-gegenereerd';
  const picks = [], leidingen = [], rapport = [];
  const mats = new Map();
  const mat = (kleur, op = 1) => { const k = kleur + '|' + op; if (!mats.has(k)) mats.set(k, new THREE.MeshBasicMaterial({ color: kleur, transparent: op < 1, opacity: op, depthWrite: op >= 1 })); return mats.get(k); };
  const add = (laag, geo, { kleur = 0xff3b30, op = 1, naam = '', info = '', fase = 1 } = {}) => {
    if (!geo) return; const m = new THREE.Mesh(geo, mat(kleur, op)); m.userData = { laag, naam, info, fase, aanname: true, pickable: true }; group.add(m); picks.push(m);
  };
  const tag = '\n⚠ AANNAME — gegenereerd door de app, niet uit het IFC-model';
  const heeftWapening = elementen.some(e => /REINFORCING/.test(e.type));
  const openingen = elementen.filter(e => e.type === 'IFCDOOR' || e.type === 'IFCWINDOW').map(e => ({ e, B: obb(e.geo) }));
  const isBeton = (el) => { const s = soortMateriaal(el); return s === 'beton' || (s === 'onbekend' && onbekendIsBeton); };
  const tel = { platen: 0, wanden: 0, balken: 0, kolommen: 0, ruimtes: 0, clt: 0, hout: 0, onbekend: [] };
  const DRAGEND = /^IFC(WALL|SLAB|BEAM|COLUMN)/;
  for (const el of elementen) if (DRAGEND.test(el.type) && soortMateriaal(el) === 'onbekend') tel.onbekend.push(el);
  // ---------- hout / CLT: geen wapening, wel lagen + verbindingen (EN 1995-1-1) ----------
  if (wapening) for (const el of elementen) {
    const sm = soortMateriaal(el); if (sm !== 'clt' && sm !== 'hout') continue;
    const T = el.type, B = obb(el.geo);
    const isWand = /^IFCWALL/.test(T), isPlaat = /^IFCSLAB/.test(T);
    if (sm === 'clt' && (isWand || isPlaat)) {
      const t = isWand ? Math.min(B.lu, B.lv) : B.h; if (t < 0.05 || t > 0.5) continue;
      const n = t <= 0.105 ? 3 : t <= 0.2 ? 5 : 7; // gebruikelijke CLT-opbouw (3/5/7 lagen)
      const lagen = [], verb = [];
      if (isWand) {
        const alongU = B.lu >= B.lv, L = Math.max(B.lu, B.lv);
        const pt = (u, w, y) => alongU ? P(B, u, w, y) : P(B, w, u, y);
        for (let i = 1; i < n; i++) { const w = -t / 2 + i * t / n; lagen.push(tubeGeo([pt(-L / 2, w, B.y0 + 0.01), pt(L / 2, w, B.y0 + 0.01), pt(L / 2, w, B.y1 - 0.01), pt(-L / 2, w, B.y1 - 0.01), pt(-L / 2, w, B.y0 + 0.01)], 0.003, { joints: false, radial: 4 })); }
        for (let u = -L / 2 + 0.3; u <= L / 2 - 0.3; u += 0.8) verb.push(tubeGeo([pt(u, t / 2 + 0.002, B.y0 + 0.09), pt(u, t / 2 + 0.002, B.y0 + 0.005), pt(u, t / 2 + 0.09, B.y0 + 0.005)], 0.006, { joints: false, radial: 4 }));
        for (const u of [-L / 2 + 0.08, L / 2 - 0.08]) verb.push(tubeGeo([pt(u, t / 2 + 0.003, B.y0 + 0.45), pt(u, t / 2 + 0.003, B.y0 - 0.15)], 0.01, { joints: false, radial: 4 }));
      } else {
        const L = Math.max(B.lu, B.lv), Lo = Math.min(B.lu, B.lv), alongU = B.lu >= B.lv;
        const pt = (u, w, y) => alongU ? P(B, u, w, y) : P(B, w, u, y);
        for (let i = 1; i < n; i++) { const y = B.y0 + i * t / n; lagen.push(tubeGeo([pt(-L / 2, -Lo / 2, y), pt(L / 2, -Lo / 2, y), pt(L / 2, Lo / 2, y), pt(-L / 2, Lo / 2, y), pt(-L / 2, -Lo / 2, y)], 0.003, { joints: false, radial: 4 })); }
        for (const u of [-L / 2 + 0.05, L / 2 - 0.05]) for (let w = -Lo / 2 + 0.15; w <= Lo / 2 - 0.15; w += 0.3) verb.push(tubeGeo([pt(u, w, B.y1 + 0.005), pt(u + (u < 0 ? -0.08 : 0.08), w, B.y0 - 0.12)], 0.004, { joints: false, radial: 4 }));
      }
      add('structuur', merge(lagen), { kleur: 0xd9a066, naam: 'CLT-lagen', info: `${el.naam || 'CLT-element'} — kruislaaghout, t = ${Math.round(t * 1000)} mm\n${n} kruiselings verlijmde lamellen (gebruikelijke opbouw, aanname)\nGeen wapening: hout (EN 1995-1-1, CLT volgens EN 16351)` + tag });
      add('wapening', merge(verb), { kleur: 0xbfc7d1, naam: isWand ? 'Hoekankers en trekankers' : 'Schroeven aan opleggingen', info: (isWand ? 'Hoekankers (afschuiving) h.o.h. ± 0,8 m en trekankers (hold-downs) aan de wanduiteinden' : 'Volledig-draadschroeven aan de opleggingen h.o.h. ± 0,3 m') + `\nStalen verbindingsmiddelen volgens EN 1995-1-1 §8 — aantal en type volgens berekening/fabrikant` + tag });
      tel.clt++;
    } else tel.hout++;
  }

  if (wapening && heeftWapening) rapport.push('— WAPENING —', 'Het IFC-model bevat zelf al wapening: die wordt getoond, er wordt niets bijgegenereerd.');
  if (wapening && !heeftWapening) {
    rapport.push('— WAPENING (voorontwerp EN 1992-1-1, per element) —');
    for (const el of elementen) {
      const T = el.type;
      // ---------- platen ----------
      if ((T === 'IFCSLAB' || T === 'IFCSLABSTANDARDCASE' || T === 'IFCSLABELEMENTEDCASE') && isBeton(el)) {
        const B = obb(el.geo); if (B.h > 0.6 || B.h < 0.08 || Math.min(B.lu, B.lv) < 0.5) continue;
        const spanU = B.lu <= B.lv; const L = Math.min(B.lu, B.lv), Lo = Math.max(B.lu, B.lv);
        const hmm = Math.round(B.h * 1000);
        const r = plaatTerPlaatse({ L, hMin: Math.max(100, Math.floor(hmm / 10) * 10) });
        if (!r) continue;
        const te_dun = r.h > hmm + 5;
        const c = r.cnom / 1000, dm = r.hoofd.d / 1000, dv = r.verdeel.d / 1000, db = r.boven.d / 1000;
        const yB = B.y0 + c + dm / 2, yV = yB + dm / 2 + dv / 2, yT = B.y1 - c - db / 2;
        const bars = [], verd = [], top = [];
        // lokale assen: s = overspanning, a = dwars
        const pt = (aa, ss, y) => spanU ? P(B, ss, aa, y) : P(B, aa, ss, y);
        const halfL = L / 2, halfO = Lo / 2;
        let nb = 0;
        for (let aa = -halfO + c; aa <= halfO - c && nb < 1500; aa += r.hoofd.s / 1000, nb++) bars.push(tubeGeo([pt(aa, -halfL + c, yB), pt(aa, halfL - c, yB)], dm / 2, { joints: false, radial: 4 }));
        for (let ss = -halfL + c; ss <= halfL - c && nb < 3000; ss += r.verdeel.s / 1000, nb++) verd.push(tubeGeo([pt(-halfO + c, ss, yV), pt(halfO - c, ss, yV)], dv / 2, { joints: false, radial: 4 }));
        for (let aa = -halfO + c; aa <= halfO - c && nb < 4500; aa += r.boven.s / 1000, nb++) for (const [s0, s1] of [[-halfL + c, -halfL + 0.2 * L], [halfL - 0.2 * L, halfL - c]]) top.push(tubeGeo([pt(aa, s0, yT), pt(aa, s1, yT)], db / 2, { joints: false, radial: 4 }));
        const info = `${el.naam || 'Vloerplaat'} — h = ${hmm} mm, L ≈ ${fmt(L)} m (kortste richting)\n` + r.rapport.slice(1).join('\n') + (te_dun ? `\n⚠ Volgens de l/d-controle is h ≥ ${r.h} mm nodig — plaat nakijken` : '');
        add('wapening', merge(bars), { naam: 'Hoofdwapening plaat', info: info + tag });
        add('wapening', merge(verd), { kleur: 0xff7b72, naam: 'Verdeelwapening plaat', info: info + tag });
        add('wapening', merge(top), { kleur: 0xff9f0a, naam: 'Bovenwapening opleggingen', info: info + tag });
        rapport.push(`Plaat ${el.naam || el.expressID}: h=${hmm} mm, L=${fmt(L)} m → onder Ø${r.hoofd.d}/${r.hoofd.s}, verdeel Ø${r.verdeel.d}/${r.verdeel.s}, boven Ø${r.boven.d}/${r.boven.s}${te_dun ? ` ⚠ h≥${r.h} vereist` : ''}`);
        tel.platen++;
      }
      // ---------- wanden ----------
      else if ((T === 'IFCWALL' || T === 'IFCWALLSTANDARDCASE' || T === 'IFCWALLELEMENTEDCASE') && isBeton(el)) {
        const B = obb(el.geo); const t = Math.min(B.lu, B.lv), L = Math.max(B.lu, B.lv);
        if (t < 0.12 || t > 0.6 || L < 0.4) continue;
        const alongU = B.lu >= B.lv;
        const pt = (u, w, y) => alongU ? P(B, u, w, y) : P(B, w, u, y);
        const Ac = t * 1e6; // mm² per m
        const vert = kiesWapening(Math.max(0.002 * Ac / 2, 100), Math.min(3 * t * 1000, 400), [8, 10, 12]); // §9.6.2 per zijde
        const hor = kiesWapening(Math.max(0.25 * vert.As, 0.001 * Ac / 2), 400, [8, 10]); // §9.6.3
        const c = dekking({ staaf: vert.d }).cnom / 1000;
        // openingen in deze wand (deuren/ramen) in wandcoördinaten
        const ops = [];
        for (const { B: O } of openingen) {
          const dx = O.c.x - B.c.x, dz = O.c.z - B.c.z;
          const ua = alongU ? dx * B.u.x + dz * B.u.z : dx * B.v.x + dz * B.v.z, wa = alongU ? dx * B.v.x + dz * B.v.z : dx * B.u.x + dz * B.u.z;
          if (Math.abs(wa) < t + 0.1 && Math.abs(ua) < L / 2 + 0.2) { const br = Math.max(O.lu, O.lv) / 2 + 0.03; ops.push({ u0: ua - br, u1: ua + br, y0: O.y0 - 0.03, y1: O.y1 + 0.03 }); }
        }
        const knip = (vast, t0, t1, isVert) => {
          let iv = [[t0, t1]];
          for (const o of ops) {
            const inV = isVert ? (vast > o.u0 && vast < o.u1) : (vast > o.y0 && vast < o.y1); if (!inV) continue;
            const [q0, q1] = isVert ? [o.y0, o.y1] : [o.u0, o.u1];
            iv = iv.flatMap(([a, b]) => (q1 <= a || q0 >= b) ? [[a, b]] : [[a, Math.max(a, q0)], [Math.min(b, q1), b]].filter(([x, y]) => y - x > 0.05));
          }
          return iv;
        };
        const geos = [];
        for (const w of [-t / 2 + c + vert.d / 2000, t / 2 - c - vert.d / 2000]) {
          for (let u = -L / 2 + 0.05; u <= L / 2 - 0.05; u += vert.s / 1000) for (const [y0, y1] of knip(u, B.y0 + 0.03, B.y1 - 0.03, true)) geos.push(tubeGeo([pt(u, w, y0), pt(u, w, y1)], vert.d / 2000, { joints: false, radial: 4 }));
          const wh = w + (w < 0 ? 1 : -1) * (vert.d + hor.d) / 2000;
          for (let y = B.y0 + 0.1; y <= B.y1 - 0.05; y += hor.s / 1000) for (const [u0, u1] of knip(y, -L / 2 + 0.03, L / 2 - 0.03, false)) geos.push(tubeGeo([pt(u0, wh, y), pt(u1, wh, y)], hor.d / 2000, { joints: false, radial: 4 }));
        }
        const info = `${el.naam || 'Betonwand'} — t = ${Math.round(t * 1000)} mm, L ≈ ${fmt(L)} m\nVerticaal Ø${vert.d}/${vert.s} per zijde (As,v ≥ 0,002·Ac, §9.6.2)\nHorizontaal Ø${hor.d}/${hor.s} per zijde (≥ 25 % As,v en ≥ 0,001·Ac, §9.6.3)\nDekking cnom = ${Math.round(c * 1000)} mm (XC1)${ops.length ? `\n${ops.length} opening(en) uitgespaard` : ''}`;
        add('wapening', merge(geos), { kleur: 0xff6b5e, op: 0.8, naam: 'Wandwapening', info: info + tag });
        tel.wanden++;
      }
      // ---------- balken ----------
      else if (T === 'IFCBEAM' || T === 'IFCBEAMSTANDARDCASE') {
        const B = obb(el.geo); const L = Math.max(B.lu, B.lv), b = Math.min(B.lu, B.lv), h = B.h;
        if (soortMateriaal(el) === 'staal' || !isBeton(el) || L < 0.5 || b < 0.15) continue;
        const alongU = B.lu >= B.lv; const pt = (u, w, y) => alongU ? P(B, u, w, y) : P(B, w, u, y);
        const c = 0.03, onder = 16, boven = 12, beugel = 8;
        const d = h * 1000 - c * 1000 - beugel - onder / 2;
        const sb = Math.min(0.75 * d, 300, 600); // §9.2.2(6)
        const geos = [];
        const xs = [-b / 2 + c + 0.012, 0, b / 2 - c - 0.012];
        for (const w of xs) geos.push(tubeGeo([pt(-L / 2 + c, w, B.y0 + c + 0.016), pt(L / 2 - c, w, B.y0 + c + 0.016)], onder / 2000, { joints: false, radial: 5 }));
        for (const w of [xs[0], xs[2]]) geos.push(tubeGeo([pt(-L / 2 + c, w, B.y1 - c - 0.014), pt(L / 2 - c, w, B.y1 - c - 0.014)], boven / 2000, { joints: false, radial: 5 }));
        for (let u = -L / 2 + 0.05; u <= L / 2 - 0.05; u += sb / 1000) {
          const yb = B.y0 + c, yt = B.y1 - c, w0 = -b / 2 + c, w1 = b / 2 - c;
          geos.push(tubeGeo([pt(u, w0, yb), pt(u, w1, yb), pt(u, w1, yt), pt(u, w0, yt), pt(u, w0, yb)], beugel / 2000, { joints: false, radial: 4 }));
        }
        add('wapening', merge(geos), { naam: 'Balkwapening', info: `${el.naam || 'Betonbalk'} — ${Math.round(b * 1000)} × ${Math.round(h * 1000)} mm, L ≈ ${fmt(L)} m\nOnder 3Ø${onder}, boven 2Ø${boven}, beugels Ø${beugel}/${Math.round(sb)} (≤ 0,75·d, §9.2.2)\nZonder belastingen in het IFC: minimale/typische wapening, geen sterkteberekening` + tag });
        tel.balken++;
      }
      // ---------- kolommen ----------
      else if (T === 'IFCCOLUMN' || T === 'IFCCOLUMNSTANDARDCASE') {
        const B = obb(el.geo); const a = Math.min(B.lu, B.lv), bb = Math.max(B.lu, B.lv);
        if (soortMateriaal(el) === 'staal' || !isBeton(el) || a < 0.15 || B.h < 1) continue;
        const c = 0.03, ds = 16, db2 = 8, s = Math.min(20 * ds, a * 1000, 400); // §9.5.3
        const geos = [];
        const hu = B.lu / 2 - c - 0.012, hv = B.lv / 2 - c - 0.012;
        for (const [x, z] of [[-hu, -hv], [hu, -hv], [hu, hv], [-hu, hv]]) geos.push(tubeGeo([P(B, x, z, B.y0 + 0.03), P(B, x, z, B.y1 - 0.03)], ds / 2000, { joints: false, radial: 5 }));
        for (let y = B.y0 + 0.05; y <= B.y1 - 0.05; y += s / 1000) { const e = [[-hu - 0.01, -hv - 0.01], [hu + 0.01, -hv - 0.01], [hu + 0.01, hv + 0.01], [-hu - 0.01, hv + 0.01], [-hu - 0.01, -hv - 0.01]]; geos.push(tubeGeo(e.map(([x, z]) => P(B, x, z, y)), db2 / 2000, { joints: false, radial: 4 })); }
        add('wapening', merge(geos), { naam: 'Kolomwapening', info: `${el.naam || 'Betonkolom'} — ${Math.round(a * 1000)} × ${Math.round(bb * 1000)} mm\n4Ø${ds} langswapening (≥ Ø8 en As ≥ 0,002·Ac, §9.5.2), beugels Ø${db2}/${Math.round(s)} (≤ min(20Ø; b; 400), §9.5.3)` + tag });
        tel.kolommen++;
      }
    }
    rapport.push(`Gegenereerd: ${tel.platen} betonplaten, ${tel.wanden} betonwanden, ${tel.balken} betonbalken, ${tel.kolommen} betonkolommen.`);
    if (tel.clt || tel.hout) rapport.push(`Hout herkend: ${tel.clt} CLT-elementen (lagen + verbindingen getoond, geen wapening), ${tel.hout} andere houten elementen.`);
    rapport.push('Materiaal herkend aan het IFC-materiaal en de type-naam uit Revit (bv. "CLT", "Hout", "Beton C30/37", "HEA 200").');
    if (tel.onbekend.length) rapport.push(`${tel.onbekend.length} dragend(e) element(en) zonder herkenbaar materiaal${onbekendIsBeton ? ' → als beton behandeld' : ' → niet gewapend'}: ${tel.onbekend.slice(0, 6).map(e => e.naam || e.type).join('; ')}${tel.onbekend.length > 6 ? ' …' : ''}`);
  }

  // ---------- technieken per ruimte ----------
  if (technieken) {
    const ruimtes = elementen.filter(e => e.type === 'IFCSPACE');
    if (!ruimtes.length) {
      rapport.push('— TECHNIEKEN —', 'Geen ruimtes (IfcSpace) in het IFC-bestand → elektriciteit en ventilatie per kamer niet mogelijk. Tip: zet in Revit bij de IFC-export de ruimtes (Rooms) aan.');
      if (vloerverwarming) vloerverwarmingZonderRuimtes();
    }
    else rapport.push('— TECHNIEKEN PER RUIMTE (AREI, NBN D 50-001, brand) —');
    for (const el of ruimtes) {
      const g = el.geo, p = g.attributes.position.array, n = p.length / 3;
      let y0 = Infinity, y1 = -Infinity; for (let i = 0; i < n; i++) { y0 = Math.min(y0, p[i * 3 + 1]); y1 = Math.max(y1, p[i * 3 + 1]); }
      const H = y1 - y0; if (H < 1.8 || H > 8) continue;
      const pts = []; for (let i = 0; i < n; i++) if (p[i * 3 + 1] < y0 + 0.05) pts.push([p[i * 3], p[i * 3 + 2]]);
      const hull = convexHull(pts); if (hull.length < 3) continue;
      const x0 = Math.min(...hull.map(q => q[0])), z0 = Math.min(...hull.map(q => q[1]));
      const vloer = hull.map(([x, z]) => [+(x - x0).toFixed(3), +(z - z0).toFixed(3)]);
      const opn = [];
      for (const { e, B } of openingen) {
        const lx = B.c.x - x0, lz = B.c.z - z0; if (B.y0 > y0 + H || B.y1 < y0) continue;
        if (afstandTotRand(vloer, lx, lz) > 0.35) continue;
        opn.push({ type: e.type === 'IFCDOOR' ? 'deur' : 'raam', x: lx, z: lz, breedte: Math.max(B.lu, B.lv), hoogte: B.h, borstwering: Math.max(0, B.y0 - y0), bevestigd: true });
      }
      // ---- wat staat er al in het IFC binnen deze ruimte? ----
      const objecten = [], aanwezig = new Set(), toestellen = {};
      const x1 = Math.max(...hull.map(q => q[0])), z1 = Math.max(...hull.map(q => q[1]));
      for (const e of elementen) {
        if (e === el || !['elektriciteit', 'water', 'afvoer', 'ventilatie', 'verwarming', 'brand'].includes(e.laag) && !toestelSoort(e)) continue;
        const B = obb(e.geo), cy = (B.y0 + B.y1) / 2;
        if (B.c.x < x0 - 0.3 || B.c.x > x1 + 0.3 || B.c.z < z0 - 0.3 || B.c.z > z1 + 0.3 || cy < y0 - 0.5 || cy > y0 + H + 0.5) continue;
        const soort = toestelSoort(e);
        const lx = +(B.c.x - x0).toFixed(3), lz = +(B.c.z - z0).toFixed(3), ly = +Math.max(0.1, cy - y0).toFixed(3);
        if (!soort) { aanwezig.add(e.laag); continue; }
        toestellen[soort] = (toestellen[soort] || 0) + 1;
        const o = { x: lx, z: lz, bevestigd: true, ifc: true };
        if (soort === 'lamp') objecten.push(ly > H - 0.6 ? { ...o, type: 'lichtpunt' } : { ...o, type: 'wandlamp', y: ly });
        else if (soort === 'stopcontact' || soort === 'schakelaar') objecten.push({ ...o, type: soort, y: ly });
        else if (soort === 'ventiel') objecten.push({ ...o, type: 'ventiel', y: Math.min(ly, H - 0.1) });
        else if (soort === 'lavabo' && !objecten.some(q => q.type === 'lavabo')) objecten.push({ ...o, type: 'lavabo' });
        else if (soort === 'radiator' || soort === 'rookmelder') objecten.push({ ...o, type: soort });
      }
      const proj = { id: 'ifc-ruimte', naam: el.naam, soort: 'ruimte', gebouw: { vloer: 'terplaatse', verwarming: objecten.some(o => o.type === 'radiator') ? 'radiator' : (vloerverwarming && !aanwezig.has('verwarming') ? 'vloer' : 'geen'), ventilatie: 'C', stopcontactenVolledig: objecten.some(o => o.type === 'stopcontact') }, ruimte: { vloer, hoogte: +H.toFixed(3), openingen: opn, objecten } };
      try {
        const res = generate(proj, { alleenTechnieken: true });
        // disciplines die het IFC al met leidingen/kabels invult: niets bijtekenen
        if (aanwezig.size) {
          for (const c of [...res.group.children]) if (aanwezig.has(c.userData?.laag)) res.group.remove(c);
          res.picks = res.picks.filter(m => !aanwezig.has(m.userData.laag));
          res.leidingen = res.leidingen.filter(l => !aanwezig.has(l.laag));
        }
        const tt = Object.entries(toestellen).map(([k, v]) => `${v} ${k}`).join(', ');
        rapport.push(`${el.naam || 'Ruimte'}: uit IFC ${aanwezig.size ? [...aanwezig].join('/') + ' (leidingen)' : 'geen leidingen'}${tt ? '; toestellen: ' + tt : ''} → aangevuld: ${['elektriciteit', 'water', 'afvoer', 'ventilatie', 'brand'].filter(l => !aanwezig.has(l)).join(', ') || 'niets (alles al aanwezig)'}${proj.gebouw.verwarming === 'vloer' ? ', vloerverwarming (geen radiatoren gevonden)' : proj.gebouw.verwarming === 'radiator' ? ', leidingen naar de radiatoren' : ''}`);
        res.group.position.set(x0, y0, z0);
        group.add(res.group);
        for (const m of res.picks) { m.userData.info = `Ruimte: ${el.naam || el.objType || '—'}\n` + m.userData.info; picks.push(m); }
        for (const l of res.leidingen) leidingen.push({ ...l, pts: l.pts.map(q => q.clone().add(V3(x0, y0, z0))) });
        const lab = makeLabel(`${el.naam || 'Ruimte'}${el.objType ? ' · ' + el.objType : ''}`, { size: 0.06, border: '#ffd400' });
        const [cx, cz] = vloer.reduce((s, q) => [s[0] + q[0] / vloer.length, s[1] + q[1] / vloer.length], [0, 0]);
        lab.position.set(x0 + cx, y0 + 1.6, z0 + cz); lab.userData = { laag: 'elektriciteit', fase: 5, isLabel: true, kern: true }; group.add(lab);
        tel.ruimtes++;
      } catch (err) { console.warn('ruimte', el.naam, err); }
    }
    if (ruimtes.length) rapport.push(`${tel.ruimtes} ruimte(s) aangevuld met wat in het IFC ontbreekt (aannames; ${ruimtes.length - tel.ruimtes} overgeslagen).`);
  }
  return { group, picks, leidingen, rapport };

  /** Zonder IfcSpace: vloerverwarming op elke vloerplaat waarop wanden staan, tussen de wanden door. */
  function vloerverwarmingZonderRuimtes() {
    const heeftRad = elementen.some(e => toestelSoort(e) === 'radiator');
    const heeftLeiding = elementen.some(e => e.laag === 'verwarming' && !toestelSoort(e));
    if (heeftRad || heeftLeiding) { rapport.push(heeftRad ? 'Radiatoren gevonden → geen vloerverwarming getekend.' : 'Verwarmingsleidingen uit het IFC → niets bijgetekend.'); return; }
    const wanden = elementen.filter(e => /^IFCWALL/.test(e.type)).map(e => obb(e.geo));
    const platen = elementen.filter(e => /^IFCSLAB/.test(e.type)).map(e => ({ e, B: obb(e.geo) }));
    let n = 0;
    for (const { e, B } of platen) {
      if (B.h > 0.6 || Math.min(B.lu, B.lv) < 1) continue;
      const opPlaat = wanden.filter(W => Math.abs(W.y0 - B.y1) < 0.25 && Math.abs(W.c.x - B.c.x) < (B.lu + B.lv) / 2 && Math.abs(W.c.z - B.c.z) < (B.lu + B.lv) / 2);
      if (!opPlaat.length) continue; // dak of plafond: geen vloerverwarming
      const alongU = B.lu >= B.lv, L = Math.max(B.lu, B.lv), Lo = Math.min(B.lu, B.lv);
      const ax = alongU ? B.u : B.v, bx = alongU ? B.v : B.u;
      const yV = B.y1 + 0.045;
      // wanden als rechthoeken in (a,b)-coördinaten van de plaat
      const rects = opPlaat.map(W => {
        const hu = W.lu / 2 + 0.12, hv = W.lv / 2 + 0.12, cs = [];
        for (const [s, t] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { const x = W.c.x + W.u.x * s * hu + W.v.x * t * hv - B.c.x, z = W.c.z + W.u.z * s * hu + W.v.z * t * hv - B.c.z; cs.push([x * ax.x + z * ax.z, x * bx.x + z * bx.z]); }
        return { a0: Math.min(...cs.map(c => c[0])), a1: Math.max(...cs.map(c => c[0])), b0: Math.min(...cs.map(c => c[1])), b1: Math.max(...cs.map(c => c[1])) };
      });
      const pt = (a, b) => V3(B.c.x + ax.x * a + bx.x * b, yV, B.c.z + ax.z * a + bx.z * b);
      const geos = [];
      for (let b = -Lo / 2 + 0.15; b <= Lo / 2 - 0.15 && geos.length < 4000; b += 0.15) {
        let iv = [[-L / 2 + 0.15, L / 2 - 0.15]];
        for (const r of rects) if (b > r.b0 && b < r.b1) iv = iv.flatMap(([p, q]) => (r.a1 <= p || r.a0 >= q) ? [[p, q]] : [[p, Math.max(p, r.a0)], [Math.min(q, r.a1), q]]);
        for (const [p, q] of iv) if (q - p > 0.4) { const pts = [pt(p, b), pt(q, b)]; geos.push(tubeGeo(pts, 0.008, { dash: 0.25, gap: 0.08, joints: false, radial: 5 })); leidingen.push({ pts, laag: 'verwarming', naam: 'Vloerverwarming' }); }
      }
      const m = merge(geos); if (!m) continue;
      add('verwarming', m, { kleur: 0xc86bff, naam: 'Vloerverwarming', fase: 4, info: `Vloerverwarming op ${e.naam || 'vloerplaat'}: PE-Xa 16 mm, h.o.h. 150 mm in de dekvloer, tussen de wanden.\nGeen ruimtes (IfcSpace) in het IFC → legpatroon schematisch, zonder verdeler.` + tag });
      n++;
    }
    rapport.push(n ? `Geen radiatoren gevonden → vloerverwarming getekend op ${n} vloerplaat(en), tussen de wanden.` : 'Geen vloerplaat met wanden erop gevonden → geen vloerverwarming getekend.');
  }
}

function convexHull(pts) {
  const P = [...new Map(pts.map(p => [p[0].toFixed(3) + ',' + p[1].toFixed(3), p])).values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (P.length < 3) return P;
  const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const p of P) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
  for (const p of P.slice().reverse()) { while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}
function afstandTotRand(poly, x, z) {
  let d = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length], dx = b[0] - a[0], dz = b[1] - a[1], L2 = dx * dx + dz * dz;
    let t = L2 ? ((x - a[0]) * dx + (z - a[1]) * dz) / L2 : 0; t = Math.max(0, Math.min(1, t));
    d = Math.min(d, Math.hypot(x - a[0] - dx * t, z - a[1] - dz * t));
  }
  return d;
}

/** Herken toestellen uit het IFC (klasse of naam) om er leidingen naartoe te trekken. */
function toestelSoort(e) {
  const t = `${e.naam} ${e.objType} ${e.materiaal || ''}`, T = e.type;
  if (T === 'IFCSWITCHINGDEVICE' || /schakelaar|switch|drukknop|dimmer/i.test(t)) return 'schakelaar';
  if (T === 'IFCOUTLET' || /stopcontact|socket|outlet|contactdoos|wcd\b/i.test(t)) return 'stopcontact';
  if (T === 'IFCLIGHTFIXTURE' || T === 'IFCLAMP' || /lamp|light fixture|lighting|armatuur|luminaire|verlichting|spot\b|downlight/i.test(t)) return 'lamp';
  if (/lavabo|wastafel|sink|basin|lavatory|wasbak/i.test(t)) return 'lavabo';
  if (T === 'IFCSPACEHEATER' || /radiator|convector/i.test(t)) return 'radiator';
  if (T === 'IFCAIRTERMINAL' || /ventiel|rooster|grille|diffuser|air terminal|luchtventiel/i.test(t)) return 'ventiel';
  if (/rookmelder|smoke|detector|branddetect/i.test(t) || T === 'IFCALARM' || T === 'IFCSENSOR') return 'rookmelder';
  return null;
}
