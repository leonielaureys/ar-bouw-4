// ec2.js — voorontwerp van vloeren volgens de Eurocodes
// EN 1990 (combinaties), EN 1991-1-1 (belastingen), EN 1992-1-1 (beton) met Belgische ANB waar relevant,
// EN 1995-1-1 (hout, vuistregel). Dit is een VOORONTWERP om leidingen/wapening plausibel te tonen,
// geen vervanging van een stabiliteitsstudie.

export const BETON = {
  'C20/25': { fck: 20, fctm: 2.2 },
  'C25/30': { fck: 25, fctm: 2.6 },
  'C30/37': { fck: 30, fctm: 2.9 },
  'C35/45': { fck: 35, fctm: 3.2 },
};
const GAMMA_C = 1.5, GAMMA_S = 1.15, ALPHA_CC = 1.0; // ANB België: αcc = 1,0
const RHO_C = 25; // kN/m³ gewapend beton (EN 1991-1-1 tabel A.1)

/** Belastingen voor een woon-/kotvloer (categorie A). */
export function belastingen({ gAfwerking = 1.8, qk = 2.0, scheidingswanden = 0.5 } = {}) {
  // qk = 2,0 kN/m² cat. A vloeren (EN 1991-1-1 tabel 6.2, ANB);
  // + 0,5 kN/m² voor verplaatsbare scheidingswanden ≤ 1,0 kN/m (6.3.1.2(8))
  return { gAfw: gAfwerking, qk: qk + scheidingswanden, qkBasis: qk, qScheid: scheidingswanden };
}

/** Betondekking volgens EN 1992-1-1 §4.4.1 */
export function dekking({ klasse = 'XC1', staaf = 10, constructieklasse = 'S4' } = {}) {
  const tabel = { X0: 10, XC1: 15, XC2: 25, XC3: 25, XC4: 30 }; // cmin,dur voor S4 (tabel 4.4N)
  const cminDur = tabel[klasse] ?? 15;
  const cmin = Math.max(staaf, cminDur, 10);
  const dc = 10; // Δcdev
  return { cmin, cnom: cmin + dc, cminDur, klasse, constructieklasse };
}

const BARS = [8, 10, 12, 14, 16, 20];
const area = d => Math.PI * d * d / 4;

/** Kies staafdiameter + h.o.h. voor een vereiste As [mm²/m]. */
export function kiesWapening(AsReq, smax, voorkeur = [10, 12, 8, 14, 16, 20]) {
  for (const d of voorkeur) {
    let s = Math.floor(Math.min(smax, 1000 * area(d) / AsReq) / 25) * 25;
    if (s >= 125) return { d, s, As: 1000 * area(d) / s };
  }
  for (const d of BARS) {
    let s = Math.floor(Math.min(smax, 1000 * area(d) / AsReq) / 25) * 25;
    if (s >= 100) return { d, s, As: 1000 * area(d) / s };
  }
  return { d: 20, s: 100, As: 1000 * area(20) / 100 };
}

/**
 * Eenrichtingsplaat, vrij opgelegd, ter plaatse gestort.
 * L in m (overspanning hart-op-hart opleggingen).
 */
