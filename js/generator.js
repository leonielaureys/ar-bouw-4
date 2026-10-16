// generator.js — maakt structuur, wapening en technieken voor een ruimte uit eenvoudige gegevens.
// Normatieve basis (voorontwerp, aannames worden gestreept getoond):
//  - EN 1990 / EN 1991-1-1 / EN 1992-1-1 (+ANB) voor vloeren en betonwanden (zie ec2.js)
//  - EN 1996 (EC6) metselwerk, EN 1995 (EC5) hout
//  - AREI (Belgisch elektriciteitsreglement) voor elektriciteit — geen Eurocode
//  - EN 12056-2 binnenriolering, NBN D 50-001 ventilatie, KB Basisnormen brandpreventie
import * as THREE from 'three';
import { V3, tubeGeo, boxGeo, beamGeo, merge, makeLabel, pointInPoly, polyArea, polyCentroid, insetPoly,
  polyPerimeter, pointAtPerim, pathAlongPerim, perimParam } from './geo.js';
import { plaatTerPlaatse, welfsels, predal, houtenBalken, fmt } from './ec2.js';

export const LAGEN = {
  structuur: { naam: 'Structuur', kleur: 0x4da3ff },
  wapening: { naam: 'Wapening', kleur: 0xff3b30 },
  elektriciteit: { naam: 'Elektriciteit', kleur: 0xffd400 },
  water: { naam: 'Water', kleur: 0x29b6f6 },
  afvoer: { naam: 'Afvoer', kleur: 0xff8c1a },
  verwarming: { naam: 'Verwarming', kleur: 0xc86bff },
  ventilatie: { naam: 'Ventilatie', kleur: 0x7fe3d0 },
  brand: { naam: 'Brand', kleur: 0xff2d55 },
  afwerking: { naam: 'Vloeropbouw', kleur: 0xb0a48a },
  ifc: { naam: 'IFC overig', kleur: 0xd0d6de },
};
export const FASEN = ['Alles', '1 · Draagstructuur + wapening', '2 · Wanden + schacht', '3 · Leidingen ruwbouw', '4 · Vloeropbouw + verwarming', '5 · Afwerking + toestellen'];
export const VLOERTYPES = { welfsels: 'Welfsels', terplaatse: 'Plaat ter plaatse', predal: 'Predallen', hout: 'Houten balken', clt: 'CLT-vloer', onbekend: 'Weet ik niet' };
/** Vloertype afleiden uit de bouwperiode als het onbekend is (typische Belgische praktijk). */
export function vloerUitPeriode(periode) {
  return { voor1945: 'hout', '1945-1970': 'terplaatse', '1970-2000': 'predal', '2000-2015': 'welfsels', na2015: 'welfsels' }[periode] || 'welfsels';
}

const WANDTYPES = {
  drager: { naam: 'Dragende scheidingswand', lagen: [['Pleister', 0.01, 0xdfe8f5], ['Beton C25/30, dragend', 0.19, 0x4da3ff]],
    info: 'Dragende wand in gewapend beton (EN 1992-1-1 §9.6), draagt de vloerplaten.\nAkoestisch scheidend tussen kamers.' },
  gang: { naam: 'Wand naar gang (evacuatieweg)', lagen: [['Pleister', 0.01, 0xdfe8f5], ['Kalkzandsteen 150 mm', 0.15, 0x7fb6ff]],
    info: 'Niet-dragende wand naar de gang = evacuatieweg (zie brandplan).\nBrandwerendheid volgens KB Basisnormen (middelhoog gebouw), EC6 metselwerk.' },
  buiten: { naam: 'Gevel (spouwmuur)', lagen: [['Pleister', 0.01, 0xdfe8f5], ['Binnenblad kalkzandsteen 140', 0.14, 0x7fb6ff], ['Isolatie PIR 120', 0.12, 0xfff07a], ['Spouw 30', 0.03, 0x000000], ['Gevelsteen 90', 0.09, 0xd9825b]],
    info: 'Spouwmuur: binnenblad draagt, buitenblad = gevelsteen. Spouwankers ≈ 4–5/m² (EC6 + praktijk).\nIsolatiedikte volgens EPB-eis (aanname).' },
  dragerMetsel: { naam: 'Dragende metselwerkwand', lagen: [['Pleister', 0.01, 0xdfe8f5], ['Snelbouwsteen 190, dragend', 0.19, 0xd98c6a]],
    info: 'Dragend metselwerk (EN 1996, EC6). Geen wapening; lateien boven openingen.' },
  clt: { naam: 'CLT-wand', lagen: [['Gipsplaat 12,5', 0.0125, 0xdfe8f5], ['CLT 100 (kruislaaghout)', 0.10, 0xd9a066]],
    info: 'Wand in kruislaaghout (CLT, EN 16351 / EC5). Geen wapening; hoekankers en trekankers als verbindingen.\nLeidingen meestal in een voorzetwand of uitgefreesde sleuf.' },
  gangDragend: { naam: 'Dragende wand naar gang (evacuatieweg)', lagen: [['Pleister', 0.01, 0xdfe8f5], ['Beton C25/30, dragend', 0.20, 0x4da3ff]],
    info: 'Dragende betonwand naar de gang: de welfsels steunen hierop.\nGang = evacuatieweg (zie brandplan): brandwerend volgens KB Basisnormen.' },
  scheiding: { naam: 'Scheidingswand tussen kamers', lagen: [['Pleister', 0.01, 0xdfe8f5], ['Kalkzandsteen 150, niet-dragend', 0.15, 0x7fb6ff]],
    info: 'Niet-dragende, akoestisch scheidende wand naar de buurkamer (welfsels overspannen evenwijdig hiermee).' },
  schachtwand: { naam: 'Schachtwand', lagen: [['Pleister', 0.01, 0xdfe8f5], ['Brandwerende plaat / blokken 100', 0.10, 0x9aa7b8]],
    info: 'Wand rond de technische schacht (hier groen geschilderd, met de afzuigventielen).\nBrandwerend (schacht doorloopt alle verdiepingen), aanname.' },
  binnen: { naam: 'Lichte binnenwand', lagen: [['Pleister', 0.01, 0xdfe8f5], ['Gipsblokken 100', 0.10, 0x9cc7ff]], info: 'Niet-dragende binnenwand.' },
};

export function defaults(p) {
  const g = p.gebouw ||= {};
  g.vloer ||= 'welfsels'; g.beton ||= 'C25/30'; g.milieuklasse ||= 'XC1';
  g.verwarming ||= 'vloer'; g.ventilatie ||= 'C';
  g.vloeropbouw ||= { afwerking: 0.015, chape: 0.07, isolatie: 0.06 };
  g.hStopcontact ??= 0.30; g.hSchakelaar ??= 1.10;
  const r = p.ruimte; r.hoogte ||= 2.6; r.openingen ||= []; r.objecten ||= [];
  return p;
}