export function plaatTerPlaatse({ L, beton = 'C25/30', fyk = 500, klasse = 'XC1', K = 1.0, hMin = 120, gAfwerking = 1.8 } = {}) {
  const { fck, fctm } = BETON[beton];
  const fcd = ALPHA_CC * fck / GAMMA_C, fyd = fyk / GAMMA_S;
  const bel = belastingen({ gAfwerking });
  let res = null;
  for (let h = hMin; h <= 450; h += 10) {
    const dk = dekking({ klasse, staaf: 12 });
    const g = RHO_C * h / 1000 + bel.gAfw;
    const qEd = 1.35 * g + 1.5 * bel.qk; // EN 1990 vgl. 6.10
    const MEd = qEd * L * L / 8; // kNm/m
    const dEst = h - dk.cnom - 6;
    const mu = MEd * 1e6 / (1000 * dEst * dEst * fcd);
    if (mu > 0.295) continue; // x/d ≤ 0,45 (EN 1992-1-1 §5.6.3)
    const xi = (0.8 - Math.sqrt(0.64 - 1.28 * mu)) / 0.64;
    const z = Math.min(dEst * (1 - 0.4 * xi), 0.95 * dEst);
    const As = MEd * 1e6 / (z * fyd);
    const AsMin = Math.max(0.26 * fctm / fyk * 1000 * dEst, 0.0013 * 1000 * dEst); // §9.2.1.1 (9.1N)
    const AsReq = Math.max(As, AsMin);
    const smax = Math.min(3 * h, 400); // §9.3.1.1(3) hoofdwapening
    const hw = kiesWapening(AsReq, smax);
    const dk2 = dekking({ klasse, staaf: hw.d });
    const d = h - dk2.cnom - hw.d / 2;
    // doorbuiging via slankheid (§7.4.2, vgl. 7.16)
    const rho = AsReq / (1000 * d), rho0 = Math.sqrt(fck) / 1000;
    let ld = rho <= rho0
      ? K * (11 + 1.5 * Math.sqrt(fck) * rho0 / rho + 3.2 * Math.sqrt(fck) * Math.pow(rho0 / rho - 1, 1.5))
      : K * (11 + 1.5 * Math.sqrt(fck) * rho0 / rho);
    const fac = Math.min(1.5, (500 / fyk) * (hw.As / AsReq)) * (L > 7 ? 7 / L : 1);
    const ldToel = ld * fac;
    const ldAct = L * 1000 / d;
    if (ldAct > ldToel) continue;
    // verdeelwapening ≥ 20 % (§9.3.1.1(2)), smax = min(3,5h; 450)
    const smax2 = Math.min(3.5 * h, 450);
    const vw = kiesWapening(Math.max(0.2 * hw.As, 0.0013 * 1000 * d * 0.5), smax2, [8, 10, 12]);
    // bovenwapening aan opleggingen ≥ 25 % van veldmoment-wapening over 0,2 L (§9.3.1.2(2))
    const bw = kiesWapening(0.25 * hw.As, smax, [8, 10, 12]);
    res = {
      type: 'terplaatse', h, d, L, beton, fck, fcd, fyd, qEd, g, qk: bel.qk, MEd, mu, z, As, AsMin, AsReq,
      hoofd: hw, verdeel: vw, boven: { ...bw, lengte: 0.2 * L }, cnom: dk2.cnom, cminDur: dk2.cminDur, klasse,
      ldAct, ldToel,
    };
    break;
  }
  if (!res) return null;
  res.rapport = [
    `Plaat ter plaatse, vrij opgelegd, L = ${fmt(L)} m, h = ${res.h} mm, ${beton} / B${fyk}`,
    `Belasting (EN 1991-1-1 cat. A): g = ${fmt(res.g)} kN/m² (eigen gewicht + afwerking ${fmt(belastingen({ gAfwerking }).gAfw)}), q = ${fmt(res.qk)} kN/m² (2,0 + 0,5 scheidingswanden)`,
    `Combinatie EN 1990 (6.10): qEd = 1,35·g + 1,5·q = ${fmt(res.qEd)} kN/m²  →  MEd = qEd·L²/8 = ${fmt(res.MEd)} kNm/m`,
    `Dekking §4.4.1: ${klasse}, S4 → cmin,dur = ${res.cminDur} mm, cnom = ${res.cnom} mm; d = ${fmt(res.d, 0)} mm`,
    `μ = ${fmt(res.mu, 3)} ≤ 0,295; z = ${fmt(res.z, 0)} mm; As,nodig = ${fmt(res.As, 0)} mm²/m; As,min (9.1N) = ${fmt(res.AsMin, 0)} mm²/m`,
    `Hoofdwapening onder: Ø${res.hoofd.d}/${res.hoofd.s} (${fmt(res.hoofd.As, 0)} mm²/m), smax = min(3h; 400) = ${Math.min(3 * res.h, 400)} mm`,
    `Verdeelwapening: Ø${res.verdeel.d}/${res.verdeel.s} (≥ 20 % hoofdwapening, §9.3.1.1(2))`,
    `Bovenwapening aan opleggingen: Ø${res.boven.d}/${res.boven.s} over ${fmt(0.2 * L)} m (≥ 25 % veldwapening, §9.3.1.2(2))`,
    `Doorbuiging §7.4.2: l/d = ${fmt(res.ldAct, 1)} ≤ ${fmt(res.ldToel, 1)} ✓`,
  ];
  return res;
}

/** Voorgespannen welfsels (holle-kernplaten, EN 1168 + EN 1992-1-1, ontwerp door fabrikant). */
export function welfsels({ L, akoestischMin = 200 } = {}) {
  const reeks = [150, 200, 265, 320, 400];
  let hSlank = reeks.find(h => L * 1000 / h <= 40) ?? 400; // vuistregel slankheid L/h ≤ 40 (cat. A)
  const h = Math.max(hSlank, akoestischMin);
  const breedte = 1.2;
  const kernen = h <= 150 ? 7 : h <= 200 ? 6 : 5;
  const kernD = h * (h <= 200 ? 0.65 : 0.7) / 1000;
  const druklaag = 50;
  const bel = belastingen({ gAfwerking: 1.8 });
  const g = (h <= 150 ? 2.3 : h <= 200 ? 2.8 : h <= 265 ? 3.6 : 4.2) + RHO_C * druklaag / 1000 + bel.gAfw; // eigen gewicht welfsel volgens typische fabrikantentabellen
  const qEd = 1.35 * g + 1.5 * bel.qk, MEd = qEd * L * L / 8;
  return {
    type: 'welfsels', h, hSlank, L, breedte, kernen, kernD, druklaag, net: { d: 6, s: 150 }, strengen: { d: 9.3, n: kernen + 1 },
    g, qk: bel.qk, qEd, MEd,
    rapport: [
      `Welfsels (voorgespannen holle-kernplaten, EN 1168): L ≈ ${fmt(L)} m`,
      `Dikte: slankheid L/h ≤ 40 → ${hSlank} mm; aanname ${h} mm (massa voor geluidsisolatie tussen kamers)`,
      `Belasting: g ≈ ${fmt(g)} kN/m², q = ${fmt(bel.qk)} kN/m² → qEd = ${fmt(qEd)} kN/m², MEd ≈ ${fmt(MEd)} kNm/m per m breedte`,
      `Wapening = voorspanstrengen onderaan in de ribben (fabrikant, volgens EN 1992-1-1 + EN 1168); te controleren in de fabrikantentabel`,
      `Druklaag ${druklaag} mm met wapeningsnet Ø6/150 (aanname: schijfwerking + scheurbeheersing)`,
      `Sparingen (schacht): raveelijzers vangen de onderbroken welfsels op en dragen af naar de naastliggende platen`,
    ],
  };
}

/** Breedplaatvloer (predal): prefab onderplaat 50 mm met tralieliggers + druklaag; wapening via plaatTerPlaatse. */
export function predal(opts) {
  const p = plaatTerPlaatse({ ...opts, hMin: Math.max(160, opts.hMin || 0) });
  if (!p) return null;
  p.type = 'predal'; p.plaat = 50; p.tralie = { hoh: 0.6, h: Math.max(70, p.h - 50 - 30) };
  p.rapport = [`Breedplaatvloer (predallen): onderplaat 50 mm + ter plaatse gestorte druklaag, totaal h = ${p.h} mm`,
    ...p.rapport.slice(1),
    `Tralieliggers h.o.h. 600 mm (montagestijfheid, fabrikant)`];
  return p;
}

/** Houten balklaag — vuistregel EN 1995-1-1 (geen volledige toetsing). */
export function houtenBalken({ L } = {}) {
  const reeks = [175, 200, 225, 250, 275, 300];
  const h = reeks.find(x => x >= L * 1000 / 18) ?? 300;
  return {
    type: 'hout', h, b: 75, hoh: 0.4, L, klasse: 'C24',
    rapport: [`Houten balklaag C24, 75 × ${h} mm, h.o.h. 400 mm, L ≈ ${fmt(L)} m`,
      `Vuistregel h ≈ L/18; volledige toetsing (EN 1995-1-1: buiging, doorbuiging, trillingen §7.3) nog uit te voeren`],
  };
}

export function fmt(x, n = 2) { return Number(x).toLocaleString('nl-BE', { minimumFractionDigits: n, maximumFractionDigits: n }); }