/** Hoofdfunctie */
export function generate(project, opts = {}) {
  const p = defaults(structuredClone(project));
  const vloerAfgeleid = p.gebouw.vloer === 'onbekend';
  if (vloerAfgeleid) p.gebouw.vloer = vloerUitPeriode(p.info?.bouwperiode);
  const g = p.gebouw, R = p.ruimte;
  const H = R.hoogte;
  const poly = R.vloer.map(v => [v[0], v[1]]);
  const vo = g.vloeropbouw, FB = vo.afwerking + vo.chape + vo.isolatie;
  const out = new THREE.Group(); out.name = 'gegenereerd';
  const picks = [], leidingen = [], rapport = [];
  const ST = !opts.alleenTechnieken;
  const mats = new Map();
  const mat = (kleur, opacity = 1, extra = {}) => {
    const k = `${kleur}|${opacity}|${extra.side || ''}`;
    if (!mats.has(k)) mats.set(k, new THREE.MeshBasicMaterial({ color: kleur, transparent: opacity < 1, opacity, depthWrite: opacity >= 1, side: extra.side ?? THREE.FrontSide }));
    return mats.get(k);
  };
  const add = (laag, geo, { kleur = LAGEN[laag].kleur, opacity = 1, info = '', naam = '', fase = 3, aanname = true, edges = false, pickable = true } = {}) => {
    if (!geo) return null;
    const m = new THREE.Mesh(geo, mat(kleur, opacity, { side: opacity < 1 ? THREE.DoubleSide : THREE.FrontSide }));
    m.userData = { laag, info, naam, fase, aanname, pickable };
    if (opacity < 1) m.renderOrder = 1;
    out.add(m); if (pickable) picks.push(m);
    if (edges) {
      const e = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 30), new THREE.LineBasicMaterial({ color: kleur, transparent: true, opacity: 0.55 }));
      e.userData = { laag, fase, pickable: false }; out.add(e);
    }
    return m;
  };
  const label = (laag, text, pos, fase = 5, { size = 0.042, kern = false } = {}) => {
    const s = makeLabel(text, { size, border: '#' + LAGEN[laag].kleur.toString(16).padStart(6, '0') });
    s.position.copy(pos); s.userData = { laag, fase, isLabel: true, kern };
    out.add(s); return s;
  };
  const tag = (aanname) => aanname ? '\n⚠ AANNAME — niet gebruiken om te boren' : '\n✔ Bevestigd (ingemeten)';

  // ---------- Wanden ----------
  const ccw = polyArea(poly) > 0;
  const walls = poly.map((a, i) => {
    const b = poly[(i + 1) % poly.length];
    let dx = b[0] - a[0], dz = b[1] - a[1]; const len = Math.hypot(dx, dz); dx /= len; dz /= len;
    let nx = -dz, nz = dx; if (!ccw) { nx = -nx; nz = -nz; }
    if (!pointInPoly((a[0] + b[0]) / 2 + nx * 0.01, (a[1] + b[1]) / 2 + nz * 0.01, poly)) { nx = -nx; nz = -nz; }
    return { i, a, b, dx, dz, nx, nz, len, rotY: Math.atan2(-dz, dx), openingen: [] };
  });
  const wpt = (W, u, v, w = 0) => V3(W.a[0] + W.dx * u - W.nx * w, v, W.a[1] + W.dz * u - W.nz * w);
  const nearestWall = (x, z) => {
    let best = null;
    for (const W of walls) {
      let u = (x - W.a[0]) * W.dx + (z - W.a[1]) * W.dz; u = Math.max(0, Math.min(W.len, u));
      const px = W.a[0] + W.dx * u, pz = W.a[1] + W.dz * u, d = Math.hypot(x - px, z - pz);
      if (!best || d < best.d) best = { W, u, d };
    }
    return best;
  };
  // openingen toewijzen
  for (const o of R.openingen) {
    const n = nearestWall(o.x, o.z);
    const def = o.type === 'deur' ? { breedte: 0.93, hoogte: 2.11, borstwering: 0 } : { breedte: 1.2, hoogte: 1.3, borstwering: 0.9 };
    const oo = { ...def, ...o, W: n.W, u: n.u };
    oo.u0 = Math.max(0, oo.u - oo.breedte / 2); oo.u1 = Math.min(n.W.len, oo.u + oo.breedte / 2);
    n.W.openingen.push(oo);
  }
  const longest0 = walls.reduce((m, W) => W.len > m.len ? W : m, walls[0]);
  const shortest = walls.reduce((m, W) => W.len < m.len ? W : m, walls[0]);
  // referentiewand = een dragende wand; standaard de langste (welfsels over de korte richting),
  // 'lang' = welfsels overspannen de lange richting en steunen op de korte wanden (gang + gevel)
  void shortest;
  const longest = g.draagrichting === 'lang' ? { dx: longest0.nx, dz: longest0.nz, nx: longest0.dx, nz: longest0.dz } : longest0;
  for (const W of walls) {
    const override = R.wanden?.[W.i];
    if (override) W.type = override;
    else if (W.openingen.some(o => o.type === 'raam')) W.type = 'buiten';
    else if (W.openingen.some(o => o.type === 'deur')) W.type = Math.abs(W.dx * longest.dx + W.dz * longest.dz) > 0.9 && g.draagrichting === 'lang' ? 'gangDragend' : 'gang';
    else if (Math.abs(W.dx * longest.dx + W.dz * longest.dz) > 0.9) W.type = 'drager';
    else if (g.draagrichting === 'lang') W.type = 'scheiding';
    else W.type = 'binnen';
    // wandmateriaal uit de projectfiche
    const wm = p.info?.wandmateriaal;
    if (!override && wm === 'clt' && W.type !== 'buiten') W.type = 'clt';
    else if (!override && wm === 'metselwerk' && (W.type === 'drager' || W.type === 'gangDragend')) W.type = 'dragerMetsel';
    else if (!override && wm === 'gips' && (W.type === 'scheiding' || W.type === 'binnen')) W.type = 'binnen';
  }
  const deuren = walls.flatMap(W => W.openingen.filter(o => o.type === 'deur'));
  const schacht = R.objecten.find(o => o.type === 'schacht');
  const inSchacht = (x, z, m = 0) => schacht && x > Math.min(schacht.x0, schacht.x1) - m && x < Math.max(schacht.x0, schacht.x1) + m && z > Math.min(schacht.z0, schacht.z1) - m && z < Math.max(schacht.z0, schacht.z1) + m;

  // ---------- Vloerframe (overspanningsrichting) ----------
  const A = { x: longest.dx, z: longest.dz };             // richting langs de dragende wanden
  const S = { x: longest.nx, z: longest.nz };             // overspanningsrichting (loodrecht op dragers)
  const toAS = (x, z) => [x * A.x + z * A.z, x * S.x + z * S.z];
  const fromAS = (a, s) => [a * A.x + s * S.x, a * A.z + s * S.z];
  const asPoly = poly.map(([x, z]) => toAS(x, z));
  const aMin = Math.min(...asPoly.map(p => p[0])), aMax = Math.max(...asPoly.map(p => p[0]));
  const sMin = Math.min(...asPoly.map(p => p[1])), sMax = Math.max(...asPoly.map(p => p[1]));
  const Lspan = (sMax - sMin) + 0.2;
  const rotA = Math.atan2(-A.z, A.x);
  const asBox = (a0, a1, s0, s1, y0, y1) => {
    const [cx, cz] = fromAS((a0 + a1) / 2, (s0 + s1) / 2);
    return boxGeo(V3(cx, (y0 + y1) / 2, cz), V3(Math.abs(a1 - a0), Math.abs(y1 - y0), Math.abs(s1 - s0)), rotA);
  };
  const asV = (a, s, y) => { const [x, z] = fromAS(a, s); return V3(x, y, z); };
  // schacht in AS-coördinaten
  let sch = null;
  if (schacht) {
    const c = [[schacht.x0, schacht.z0], [schacht.x1, schacht.z1], [schacht.x0, schacht.z1], [schacht.x1, schacht.z0]].map(([x, z]) => toAS(x, z));
    sch = { a0: Math.min(...c.map(p => p[0])), a1: Math.max(...c.map(p => p[0])), s0: Math.min(...c.map(p => p[1])), s1: Math.max(...c.map(p => p[1])) };
  }
  /** rechthoek min schacht -> lijst van rechthoeken */
  const rectMinus = (r) => {
    if (!sch || sch.a1 <= r.a0 || sch.a0 >= r.a1 || sch.s1 <= r.s0 || sch.s0 >= r.s1) return [r];
    const out = [];
    if (sch.s0 > r.s0) out.push({ ...r, s1: sch.s0 });
    if (sch.s1 < r.s1) out.push({ ...r, s0: sch.s1 });
    const s0 = Math.max(r.s0, sch.s0), s1 = Math.min(r.s1, sch.s1);
    if (sch.a0 > r.a0) out.push({ ...r, a1: sch.a0, s0, s1 });
    if (sch.a1 < r.a1) out.push({ ...r, a0: sch.a1, s0, s1 });
    return out.filter(q => q.a1 - q.a0 > 0.02 && q.s1 - q.s0 > 0.02);
  };
  /** lijnstuk langs s (op positie a) of langs a (op positie s) knippen rond schacht */
  const clipSeg = (dir, pos, t0, t1, marge = 0.03) => {
    if (!sch) return [[t0, t1]];
    const [p0, p1, q0, q1] = dir === 's' ? [sch.a0, sch.a1, sch.s0, sch.s1] : [sch.s0, sch.s1, sch.a0, sch.a1];
    if (pos < p0 - marge || pos > p1 + marge) return [[t0, t1]];
    const r = []; if (q0 - marge > t0) r.push([t0, q0 - marge]); if (q1 + marge < t1) r.push([q1 + marge, t1]); return r;
  };

  // ---------- Vloerplaten (onder de kamer + plafond) ----------
  const slabExt = { a0: aMin - 0.2, a1: aMax + 0.2, s0: sMin - 0.1, s1: sMax + 0.1 };
  const vtype = g.vloer;
  let ontwerp;
  if (vtype === 'welfsels') ontwerp = welfsels({ L: Lspan });
  else if (vtype === 'predal') ontwerp = predal({ L: Lspan, beton: g.beton, klasse: g.milieuklasse });
  else if (vtype === 'hout') ontwerp = houtenBalken({ L: Lspan });
  else if (vtype === 'clt') { const hC = Lspan <= 4 ? 140 : Lspan <= 5.5 ? 180 : Lspan <= 7 ? 220 : 260; ontwerp = { type: 'clt', h: hC, L: Lspan, rapport: [`CLT-vloer (kruislaaghout) ≈ ${hC} mm voor L ≈ ${fmt(Lspan)} m (vuistregel L/h ≈ 28–30; trillingen EN 1995-1-1 §7.3 bepalen vaak de dikte)`, 'Geen wapening; schroeven aan de opleggingen; vaak met zwevende dekvloer voor akoestiek'] }; }
  else ontwerp = plaatTerPlaatse({ L: Lspan, beton: g.beton, klasse: g.milieuklasse });
  if (ST) rapport.push('— VLOEREN —', ...(vloerAfgeleid ? [`Vloertype onbekend → afgeleid uit de bouwperiode (${p.info?.bouwperiode || 'onbekend'}): ${VLOERTYPES[vtype]}`] : []), ...ontwerp.rapport);
  const hS = ontwerp.h / 1000;
  const slabs = [
    { naam: 'Vloer onder de kamer', top: -FB, lvl: 'onder' },
    { naam: 'Plafond (vloer van het verdiep erboven)', top: H + 0.01 + hS + (vtype === 'welfsels' ? ontwerp.druklaag / 1000 : 0), lvl: 'boven' },
  ];
  const coreAs = []; // a-posities van welfselkanalen (voor kabels)
  for (const sl of (ST ? slabs : [])) {
    if (vtype === 'welfsels') {
      const dl = ontwerp.druklaag / 1000, w = ontwerp.breedte;
      const yTopW = sl.top - dl, yBot = yTopW - hS;
      const infoW = `Welfsel ${ontwerp.h} mm, breedte 1200 mm, overspanning ≈ ${fmt(Lspan)} m\n(${sl.naam})\nVoorgespannen holle-kernplaat (EN 1168).` + tag(true);
      add('structuur', merge(rectMinus({ ...slabExt, s0: slabExt.s0, s1: slabExt.s1 }).map(r => asBox(r.a0, r.a1, r.s0, r.s1, yTopW, sl.top))), { opacity: 0.10, naam: 'Druklaag', info: `Druklaag ${ontwerp.druklaag} mm met net Ø6/150` + tag(true), fase: 1, edges: true });
      const panelGeos = [], coreGeos = [], strandGeos = [];
      let rav = [];
      for (let a0 = slabExt.a0, k = 0; a0 < slabExt.a1 - 0.05; a0 += w, k++) {
        const a1 = Math.min(a0 + w, slabExt.a1);
        const pieces = rectMinus({ a0: a0 + 0.005, a1: a1 - 0.005, s0: slabExt.s0, s1: slabExt.s1 });
        if (pieces.length !== 1 || pieces[0].s0 !== slabExt.s0 || pieces[0].s1 !== slabExt.s1) rav.push({ a0, a1 });
        for (const r of pieces) {
          panelGeos.push(asBox(r.a0, r.a1, r.s0, r.s1, yBot, yTopW));
          const n = ontwerp.kernen, bw = (r.a1 - r.a0);
          if (bw > 0.3) {
            const nn = Math.max(1, Math.round(n * bw / w));
            for (let c = 0; c < nn; c++) {
              const ac = r.a0 + (c + 0.5) * bw / nn;
              coreGeos.push(tubeGeo([asV(ac, r.s0, (yBot + yTopW) / 2), asV(ac, r.s1, (yBot + yTopW) / 2)], ontwerp.kernD / 2, { joints: false, radial: 10 }));
              if (sl.lvl === 'boven') coreAs.push(ac);
            }
            for (let c = 0; c <= nn; c++) {
              const ac = r.a0 + 0.03 + c * (bw - 0.06) / nn;
              strandGeos.push(tubeGeo([asV(ac, r.s0 + 0.02, yBot + 0.035), asV(ac, r.s1 - 0.02, yBot + 0.035)], 0.006, { joints: false, radial: 5 }));
            }
          }
        }
      }
      add('structuur', merge(panelGeos), { opacity: 0.16, naam: 'Welfsels', info: infoW, fase: 1, edges: true });
      add('structuur', merge(coreGeos), { kleur: 0x2a6fd6, opacity: 0.22, naam: 'Kanalen welfsel', info: 'Holle kernen (kanalen) in het welfsel.\nKabels voor plafondlichtpunten worden vaak door een kanaal getrokken.' + tag(true), fase: 1 });
      add('wapening', merge(strandGeos), { naam: 'Voorspanstrengen', info: `Voorspanstrengen ≈ Ø9,3 mm onderaan in de ribben\n(aantal/diameter volgens fabrikant, EN 1168)` + tag(true), fase: 1 });
      // net in druklaag
      const net = [], yN = sl.top - dl / 2;
      for (let s = slabExt.s0 + 0.03; s < slabExt.s1 - 0.03; s += 0.15) for (const [t0, t1] of clipSeg('a', s, slabExt.a0 + 0.03, slabExt.a1 - 0.03)) net.push(tubeGeo([asV(t0, s, yN), asV(t1, s, yN)], 0.003, { joints: false, radial: 4 }));
      for (let a = slabExt.a0 + 0.03; a < slabExt.a1 - 0.03; a += 0.15) for (const [t0, t1] of clipSeg('s', a, slabExt.s0 + 0.03, slabExt.s1 - 0.03)) net.push(tubeGeo([asV(a, t0, yN + 0.006), asV(a, t1, yN + 0.006)], 0.003, { joints: false, radial: 4 }));
      add('wapening', merge(net), { naam: 'Wapeningsnet druklaag', info: 'Wapeningsnet Ø6/150 in de druklaag (50 mm)' + tag(true), fase: 1 });
      // raveelijzers rond schacht
      if (sch && rav.length) {
        const ra0 = Math.min(...rav.map(r => r.a0)) - 0.6, ra1 = Math.max(...rav.map(r => r.a1)) + 0.6;
        const rg = [];
        for (const s of [sch.s0 - 0.03, sch.s1 + 0.03]) {
          if (s < slabExt.s0 || s > slabExt.s1) continue;
          rg.push(asBox(ra0, ra1, s - 0.04, s + 0.04, yTopW, yTopW + 0.008), asBox(ra0, ra1, s - 0.004, s + 0.004, yBot - 0.005, yTopW + 0.008));
        }
        add('wapening', merge(rg), { kleur: 0xff6b5e, naam: 'Raveelijzers', info: 'Raveelijzers (stalen hoekprofielen) rond de schachtsparing:\nvangen de doorgezaagde welfsels op en dragen af naar de volle platen ernaast.' + tag(true), fase: 1 });
        if (sl.lvl === 'onder') label('wapening', `Raveelijzers rond schacht`, asV((sch.a0 + sch.a1) / 2, (sch.s0 + sch.s1) / 2, sl.top + 0.05), 1);
      }
      if (sl.lvl === 'boven') label('structuur', `Welfsels ${ontwerp.h} mm · overspanning ≈ ${fmt(Lspan, 1)} m`, asV((aMin + aMax) / 2, (sMin + sMax) / 2, H - 0.05), 1, { kern: true });
    } else if (vtype === 'clt') {
      const yBot = sl.top - hS, n = hS <= 0.12 ? 3 : hS <= 0.2 ? 5 : 7;
      add('structuur', merge(rectMinus(slabExt).map(r => asBox(r.a0, r.a1, r.s0, r.s1, yBot, sl.top))), { kleur: 0xd9a066, opacity: 0.16, naam: 'CLT-vloer', info: ontwerp.rapport.join('\n') + tag(true), fase: 1, edges: true });
      const lijnen = [];
      for (let i = 1; i < n; i++) { const y = yBot + i * hS / n; lijnen.push(tubeGeo([asV(slabExt.a0, slabExt.s0, y), asV(slabExt.a1, slabExt.s0, y), asV(slabExt.a1, slabExt.s1, y), asV(slabExt.a0, slabExt.s1, y), asV(slabExt.a0, slabExt.s0, y)], 0.003, { joints: false, radial: 4 })); }
      add('structuur', merge(lijnen), { kleur: 0xd9a066, naam: 'CLT-lagen', info: `${n} kruiselings verlijmde lamellen` + tag(true), fase: 1 });
      const sch2 = [];
      for (const sE of [slabExt.s0 + 0.05, slabExt.s1 - 0.05]) for (let a = slabExt.a0 + 0.15; a < slabExt.a1 - 0.1; a += 0.3) sch2.push(tubeGeo([asV(a, sE, sl.top + 0.005), asV(a, sE + (sE < 0 || sE === slabExt.s0 + 0.05 ? -0.08 : 0.08), yBot - 0.12)], 0.004, { joints: false, radial: 4 }));
      add('wapening', merge(sch2), { kleur: 0xbfc7d1, naam: 'Schroeven aan opleggingen', info: 'Volledig-draadschroeven h.o.h. ± 0,3 m (EC5 §8, aanname)' + tag(true), fase: 1 });
    } else if (vtype === 'hout') {
      const yBot = sl.top - 0.018 - hS;
      const beams = [];
      for (let a = slabExt.a0 + 0.1; a < slabExt.a1 - 0.05; a += ontwerp.hoh) for (const [t0, t1] of clipSeg('s', a, slabExt.s0, slabExt.s1, 0.05)) beams.push(beamGeo(asV(a, t0, yBot + hS / 2), asV(a, t1, yBot + hS / 2), 0.075, hS));
      add('structuur', merge(beams), { kleur: 0xd9a066, opacity: 0.35, naam: 'Houten balken', info: ontwerp.rapport.join('\n') + tag(true), fase: 1, edges: true });
      add('structuur', merge(rectMinus(slabExt).map(r => asBox(r.a0, r.a1, r.s0, r.s1, sl.top - 0.018, sl.top))), { kleur: 0xd9a066, opacity: 0.12, naam: 'OSB-plaat', info: 'OSB 18 mm' + tag(true), fase: 1 });
    } else {
      // ter plaatse of predal
      const yBot = sl.top - hS;
      add('structuur', merge(rectMinus(slabExt).map(r => asBox(r.a0, r.a1, r.s0, r.s1, yBot, sl.top))), { opacity: 0.13, naam: vtype === 'predal' ? 'Breedplaatvloer' : 'Betonplaat', info: ontwerp.rapport.slice(0, 2).join('\n') + tag(true), fase: 1, edges: true });
      if (vtype === 'predal') add('structuur', merge(rectMinus(slabExt).map(r => asBox(r.a0, r.a1, r.s0, r.s1, yBot, yBot + 0.05))), { kleur: 0x9fc5ff, opacity: 0.18, naam: 'Predal (prefab onderplaat)', info: 'Prefab onderplaat 50 mm met de onderwapening ingestort' + tag(true), fase: 1 });
      const c = ontwerp.cnom / 1000, dm = ontwerp.hoofd.d / 1000, dv = ontwerp.verdeel.d / 1000, db = ontwerp.boven.d / 1000;
      const y1 = yBot + c + dm / 2, y2 = y1 + dm / 2 + dv / 2, yT = sl.top - c - db / 2;
      const bars = [], top = [], verd = [];
      for (let a = slabExt.a0 + c; a < slabExt.a1 - c; a += ontwerp.hoofd.s / 1000) for (const [t0, t1] of clipSeg('s', a, slabExt.s0 + c, slabExt.s1 - c)) bars.push(tubeGeo([asV(a, t0, y1), asV(a, t1, y1)], dm / 2, { joints: false, radial: 5 }));
      for (let s = slabExt.s0 + c; s < slabExt.s1 - c; s += ontwerp.verdeel.s / 1000) for (const [t0, t1] of clipSeg('a', s, slabExt.a0 + c, slabExt.a1 - c)) verd.push(tubeGeo([asV(t0, s, y2), asV(t1, s, y2)], dv / 2, { joints: false, radial: 5 }));
      const lb = ontwerp.boven.lengte;
      for (let a = slabExt.a0 + c; a < slabExt.a1 - c; a += ontwerp.boven.s / 1000) {
        for (const [s0, s1] of [[slabExt.s0 + c, slabExt.s0 + 0.1 + lb], [slabExt.s1 - 0.1 - lb, slabExt.s1 - c]])
          for (const [t0, t1] of clipSeg('s', a, s0, s1)) top.push(tubeGeo([asV(a, t0, yT), asV(a, t1, yT)], db / 2, { joints: false, radial: 5 }));
      }
      add('wapening', merge(bars), { naam: 'Hoofdwapening onder', info: `Hoofdwapening Ø${ontwerp.hoofd.d}/${ontwerp.hoofd.s} onderaan, langs de overspanning\nAs = ${fmt(ontwerp.hoofd.As, 0)} mm²/m ≥ ${fmt(ontwerp.AsReq, 0)} vereist (EN 1992-1-1)\nDekking cnom = ${ontwerp.cnom} mm (${ontwerp.klasse})` + tag(true), fase: 1 });
      add('wapening', merge(verd), { kleur: 0xff7b72, naam: 'Verdeelwapening', info: `Verdeelwapening Ø${ontwerp.verdeel.d}/${ontwerp.verdeel.s} (≥ 20 %, §9.3.1.1)` + tag(true), fase: 1 });
      add('wapening', merge(top), { kleur: 0xff9f0a, naam: 'Bovenwapening opleggingen', info: `Bovenwapening Ø${ontwerp.boven.d}/${ontwerp.boven.s} over ${fmt(lb)} m aan de opleggingen (§9.3.1.2)` + tag(true), fase: 1 });
      if (vtype === 'predal') {
        const tr = [];
        for (let a = slabExt.a0 + 0.3; a < slabExt.a1 - 0.1; a += 0.6) for (const [t0, t1] of clipSeg('s', a, slabExt.s0 + 0.05, slabExt.s1 - 0.05)) {
          const ht = ontwerp.tralie.h / 1000, yb = yBot + 0.03, pts = [];
          for (let s = t0, up = false; s <= t1 + 1e-6; s += 0.1, up = !up) pts.push(asV(a, s, up ? yb + ht : yb));
          tr.push(tubeGeo(pts, 0.0025, { joints: false, radial: 4 }), tubeGeo([asV(a, t0, yb + ht), asV(a, t1, yb + ht)], 0.004, { joints: false, radial: 4 }));
        }
        add('wapening', merge(tr), { kleur: 0xffb340, naam: 'Tralieliggers', info: 'Tralieliggers h.o.h. 600 mm (predal)' + tag(true), fase: 1 });
      }
      if (sch) {
        const tb = [], yy = y2 + 0.012;
        for (const s of [sch.s0 - 0.05, sch.s1 + 0.05]) tb.push(tubeGeo([asV(sch.a0 - 0.5, s, yy), asV(sch.a1 + 0.5, s, yy)], 0.006, { joints: false }));
        for (const a of [sch.a0 - 0.05, sch.a1 + 0.05]) tb.push(tubeGeo([asV(a, sch.s0 - 0.5, yy + 0.012), asV(a, sch.s1 + 0.5, yy + 0.012)], 0.006, { joints: false }));
        add('wapening', merge(tb), { kleur: 0xff6b5e, naam: 'Extra wapening rond sparing', info: '2 × Ø12 rond de schachtsparing (praktijk, compenseert onderbroken staven)' + tag(true), fase: 1 });
      }
      if (sl.lvl === 'boven') label('wapening', `${VLOERTYPES[vtype]} h=${ontwerp.h} · Ø${ontwerp.hoofd.d}/${ontwerp.hoofd.s} onder`, asV((aMin + aMax) / 2, (sMin + sMax) / 2, H - 0.05), 1, { kern: true });
    }
  }

  // ---------- Vloeropbouw ----------
  const fl = (y0, y1, naam, kleur, op, info) => add('afwerking', merge([boxFromPoly(poly, y0, y1)]), { kleur, opacity: op, naam, info: info + tag(true), fase: 4 });
  if (ST) fl(-FB, -FB + vo.isolatie, `Isolatie / uitvullaag ${Math.round(vo.isolatie * 1000)} mm`, 0xfff07a, 0.06, 'Uitvullaag/isolatie: hierin lopen leidingen (elektriciteit, water) in de vloer.');
  if (ST) fl(-vo.afwerking - vo.chape, -vo.afwerking, `Chape ${Math.round(vo.chape * 1000)} mm`, 0xb0a48a, 0.06, 'Dekvloer (chape) met de vloerverwarmingsbuizen.');

  // ---------- Wanden tekenen ----------
  const wallRebar = [];
  for (const W of (ST ? walls : [])) {
    const T = WANDTYPES[W.type];
    let w0 = 0;
    const vBot = -FB, vTop = H + 0.01;
    for (const [lnaam, d, kleur] of T.lagen) {
      if (kleur === 0x000000) { w0 += d; continue; }
      const pieces = wallPieces(W, vBot, vTop);
      const geos = pieces.map(([u0, u1, v0, v1]) => boxGeo(wpt(W, (u0 + u1) / 2, (v0 + v1) / 2, w0 + d / 2), V3(u1 - u0, v1 - v0, d), W.rotY));
      add('structuur', merge(geos), { kleur, opacity: lnaam === 'Pleister' ? 0.05 : 0.13, naam: `${T.naam}: ${lnaam}`, info: `${T.naam}\nLaag: ${lnaam}\n${T.info}` + tag(true), fase: lnaam === 'Pleister' ? 5 : ((W.type === 'drager' || W.type === 'gangDragend') ? 1 : 2), edges: lnaam !== 'Pleister', pickable: lnaam !== 'Pleister' });
      w0 += d;
    }
    // lateien boven openingen in metselwerk
    if (W.type !== 'drager' && W.type !== 'gangDragend') for (const o of W.openingen) {
      const top = o.borstwering + o.hoogte;
      add('structuur', boxGeo(wpt(W, o.u, top + 0.1, 0.01 + 0.07), V3(o.breedte + 0.3, 0.2, 0.14), W.rotY), { kleur: 0x6ea8ff, opacity: 0.3, naam: 'Latei', info: 'Latei boven opening, oplegging ≥ 150 mm aan elke zijde (EC6, fabrikant)' + tag(true), fase: 2, edges: true });
    }
    // wapening in betonwanden (EN 1992-1-1 §9.6)
    if (W.type === 'drager' || W.type === 'gangDragend') {
      const t = 0.19, c = 0.025, ws = [0.01 + c + 0.004, 0.01 + t - c - 0.004];
      for (const w of ws) {
        for (let u = 0.1; u < W.len - 0.05; u += 0.25) wallRebar.push(tubeGeo([wpt(W, u, vBot + 0.05, w), wpt(W, u, vTop - 0.03, w)], 0.004, { joints: false, radial: 4 }));
        for (let v = vBot + 0.15; v < vTop - 0.05; v += 0.3) wallRebar.push(tubeGeo([wpt(W, 0.05, v, w + (w < 0.1 ? 0.008 : -0.008)), wpt(W, W.len - 0.05, v, w + (w < 0.1 ? 0.008 : -0.008))], 0.004, { joints: false, radial: 4 }));
      }
    }
    if (W.type === 'buiten') {
      // spouwankers ≈ 5/m²
      const anc = [];
      for (let u = 0.3; u < W.len - 0.2; u += 0.45) for (let v = 0.2; v < H; v += 0.45) {
        if (W.openingen.some(o => u > o.u0 - 0.1 && u < o.u1 + 0.1 && v > o.borstwering - 0.1 && v < o.borstwering + o.hoogte + 0.1)) continue;
        anc.push(tubeGeo([wpt(W, u, v, 0.11), wpt(W, u, v, 0.33)], 0.002, { joints: false, radial: 4 }));
      }
      add('wapening', merge(anc), { kleur: 0xbfbfbf, naam: 'Spouwankers', info: 'Spouwankers RVS ≈ 5/m² (EC6 / NBN EN 845-1, praktijk)' + tag(true), fase: 2 });
    }
    // openingen zelf
    for (const o of W.openingen) {
      const isDeur = o.type === 'deur';
      add(isDeur ? 'brand' : 'structuur', boxGeo(wpt(W, o.u, o.borstwering + o.hoogte / 2, isDeur ? 0.08 : 0.02), V3(o.breedte, o.hoogte, 0.04), W.rotY),
        { kleur: isDeur ? 0xff2d55 : 0x9be7ff, opacity: 0.08, naam: isDeur ? 'Deur' : 'Raam', edges: true, fase: 5,
          info: isDeur ? `Deur ${fmt(o.breedte)} × ${fmt(o.hoogte)} m naar de gang (evacuatieweg).\n${brandTekst(p)}` + tag(!o.bevestigd)
            : `Raam ${fmt(o.breedte)} × ${fmt(o.hoogte)} m, borstwering ${fmt(o.borstwering)} m` + tag(!o.bevestigd) });
    }
    if (W === longest0) label('structuur', `${T.naam}`, wpt(W, W.len / 2, H - 0.35, -0.02), 2);
  }
  add('wapening', merge(wallRebar), { kleur: 0xff6b5e, opacity: 0.55, naam: 'Wapening betonwand', info: 'Wandwapening Ø8/250 verticaal, Ø8/300 horizontaal, beide zijden\nAs,v ≥ 0,002·Ac en ≤ 0,04·Ac; As,h ≥ 25 % As,v of 0,001·Ac (EN 1992-1-1 §9.6)' + tag(true), fase: 1 });
  if (ST) for (const W of walls) if (W !== longest0 && W.type !== 'drager' && W.type !== 'buiten') label('structuur', WANDTYPES[W.type].naam, wpt(W, W.len / 2, H - 0.35, -0.02), 2);

  // ---------- Kolommen en balken (gezien op foto) ----------
  for (const k of R.objecten.filter(o => o.type === 'kolom')) {
    const b = k.breedte ?? 0.15;
    add('structuur', boxGeo(V3(k.x, (H - FB) / 2, k.z), V3(b, H + FB, b)), { kleur: 0x9fc5ff, opacity: 0.35, naam: 'Kolom', edges: true, fase: 1,
      info: (k.materiaal === 'staal' ? `Stalen kolom tegen de gevel (bevestigd door bewoner), wit geschilderd.\nEN 1993 (EC3). In een middelhoog gebouw vraagt de draagstructuur brandweerstand (KB Basisnormen) → vermoedelijk brandwerende verf of bekleding (aanname).`
        : `Kolom aan de gevel (gezien op foto, wit bekleed).\nVermoedelijk staal of beton (aanname).`) + `\nDraagt samen met de gevelbalk de welfsels aan gevelzijde (aanname).` + tag(!k.bevestigd) });
  }
  for (const bk of R.objecten.filter(o => o.type === 'balk')) {
    const n = nearestWall(bk.x, bk.z), hB = bk.hoogte ?? 0.15, dB = bk.diepte ?? 0.2;
    add('structuur', boxGeo(wpt(n.W, n.W.len / 2, H - hB / 2 + 0.01, -dB / 2 + 0.05), V3(n.W.len + 0.3, hB, dB), n.W.rotY), { kleur: 0x9fc5ff, opacity: 0.3, naam: 'Gevelbalk', edges: true, fase: 1,
      info: `${bk.materiaal === 'staal' ? 'Stalen balk' : 'Balk'} langs de gevel onder het plafond (gezien op foto), rust op de kolom(men).\nVermoedelijk oplegging van de welfsels aan gevelzijde (EC3, aanname).` + tag(!bk.bevestigd) });
  }

  // ---------- Schacht ----------
  if (schacht) {
    const x0 = Math.min(schacht.x0, schacht.x1), x1 = Math.max(schacht.x0, schacht.x1), z0 = Math.min(schacht.z0, schacht.z1), z1 = Math.max(schacht.z0, schacht.z1);
    add('structuur', boxGeo(V3((x0 + x1) / 2, (H - FB) / 2, (z0 + z1) / 2), V3(x1 - x0, H + FB, z1 - z0)), { kleur: 0x9aa7b8, opacity: 0.1, naam: 'Technische schacht', edges: true, fase: 2,
      info: 'Technische schacht (zie brandplan: vak met kruis).\nBevat afvoer, water en ventilatie; wanden brandwerend, doorvoeringen brandwerend afdichten.' + tag(!schacht.bevestigd) });
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, yb = -FB - hS - 0.5, yt = H + hS + 0.6;
    schacht.stack = {
      afvoer: V3(cx - (x1 - x0) * 0.2, 0, cz), koud: V3(cx + (x1 - x0) * 0.15, 0, cz - (z1 - z0) * 0.2), warm: V3(cx + (x1 - x0) * 0.3, 0, cz - (z1 - z0) * 0.2),
      vent: V3(cx + (x1 - x0) * 0.2, 0, cz + (z1 - z0) * 0.22), vv: V3(cx - (x1 - x0) * 0.3, 0, cz + (z1 - z0) * 0.25),
    };
    const st = schacht.stack, vert = (p, r, laag, naam, info, dash = 0.08) => {
      const pts = [V3(p.x, yb, p.z), V3(p.x, yt, p.z)];
      add(laag, tubeGeo(pts, r, { dash, gap: 0.04 }), { naam, info: info + tag(true), fase: 3 }); leidingen.push({ pts, laag, naam });
    };
    vert(st.afvoer, 0.055, 'afvoer', 'Standleiding afvoer DN110', 'Standleiding afvoer DN 110 (EN 12056-2), met primaire ventilatie tot boven het dak');
    vert(st.koud, 0.014, 'water', 'Stijgleiding koud water', 'Stijgleiding koud water (aanname DN 25)');
    vert(st.warm, 0.014, 'water', 'Stijgleiding warm water', 'Stijgleiding warm water + circulatie (aanname)');
    add('water', tubeGeo([V3(st.warm.x, yb, st.warm.z), V3(st.warm.x, yt, st.warm.z)], 0.016, { dash: 0.08, gap: 0.04 }), { kleur: 0xff5fa2, naam: 'Warm water', info: 'Warm water' + tag(true), fase: 3 });
    vert(st.vent, 0.0625, 'ventilatie', 'Ventilatiekanaal Ø125', 'Afvoerkanaal ventilatie Ø125 (systeem C, NBN D 50-001)');
  }

  // ---------- Elektriciteit (AREI) ----------
  const objs = R.objecten;
  const lavabo = objs.find(o => o.type === 'lavabo');
  const deur = deuren[0] || { W: walls[0], u: Math.min(1, walls[0].len / 2), breedte: 0.9, u0: walls[0].len / 2 - 0.45, u1: walls[0].len / 2 + 0.45 };
  const yFloorRun = -vo.afwerking - vo.chape - vo.isolatie / 2;
  const outset = insetPoly(poly, -0.025), inset = insetPoly(poly, 0.15);
  const P = polyPerimeter(poly);
  const sOf = (x, z) => perimParam(poly, x, z);
  // verboden zones op de omtrek
  const forb = [];
  for (const W of walls) for (const o of W.openingen) {
    const pa = wpt(W, o.u0), pb = wpt(W, o.u1);
    if (o.type === 'deur' || o.borstwering < 0.4) forb.push([sOf(pa.x, pa.z) - 0.15, sOf(pb.x, pb.z) + 0.15]);
  }
  let cum = 0; const cumW = walls.map(W => { const c = cum; cum += W.len; return c; });
  for (let i = 0; i < walls.length; i++) forb.push([cumW[i] - 0.25, cumW[i] + 0.25]);
  forb.push([P - 0.25, P + 0.25]);
  if (schacht) {
    for (const W of walls) {
      const us = [];
      for (let u = 0; u <= W.len; u += 0.05) { const p = wpt(W, u, 0, -0.02); if (inSchacht(p.x, p.z, 0.05)) us.push(u); }
      if (us.length) forb.push([cumW[W.i] + Math.min(...us) - 0.2, cumW[W.i] + Math.max(...us) + 0.2]);
    }
  }
  let lavS = null, lavW = null;
  if (lavabo) { const n = nearestWall(lavabo.x, lavabo.z); lavW = n; lavS = cumW[n.W.i] + n.u; forb.push([lavS - 0.6, lavS + 0.6]); }
  for (const rd of objs.filter(o => o.type === 'radiator')) { const n = nearestWall(rd.x, rd.z); const sr = cumW[n.W.i] + n.u; forb.push([sr - 0.65, sr + 0.65]); }
  const isForb = s => { const ss = ((s % P) + P) % P; return forb.some(([a, b]) => (ss > a && ss < b) || (ss + P > a && ss + P < b)); };
  const wallAtS = s => { const pp = pointAtPerim(poly, s); return { W: walls[pp.edge], u: pp.u, x: pp.x, z: pp.z }; };

  // voeding vanuit de gang
  const dW = deur.W;
  let uFeed = deur.u0 > 0.5 ? deur.u0 - 0.3 : deur.u1 + 0.3;
  if (schacht) { const pf = wpt(dW, uFeed, 0, -0.05); if (inSchacht(pf.x, pf.z, 0.15)) uFeed = deur.u0 > 0.5 && uFeed > deur.u1 ? deur.u0 - 0.3 : deur.u1 + 0.3; }
  const feedS = cumW[dW.i] + uFeed;
  // schakelaar
  const alleSchak = objs.filter(o => o.type === 'schakelaar');
  let schak = alleSchak.filter(o => o.voor !== 'wandlamp');
  if (!schak.length) {
    const left = deur.u0, right = dW.len - deur.u1;
    let uS = right >= left ? deur.u1 + 0.15 : deur.u0 - 0.15;
    if (schacht) { const p = wpt(dW, uS); if (inSchacht(p.x, p.z, 0.1)) uS = right >= left ? deur.u0 - 0.15 : deur.u1 + 0.15; }
    const p = wpt(dW, uS, g.hSchakelaar);
    schak = [{ type: 'schakelaar', x: p.x, y: g.hSchakelaar, z: p.z, gen: true }];
  }
  // lichtpunt
  let licht = objs.filter(o => o.type === 'lichtpunt');
  const [cxR, czR] = polyCentroid(poly);
  if (!licht.length) licht = [{ type: 'lichtpunt', x: cxR, z: czR, gen: true }];
  // stopcontacten
  let stc = objs.filter(o => o.type === 'stopcontact');
  const bestaand = stc.length;
  const genStc = !g.stopcontactenVolledig;
  if (genStc) {
    const n = Math.max(4, Math.round(P / 3.5));
    for (let k = 0; k < n; k++) {
      let s = feedS + (k + 0.5) * P / n, ok = !isForb(s);
      for (let d = 0.05; !ok && d < 1.2; d += 0.05) { if (!isForb(s + d)) { s += d; ok = true; } else if (!isForb(s - d)) { s -= d; ok = true; } }
      if (!ok) continue;
      const ws = wallAtS(s);
      if (stc.some(o => !o.gen && Math.hypot(o.x - ws.x, o.z - ws.z) < 1.0)) continue;
      stc.push({ type: 'stopcontact', x: ws.x, z: ws.z, y: g.hStopcontact, gen: true, dubbel: ws.W.type === 'buiten' || k === 0 });
    }
    if (lavabo && lavW && !stc.some(o => !o.gen && Math.hypot(o.x - lavabo.x, o.z - lavabo.z) < 1.0)) {
      const W = lavW.W; let u = lavW.u + 0.65; if (u > W.len - 0.3 || (schacht && inSchacht(wpt(W, u).x, wpt(W, u).z, 0.1))) u = lavW.u - 0.65;
      const p = wpt(W, u); stc.push({ type: 'stopcontact', x: p.x, z: p.z, y: 1.1, gen: true, bijLavabo: true });
    }
  }
  const elekGeos = { l: [], s: [] };
  const elPath = (pts, soort, naam, info, aanname) => {
    const laag = soort === 'brand' ? 'brand' : 'elektriciteit';
    const kleur = soort === 'l' ? 0xffd400 : soort === 's' ? 0x3ddc84 : 0xff2d55;
    add(laag, tubeGeo(pts, 0.008, aanname ? { dash: 0.07, gap: 0.04 } : {}), { kleur, naam, info: info + tag(aanname), fase: 3 });
    leidingen.push({ pts, laag, naam });
  };
  void elekGeos;
  const floorRunPts = (s0, s1) => pathAlongPerim(inset, sInset(s0), sInset(s1)).map(([x, z]) => V3(x, yFloorRun, z));
  function sInset(s) { const p = pointAtPerim(poly, s); return perimParam(inset, p.x, p.z); }
  const toWallFromFloor = (s, yTop) => {
    const ws = wallAtS(s), pin = pointAtPerim(inset, sInset(s));
    const pw = wpt(ws.W, ws.u, yFloorRun, 0.025);
    return [V3(pin.x, yFloorRun, pin.z), pw, wpt(ws.W, ws.u, yTop, 0.025)];
  };
  // invoer
  const feedPts = [wpt(dW, uFeed, yFloorRun, 0.3), ...toWallFromFloor(feedS, yFloorRun).slice(0, 1).reverse()];
  void feedPts;
  // stopcontacten: doorgelust in de vloer, in één richting rond
  const stS = stc.map(o => { let s = sOf(o.x, o.z) - feedS; s = ((s % P) + P) % P; return { o, s }; }).sort((a, b) => a.s - b.s);
  if (stS.length) {
    const last = stS[stS.length - 1].s;
    const main = [wpt(dW, uFeed, yFloorRun, 0.25), ...floorRunPts(feedS, feedS + last)];
    elPath(main, 's', 'Kring stopcontacten', `Kring stopcontacten: 3G2,5 mm², automaat 20 A, ${stc.length} stopcontacten (AREI: max. 8 per kring)\nDoorgelust via de uitvullaag van de vloer.`, genStc);
    for (const { o, s } of stS) {
      const pts = toWallFromFloor(feedS + s, o.y ?? g.hStopcontact);
      elPath(pts, 's', 'Stopcontact-aftakking', 'Verticale leiding naar het stopcontact\n(AREI: leidingen in wanden enkel verticaal of horizontaal)', !!o.gen);
    }
  }
  // verlichting: schakelaar -> plafond -> lichtpunt
  {
    const sw = schak[0], sws = sOf(sw.x, sw.z), ws = wallAtS(sws);
    const yZone = H - 0.15;
    const p1 = [wpt(dW, uFeed, yFloorRun, 0.25), wpt(dW, uFeed, yFloorRun, 0.025)];
    const p2 = [wpt(ws.W, ws.u, yFloorRun, 0.025), wpt(ws.W, ws.u, sw.y ?? g.hSchakelaar, 0.025), wpt(ws.W, ws.u, yZone, 0.025)];
    const L0 = licht[0];
    let ceil;
    if (vtype === 'welfsels' && coreAs.length) {
      // via kanaal van welfsel: kabel horizontaal in plafondzone tot dragende wand, dan door kanaal
      const [la, ls] = toAS(L0.x, L0.z);
      const ac = coreAs.reduce((m, a) => Math.abs(a - la) < Math.abs(m - la) ? a : m, coreAs[0]);
      // dichtstbijzijnde dragende wand (s-min of s-max)
      const sWall = Math.abs(ls - sMin) < Math.abs(ls - sMax) ? sMin : sMax;
      const yCore = H + 0.01 + hS / 2;
      const [wx, wz] = fromAS(ac, sWall);
      const sTo = sOf(wx, wz);
      // pad langs omtrek op plafondzone van schakelaar tot dragende wand
      const d1 = ((sTo - sws) % P + P) % P, d2 = P - d1;
      const along = (d1 <= d2 ? pathAlongPerim(outset, perimParam(outset, ...xz(wpt(ws.W, ws.u, 0, 0.025))), perimParam(outset, wx, wz))
        : pathAlongPerim(outset, perimParam(outset, wx, wz), perimParam(outset, ...xz(wpt(ws.W, ws.u, 0, 0.025)))).reverse());
      const zonePts = along.map(([x, z]) => V3(x, yZone, z));
      const [wx2, wz2] = fromAS(ac, sWall + (sWall === sMin ? -0.02 : 0.02));
      ceil = [...zonePts, V3(wx2, yZone, wz2), V3(wx2, yCore, wz2), asV(ac, ls, yCore), V3(L0.x, yCore, L0.z), V3(L0.x, H, L0.z)];
      label('elektriciteit', 'Kabel door kanaal welfsel', asV(ac, (ls + sWall) / 2, H - 0.12), 3);
    } else {
      const yC = H + 0.01 + 0.04;
      const top = wpt(ws.W, ws.u, yC, 0.025);
      ceil = [top, V3(L0.x, yC, top.z), V3(L0.x, yC, L0.z), V3(L0.x, H, L0.z)];
    }
    elPath([...p1, ...(ws.W === dW ? [] : floorRunPts(feedS, sws).slice(1, -1)), ...p2, ...ceil], 'l', 'Kring verlichting', `Kring verlichting: 3G1,5 mm², automaat 16 A (AREI)\nSchakelaar → ${licht.length > 1 ? licht.length + ' plafondlichtpunten' : 'plafondlichtpunt'}.`, !!sw.gen);
    // extra lichtpunten: doorlussen via hetzelfde kanaal / dezelfde zone
    const yL = vtype === 'welfsels' ? H + 0.01 + hS / 2 : H + 0.05;
    for (let i = 1; i < licht.length; i++) {
      const a = licht[i - 1], b = licht[i];
      elPath([V3(a.x, H, a.z), V3(a.x, yL, a.z), V3(b.x, yL, a.z), V3(b.x, yL, b.z), V3(b.x, H, b.z)], 'l', 'Doorlussen lichtpunt', 'Doorlus naar het volgende plafondlichtpunt (zelfde kring, zelfde schakelaar)', !!sw.gen);
    }
  }
  // toestellen (dozen)
  const dev = (o, naam, kleur, info) => {
    if (o.ifc) return; // toestel staat al in het IFC-model
    const n = nearestWall(o.x, o.z);
    const geo = boxGeo(wpt(n.W, n.u, o.y, -0.008), V3(o.dubbel ? 0.15 : 0.08, 0.08, 0.016), n.W.rotY);
    add('elektriciteit', geo, { kleur, opacity: o.gen ? 0.55 : 0.95, naam, info: info + tag(!!o.gen), fase: 5, edges: true });
  };
  for (const o of stc) dev(o, o.dubbel ? 'Dubbel stopcontact' : 'Stopcontact', 0x3ddc84, `${o.dubbel ? 'Dubbel stopcontact' : 'Stopcontact'} met randaarde op ${fmt(o.y ?? g.hStopcontact)} m${o.bijLavabo ? '\nNaast lavabo: ≥ 0,6 m horizontaal van de kraan (praktijk)' : ''}`);
  for (const o of schak) dev(o, 'Schakelaar', 0xffd400, `Schakelaar plafondlicht op ${fmt(o.y ?? g.hSchakelaar)} m naast de deur${o.gen ? ' (aanname)' : ''}`);
  // wandlamp(en) met eigen schakelaar (bv. boven de lavabo)
  for (const wl of objs.filter(o => o.type === 'wandlamp')) {
    const n = nearestWall(wl.x, wl.z);
    if (!wl.ifc) add('elektriciteit', boxGeo(wpt(n.W, n.u, wl.y, -0.04), V3(0.08, 0.12, 0.08), n.W.rotY), { kleur: 0xffd400, opacity: 0.8, naam: 'Wandlamp', info: 'Wandlamp boven de spiegel' + tag(!wl.bevestigd), fase: 5, edges: true });
    const sw = alleSchak.find(o => o.voor === 'wandlamp');
    if (sw) {
      const ns = nearestWall(sw.x, sw.z);
      dev(sw, 'Schakelaar wandlamp', 0xffd400, `Schakelaar wandlamp op ${fmt(sw.y)} m`);
      const pts = [wpt(ns.W, ns.u, H - 0.15, 0.025), wpt(ns.W, ns.u, sw.y, 0.025), wpt(ns.W, ns.u, sw.y, 0.025), wpt(ns.W, ns.u, wl.y, 0.025), wpt(n.W, n.u, wl.y, 0.025)];
      elPath(pts, 'l', 'Leiding wandlamp', 'Schakelaar → wandlamp, voeding vanuit de plafondzone (kring verlichting)', !sw.bevestigd);
    }
  }
  for (const L0 of licht.filter(l => !l.ifc)) {
    const geo = new THREE.CylinderGeometry(0.06, 0.06, 0.02, 16); geo.translate(L0.x, H - 0.01, L0.z);
    add('elektriciteit', geo, { kleur: 0xffd400, opacity: 0.8, naam: 'Lichtpunt', info: 'Plafondlichtpunt' + tag(!!L0.gen), fase: 5 });
  }
  label('elektriciteit', `Stopcontacten op ${fmt(g.hStopcontact)} m · kring 2,5 mm²/20 A`, wpt(stS.length ? wallAtS(feedS + stS[0].s).W : walls[0], (stS.length ? wallAtS(feedS + stS[0].s).u : 0.5), (g.hStopcontact) + 0.2, -0.03), 5, { kern: true });

  // ---------- Water + afvoer (lavabo, EN 12056-2) ----------
  if (lavabo) {
    const { W, u } = lavW;
    const geo = boxGeo(wpt(W, u, 0.83, -0.2), V3(0.5, 0.15, 0.4), W.rotY);
    if (!lavabo.ifc) add('water', geo, { kleur: 0xe8f4ff, opacity: 0.35, naam: 'Lavabo', info: 'Lavabo (ingemeten positie)' + tag(!lavabo.bevestigd), fase: 5, edges: true });
    // schacht-ingang op dezelfde wand?
    let uEnt = null;
    if (schacht) { for (let uu = 0; uu <= W.len; uu += 0.02) { const p = wpt(W, uu, 0, -0.03); if (inSchacht(p.x, p.z, 0.02)) { if (uEnt === null || Math.abs(uu - u) < Math.abs(uEnt - u)) uEnt = uu; } } }
    const lines = [['koud', 0.55, -0.08, 0x29b6f6, 'Koud water', 'Koudwaterleiding PE-X/meerlagen 16 mm naar hoekkraan'], ['warm', 0.62, 0.08, 0xff5fa2, 'Warm water', 'Warmwaterleiding 16 mm naar hoekkraan']];
    for (const [k, y, du, kleur, naam, info] of lines) {
      let pts;
      if (uEnt !== null) {
        const st = schacht.stack[k];
        pts = [wpt(W, u + du, y, -0.02), wpt(W, u + du, y, 0.04), wpt(W, uEnt, y, 0.04), V3(st.x, y, st.z)];
      } else pts = [wpt(W, u + du, y, -0.02), wpt(W, u + du, y, 0.04), wpt(W, u + du, yFloorRun, 0.04)];
      add('water', tubeGeo(pts, 0.009, { dash: 0.06, gap: 0.035 }), { kleur, naam, info: info + tag(true), fase: 3 }); leidingen.push({ pts, laag: 'water', naam });
    }
    {
      let pts; const y0 = 0.45;
      if (uEnt !== null) {
        const st = schacht.stack.afvoer, d1 = Math.abs(uEnt - u), y1 = y0 - 0.02 * d1, d2 = Math.hypot(st.x - wpt(W, uEnt).x, st.z - wpt(W, uEnt).z);
        pts = [wpt(W, u, y0, -0.12), wpt(W, u, y0, 0.05), wpt(W, uEnt, y1, 0.05), V3(st.x, y1 - 0.02 * d2, st.z)];
      } else pts = [wpt(W, u, y0, -0.12), wpt(W, u, y0, 0.05), wpt(W, u, yFloorRun, 0.05)];
      add('afvoer', tubeGeo(pts, 0.02, { dash: 0.07, gap: 0.035 }), { naam: 'Afvoer lavabo DN40', info: 'Afvoer lavabo DN 40 met sifon, helling 2 % naar de schacht\n(EN 12056-2: wastafel DU 0,5 l/s, min. DN 40, helling ≥ 1 %)' + tag(true), fase: 3 });
      leidingen.push({ pts, laag: 'afvoer', naam: 'Afvoer lavabo' });
      label('afvoer', 'Afvoer DN40 · 2 % → schacht', pts[2].clone().add(V3(0, 0.12, 0)), 3, { kern: true });
    }
  }

  // ---------- Verwarming ----------
  if (g.verwarming === 'vloer') {
    const yV = -vo.afwerking - vo.chape + 0.012;
    const ins = insetPoly(poly, 0.15).map(([x, z]) => toAS(x, z));
    const sLo = Math.min(...ins.map(p => p[1])), sHi = Math.max(...ins.map(p => p[1]));
    const lines = [];
    for (let s = sLo + 0.02; s <= sHi - 0.02; s += 0.15) {
      const xs = [];
      for (let i = 0; i < ins.length; i++) {
        const [a1, s1] = ins[i], [a2, s2] = ins[(i + 1) % ins.length];
        if ((s1 <= s && s2 > s) || (s2 <= s && s1 > s)) xs.push(a1 + (s - s1) / (s2 - s1) * (a2 - a1));
      }
      if (xs.length < 2) continue;
      let a0 = Math.min(...xs), a1 = Math.max(...xs);
      if (sch && s > sch.s0 - 0.12 && s < sch.s1 + 0.12) { if (sch.a0 - aMin < aMax - sch.a1) a0 = Math.max(a0, sch.a1 + 0.12); else a1 = Math.min(a1, sch.a0 - 0.12); }
      if (a1 - a0 > 0.3) lines.push([s, a0, a1]);
    }
    const pts = [];
    lines.forEach(([s, a0, a1], i) => { const [p, q] = i % 2 ? [a1, a0] : [a0, a1]; pts.push(asV(p, s, yV), asV(q, s, yV)); });
    if (pts.length) {
      let full = pts;
      if (schacht) { const st = schacht.stack.vv; full = [V3(st.x, yV, st.z), ...pts, V3(st.x + 0.05, yV, st.z + 0.05)]; }
      else {
        // verdeler (collector) in een kastje naast de deur
        const uV = deur.u0 > 0.7 ? deur.u0 - 0.45 : Math.min(dW.len - 0.3, deur.u1 + 0.45);
        const pv = wpt(dW, uV, yV, -0.08), pv2 = wpt(dW, uV + 0.06, yV, -0.08);
        full = [wpt(dW, uV, 0.35, -0.06), pv, ...pts, pv2, wpt(dW, uV + 0.06, 0.35, -0.06)];
        add('verwarming', boxGeo(wpt(dW, uV + 0.03, 0.45, -0.06), V3(0.45, 0.35, 0.1), dW.rotY), { opacity: 0.45, naam: 'Verdeler vloerverwarming', info: 'Verdeler/collector met aanvoer en retour per kring (aanname: naast de deur, in een inbouwkast)' + tag(true), fase: 4, edges: true });
      }
      add('verwarming', tubeGeo(full, 0.008, { dash: 0.25, gap: 0.08 }), { naam: 'Vloerverwarming', info: 'Vloerverwarming PE-Xa 16×2 mm in de chape, h.o.h. 150 mm\nLage temperatuur (warmtepomp/geothermie, volgens Upkot) — legpatroon aanname\nNiet boren of nagelen in de vloer!' + tag(true), fase: 4 });
      leidingen.push({ pts: full, laag: 'verwarming', naam: 'Vloerverwarming' });
      label('verwarming', 'Vloerverwarming h.o.h. 150 mm', asV((aMin + aMax) / 2, (sLo + sHi) / 2, 0.08), 4, { kern: true });
    }
  }
  for (const rad of objs.filter(o => o.type === 'radiator')) {
    const n = nearestWall(rad.x, rad.z);
    if (!rad.ifc) add('verwarming', boxGeo(wpt(n.W, n.u, 0.4, -0.06), V3(0.9, 0.6, 0.08), n.W.rotY), { opacity: 0.4, naam: 'Radiator', info: 'Radiator' + tag(!rad.bevestigd), fase: 5, edges: true });
    const pts = [wpt(n.W, n.u - 0.4, 0.12, -0.04), wpt(n.W, n.u - 0.4, yFloorRun, -0.04)];
    add('verwarming', tubeGeo(pts, 0.008, { dash: 0.06, gap: 0.03 }), { naam: 'Aansluiting radiator', info: 'Aanvoer/retour radiator via de vloer' + tag(true), fase: 3 }); leidingen.push({ pts, laag: 'verwarming', naam: 'Radiator' });
  }

  // ---------- Ventilatie (systeem C, NBN D 50-001) ----------
  if (g.ventilatie === 'C' || g.ventilatie === 'D') {
    if (g.ventilatie === 'C') for (const W of walls) for (const o of W.openingen.filter(o => o.type === 'raam')) {
      add('ventilatie', boxGeo(wpt(W, o.u, o.borstwering + o.hoogte + 0.03, 0.02), V3(o.breedte * 0.8, 0.05, 0.06), W.rotY), { opacity: 0.5, naam: 'Raamrooster', info: 'Toevoer via regelbaar raamrooster (systeem C, NBN D 50-001)' + tag(true), fase: 5, edges: true });
    }
    const ventielen = objs.filter(o => o.type === 'ventiel');
    for (const v of ventielen) {
      const n = nearestWall(v.x, v.z);
      const geo = new THREE.CylinderGeometry(0.075, 0.075, 0.03, 20); geo.rotateX(Math.PI / 2); geo.rotateY(n.W.rotY); const p = wpt(n.W, n.u, v.y, -0.015); geo.translate(p.x, p.y, p.z);
      if (!v.ifc) add('ventilatie', geo, { opacity: 0.85, naam: 'Afzuigventiel', info: 'Afzuigventiel (gezien op foto), aangesloten op het afvoerkanaal in de schacht (systeem C/D, NBN D 50-001)' + tag(!v.bevestigd), fase: 5 });
      if (schacht) { const st = schacht.stack.vent; const pts = [wpt(n.W, n.u, v.y, 0.0), wpt(n.W, n.u, v.y, 0.08), V3(st.x, v.y, st.z)]; add('ventilatie', tubeGeo(pts, 0.05, { dash: 0.1, gap: 0.05 }), { naam: 'Aansluiting ventiel', info: 'Ventilatiekanaal Ø100 naar de schacht' + tag(true), fase: 3 }); }
    }
    if (schacht && !ventielen.length) {
      const st = schacht.stack.vent;
      add('ventilatie', boxGeo(V3(st.x, H - 0.2, st.z), V3(0.2, 0.12, 0.2)), { opacity: 0.4, naam: 'Afvoerrooster', info: 'Mechanische afvoer bij de schacht/lavabo (systeem C)' + tag(true), fase: 5, edges: true });
    }
  }

  // ---------- Brand ----------
  {
    const dp = wpt(dW, deur.u, 0, 0);
    const rm = objs.find(o => o.type === 'rookmelder');
    const rx = rm ? rm.x : cxR + (dp.x - cxR) * 0.35, rz = rm ? rm.z : czR + (dp.z - czR) * 0.35;
    const geo = new THREE.CylinderGeometry(0.05, 0.05, 0.04, 16); geo.translate(rx, H - 0.02, rz);
    if (!rm?.ifc) add('brand', geo, { opacity: 0.85, naam: 'Rookmelder', info: 'Optische rookmelder op het plafond, ≥ 0,3 m van wanden.\nIn dit gebouw vermoedelijk gekoppeld aan de centrale branddetectie (brandplan: handmelders in de gang).' + tag(!rm?.bevestigd), fase: 5 });
    const pts = [wpt(dW, deur.u, H - 0.1, 0.4), wpt(dW, deur.u, H - 0.1, 0.025), V3(rx, H - 0.1, rz), V3(rx, H - 0.04, rz)];
    elPath(pts, 'brand', 'Bus branddetectie', 'Buskabel branddetectie (centrale in het gebouw)', true);
    label('brand', 'Evacuatie → gang (zie brandplan)', wpt(dW, deur.u, 2.25, -0.05), 5, { kern: true });
  }

  if (ST) rapport.push('— WANDEN —', ...walls.map(W => `Wand ${W.i + 1} (${fmt(W.len)} m): ${WANDTYPES[W.type].naam} — ${WANDTYPES[W.type].lagen.map(l => `${l[0]}`).join(' / ')}`));
  rapport.push('— ELEKTRICITEIT (AREI) —', `Stopcontacten: ${stc.length} op 1 kring (2,5 mm², 20 A; max. 8) — ${bestaand} gezien/ingemeten, ${stc.length - bestaand} aangenomen op ${fmt(g.hStopcontact)} m`, `Verlichting: 1,5 mm², 16 A; schakelaar op ${fmt(g.hSchakelaar)} m`, 'Leidingen enkel verticaal/horizontaal; horizontale zones aangenomen in vloer en 15 cm onder plafond');
  if (lavabo) rapport.push('— SANITAIR (EN 12056-2) —', 'Afvoer lavabo DN 40, helling 2 %, aansluiting op standleiding DN 110 in de schacht', 'Koud/warm 16 mm naar hoekkranen op 0,55 / 0,62 m');
  if (objs.some(o => o.type === 'radiator')) rapport.push('— VERWARMING —', 'Radiator(en) gezien op foto; aanvoer/retour via de vloer of wand (aanname)');
  if (g.verwarming === 'vloer') rapport.push('— VERWARMING —', 'Vloerverwarming 16 mm h.o.h. 150 mm in chape (aanname o.b.v. warmtepomp)');
  rapport.push('— BRAND —', brandTekst(p).replace(/\n/g, ' ') + ' Rookmelder (aanname).');

  return { group: out, picks, leidingen, rapport, walls, ontwerp };

  // ---- hulpfuncties die walls/poly nodig hebben ----
  function wallPieces(W, vBot, vTop) {
    const ops = [...W.openingen].sort((a, b) => a.u0 - b.u0);
    const res = []; let u = -0.0;
    for (const o of ops) {
      if (o.u0 > u + 0.01) res.push([u, o.u0, vBot, vTop]);
      if (o.borstwering > 0.01) res.push([o.u0, o.u1, vBot, o.borstwering]);
      const top = o.borstwering + o.hoogte; if (top < vTop - 0.01) res.push([o.u0, o.u1, top, vTop]);
      u = Math.max(u, o.u1);
    }
    if (u < W.len - 0.01) res.push([u, W.len, vBot, vTop]);
    return res;
  }
}

function xz(v) { return [v.x, v.z]; }

/** Prisma uit polygoon tussen y0 en y1 */
function boxFromPoly(poly, y0, y1) {
  const shape = new THREE.Shape(poly.map(([x, z]) => new THREE.Vector2(x, z)));
  const g = new THREE.ExtrudeGeometry(shape, { depth: y1 - y0, bevelEnabled: false });
  // shape ligt in XY; draaien zodat Y->Z en extrusie (Z) -> Y
  g.applyMatrix4(new THREE.Matrix4().set(1, 0, 0, 0, 0, 0, 1, y0, 0, 1, 0, 0, 0, 0, 0, 1));
  return g;
}

function brandTekst(p) {
  const h = p.info?.gebouwhoogte || (p.id === 'kot-backstage' ? 'middelhoog' : null);
  const t = { laag: 'Laag gebouw (< 10 m): KB Basisnormen bijlage 2.', middelhoog: 'Middelhoog gebouw (10–25 m): KB Basisnormen bijlage 3.', hoog: 'Hoog gebouw (> 25 m): KB Basisnormen bijlage 4.' }[h] || 'Gebouwhoogte onbekend: KB Basisnormen bijlage 2/3/4 naargelang de hoogte.';
  return t + '\nDeur naar evacuatieweg: in de regel EI1 30, zelfsluitend (te controleren in de bijlage).';
}
