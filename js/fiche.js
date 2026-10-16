// fiche.js — projectfiche, volledigheid, plan en foto's voor eigen projecten (en vaste lokalen)
import { VLOERTYPES } from './generator.js';

const VELDEN = [
  { k: 'functie', l: 'Functie van de ruimte', o: [['kot', 'Studentenkamer'], ['woning', 'Woning'], ['klas', 'Klaslokaal'], ['kantoor', 'Kantoor'], ['ander', 'Andere']] },
  { k: 'bouwperiode', l: 'Bouwperiode', o: [['onbekend', 'Weet ik niet'], ['voor1945', 'Voor 1945'], ['1945-1970', '1945–1970'], ['1970-2000', '1970–2000'], ['2000-2015', '2000–2015'], ['na2015', 'Na 2015']],
    h: 'Bepaalt het vloertype als je dat niet kent (oud: houten balken, jaren 60: ter plaatse gestort, recent: welfsels).' },
  { k: 'gebouwhoogte', l: 'Gebouwhoogte', o: [['onbekend', 'Weet ik niet'], ['laag', 'Laag (< 10 m, tot ±3 bouwlagen)'], ['middelhoog', 'Middelhoog (10–25 m)'], ['hoog', 'Hoog (> 25 m)']], h: 'Bepaalt de brandeisen (KB Basisnormen).' },
  { k: 'g.vloer', l: 'Vloertype (plafond boven je)', o: Object.entries(VLOERTYPES),
    h: 'Kijk naar het plafond: rechte naden om ±1,2 m = welfsels · om ±2,4 m = predallen · geen naden = plaat ter plaatse · zichtbare balken = hout.' },
  { k: 'g.draagrichting', l: 'Richting van de plafondnaden', o: [['kort', 'Dwars op de kamer (korte richting)'], ['lang', 'In de lengte van de kamer']],
    h: 'Welfsels en predallen overspannen in de richting van hun naden. In de bril kan je één naad aanwijzen (Rondgang).' },
  { k: 'wandmateriaal', l: 'Wanden', o: [['onbekend', 'Weet ik niet'], ['beton', 'Beton / kalkzandsteen (hard, dof bij kloppen)'], ['metselwerk', 'Metselwerk (baksteen, snelbouw)'], ['clt', 'CLT / massief hout'], ['gips', 'Lichte wanden (klinken hol)']],
    h: 'Klop op de muur: hol = lichte wand (gips/metal stud), dof en hard = beton of kalkzandsteen.' },
  { k: 'g.verwarming', l: 'Verwarming', o: [['radiator', 'Radiatoren'], ['vloer', 'Vloerverwarming'], ['geen', 'Geen / weet ik niet']] },
  { k: 'g.ventilatie', l: 'Ventilatie', o: [['C', 'Roosters in de ramen + afzuiging (systeem C)'], ['D', 'Ventielen voor toe- én afvoer (systeem D)'], ['A', 'Enkel natuurlijk (ramen)']] },
  { k: 'schacht', l: 'Technische schacht of koker in de ruimte', o: [['onbekend', 'Weet ik niet'], ['ja', 'Ja'], ['nee', 'Nee']] },
];
const WATER = [['lavabo', 'Lavabo'], ['keuken', 'Keuken'], ['douche', 'Douche'], ['wc', 'Wc']];

const lees = (d, k) => k.startsWith('g.') ? d.gebouw?.[k.slice(2)] : d.info?.[k];
const zet = (d, k, v) => { if (k.startsWith('g.')) { d.gebouw ||= {}; d.gebouw[k.slice(2)] = v; } else { d.info ||= {}; d.info[k] = v; } };

export function volledigheid(d) {
  if (!d || d.soort !== 'ruimte') return null;
  const R = d.ruimte || {}, ob = R.objecten || [], op = R.openingen || [], i = d.info || {};
  const heeft = (t) => ob.some(o => o.type === t && o.bevestigd);
  const items = [
    ['Vorm en maten ingemeten', d.status === 'ingemeten', 'Bril › Rondgang › stap 1 (ruimte-scan)'],
    ['Deur aangeduid', op.some(o => o.type === 'deur' && o.bevestigd), 'Bril › Rondgang › Deuren'],
    ['Ramen aangeduid', op.some(o => o.type === 'raam' && o.bevestigd), 'Bril › Rondgang › Ramen'],
    ['Bouwperiode', i.bouwperiode && i.bouwperiode !== 'onbekend', 'Projectfiche'],
    ['Vloertype', d.gebouw?.vloer && d.gebouw.vloer !== 'onbekend', 'Projectfiche (kijk naar de plafondnaden)'],
    ['Wandmateriaal', i.wandmateriaal && i.wandmateriaal !== 'onbekend', 'Projectfiche (klopproef)'],
    ['Stopcontacten aangeduid', heeft('stopcontact'), 'Bril › Rondgang › Stopcontacten'],
    ['Schakelaar en lichtpunt', heeft('schakelaar') && heeft('lichtpunt'), 'Bril › Rondgang'],
    ['Verwarming aangeduid', d.gebouw?.verwarming === 'vloer' || heeft('radiator'), 'Bril › Rondgang › Radiatoren'],
    ['Water / schacht', !(i.water || []).length || heeft('lavabo') || ob.some(o => o.type === 'schacht'), 'Bril › Rondgang › Lavabo / Schacht'],
    ['Plan toegevoegd', !!d.plan, 'Plan & foto\'s › Plan toevoegen'],
    ['Foto\'s (minstens 4)', (d.fotosAantal || 0) >= 4, 'Plan & foto\'s › Foto\'s toevoegen'],
  ];
  const ok = items.filter(x => x[1]).length;
  return { items, pct: Math.round(100 * ok / items.length) };
}

export function maakFiche(api) {
  const { S, IDB, $, bewaarData, bouwModel, melding, tekenPlan } = api;
  const box = $('fiche'), media = $('media'), vol = $('volledigheid');

  function teken() {
    const d = S.data;
    if (!d || d.soort !== 'ruimte') { box.innerHTML = '<p class="zacht">De projectfiche is er voor ruimte-projecten (database en eigen projecten). Bij een IFC haalt de app alles uit het model.</p>'; media.innerHTML = ''; vol.innerHTML = ''; return; }
    d.info ||= {};
    // ---- volledigheid ----
    const v = volledigheid(d);
    vol.innerHTML = `<div class="meter"><i style="width:${v.pct}%"></i></div><div class="zacht" style="margin:4px 0 6px">${v.pct}% van wat de app nodig heeft</div>` +
      `<ul class="check">${v.items.map(([l, okk, hoe]) => `<li class="${okk ? 'ok' : ''}"><span>${okk ? '✓' : '○'}</span>${l}${okk ? '' : `<small>${hoe}</small>`}</li>`).join('')}</ul>`;
    // ---- fiche ----
    box.innerHTML = '';
    for (const f of VELDEN) {
      const id = 'f_' + f.k.replace('.', '_');
      const wrap = document.createElement('div'); wrap.className = 'veld';
      wrap.innerHTML = `<label for="${id}">${f.l}</label><select id="${id}">${f.o.map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select>${f.h ? `<small>${f.h}</small>` : ''}`;
      const sel = wrap.querySelector('select');
      const cur = lees(d, f.k); if (cur) sel.value = cur; else if (f.k === 'g.draagrichting') sel.value = 'kort';
      sel.onchange = () => { zet(d, f.k, sel.value); opslaan(); };
      box.appendChild(wrap);
    }
    const w = document.createElement('div'); w.className = 'veld';
    w.innerHTML = `<label>Water in de ruimte</label><div class="rij">${WATER.map(([k, l]) => `<label class="vink" style="margin:0"><input type="checkbox" value="${k}" ${(d.info.water || []).includes(k) ? 'checked' : ''}> ${l}</label>`).join('')}</div>`;
    w.querySelectorAll('input').forEach(c => c.onchange = () => { d.info.water = [...w.querySelectorAll('input:checked')].map(x => x.value); opslaan(); });
    box.appendChild(w);
    const t = document.createElement('div'); t.className = 'veld';
    t.innerHTML = `<label for="f_opm">Opmerkingen (wat zie je, wat weet je?)</label><textarea id="f_opm" rows="3" placeholder="bv. stalen kolom aan het raam, plafondnaden om 1,2 m, radiator onder het raam…"></textarea>`;
    const ta = t.querySelector('textarea'); ta.value = d.info.opmerkingen || ''; ta.onchange = () => { d.info.opmerkingen = ta.value; opslaan(false); };
    box.appendChild(t);
    tekenMedia();
  }
  function opslaan(herbouw = true) { bewaarData(); if (herbouw) bouwModel(); teken(); }

  // ---------- plan en foto's ----------
  async function tekenMedia() {
    const d = S.data, id = S.entry.id;
    const fotos = (await IDB.get('fotos:' + id)) || [];
    d.fotosAantal = fotos.length;
    const p = d.plan;
    media.innerHTML = `
      <div class="rij"><label class="knop">${p ? 'Ander plan' : 'Plan toevoegen'}<input type="file" id="filePlan" accept="image/*" hidden></label>
      <label class="knop">Foto's toevoegen<input type="file" id="fileFoto" accept="image/*" multiple hidden></label></div>
      <p class="zacht" style="margin:6px 0">Plan = grondplan, brandplan of schets (foto of schermafbeelding; een PDF eerst als afbeelding bewaren). Foto's: elke wand, het plafond, toestellen en meters.</p>
      ${p ? `<div class="planset">
        <label>Plan verschuiven X <input type="range" id="plX" min="-15" max="15" step="0.01" value="${p.x}"></label>
        <label>Plan verschuiven Z <input type="range" id="plZ" min="-15" max="15" step="0.01" value="${p.z}"></label>
        <label>Plan draaien <input type="range" id="plR" min="-180" max="180" step="0.5" value="${p.rot}"></label>
        <label>Doorzichtigheid <input type="range" id="plO" min="0.1" max="1" step="0.05" value="${p.op}"></label>
        <div class="rij"><button type="button" id="plSchaal" class="klein">Schaal opnieuw</button><button type="button" id="plWeg" class="klein">Plan verwijderen</button></div>
        <small class="zacht">Schaal: ${(1 / p.schaal).toFixed(0)} px per meter · het plan ligt op de vloer (laag "Plan") en is ook zichtbaar in de bril.</small></div>` : ''}
      <div class="thumbs">${fotos.map((f, i) => `<figure><img src="${f}" alt="Foto ${i + 1}"><button type="button" data-i="${i}" aria-label="Foto verwijderen">✕</button></figure>`).join('')}</div>
      <div id="claudeVak"></div>`;
    $('filePlan').onchange = async (e) => { const f = e.target.files[0]; if (f) { const url = await verklein(f, 1600, 0.72); await IDB.put('plan:' + id, url); openSchaal(url); } };
    $('fileFoto').onchange = async (e) => {
      const lijst = (await IDB.get('fotos:' + id)) || [];
      for (const f of [...e.target.files].slice(0, 16 - lijst.length)) lijst.push(await verklein(f, 1024, 0.62));
      await IDB.put('fotos:' + id, lijst); melding(`${lijst.length} foto('s) bewaard op dit toestel.`); teken();
    };
    media.querySelectorAll('.thumbs button').forEach(b => b.onclick = async () => { const l = (await IDB.get('fotos:' + id)) || []; l.splice(+b.dataset.i, 1); await IDB.put('fotos:' + id, l); teken(); });
    if (p) {
      for (const [el, k] of [['plX', 'x'], ['plZ', 'z'], ['plR', 'rot'], ['plO', 'op']]) $(el).oninput = (e) => { p[k] = +e.target.value; tekenPlan(); };
      for (const el of ['plX', 'plZ', 'plR', 'plO']) $(el).onchange = () => bewaarData();
      $('plSchaal').onclick = async () => openSchaal(await IDB.get('plan:' + id));
      $('plWeg').onclick = async () => { delete d.plan; await IDB.put('plan:' + id, null); bewaarData(); tekenPlan(); teken(); };
    }
    // Claude laten meekijken (enkel in de versie binnen Claude)
    const sample = window.AR_CFG && (window.AR_CFG.artifact || window.AR_CFG.demo) ? await window.claude?.use?.('sample') : null;
    if (sample && (fotos.length || p)) {
      $('claudeVak').innerHTML = `<button type="button" id="btnClaude" class="hoofd" style="margin-top:8px">Laat Claude de fiche invullen</button><div id="claudeUit" class="zacht" style="white-space:pre-wrap;margin-top:6px"></div>`;
      $('btnClaude').onclick = () => claudeAnalyse(sample, fotos, p ? await_plan(id) : null);
    }
  }
  const await_plan = (id) => IDB.get('plan:' + id);

  async function claudeAnalyse(sample, fotos, planP) {
    const uit = $('claudeUit'), knop = $('btnClaude'); knop.disabled = true; uit.textContent = 'Claude bekijkt je plan en foto\'s… (dit kan een minuut duren)';
    try {
      const planUrl = planP ? await planP : null;
      const beelden = [...fotos.slice(0, 8), ...(planUrl ? [planUrl] : [])].map(dataUrlNaarBlob);
      const vragen = VELDEN.map(f => `- "${f.k.replace('g.', '')}": één van ${f.o.map(o => '"' + o[0] + '"').join(', ')}`).join('\n');
      const prompt = `Je helpt een bouwkunde-student (België) om een ruimte zo goed mogelijk te beschrijven voor een AR-app die structuur, wapening en technieken toont.
Je krijgt ${fotos.length} foto('s) van de ruimte${planUrl ? ' en als laatste afbeelding een plan' : ''}. Projectnaam: ${S.data.naam}. Opmerkingen van de gebruiker: ${S.data.info?.opmerkingen || '—'}.
Leid af wat je redelijk kan zien. Kies "onbekend" (of laat weg) als je het niet kan zien. Antwoord ENKEL met JSON:
{
${vragen}
- "water": lijst uit "lavabo","keuken","douche","wc"
- "toestellen": {"stopcontacten": aantal, "schakelaars": aantal, "lichtpunten": aantal, "radiatoren": aantal, "ventielen": aantal, "rookmelder": true/false}
- "toelichting": korte uitleg in het Nederlands (max 6 zinnen): wat je zag en waarop je je baseert, plus wat de gebruiker nog best nakijkt
}`;
      const r = await sample.json(prompt, { images: beelden, modelTier: 'default' });
      const d = S.data; let n = 0;
      for (const f of VELDEN) { const kk = f.k.replace('g.', ''); const val = r[kk]; if (val && val !== 'onbekend' && f.o.some(o => o[0] === val)) { zet(d, f.k, val); n++; } }
      if (Array.isArray(r.water)) d.info.water = r.water.filter(x => WATER.some(w => w[0] === x));
      d.info.claude = { toestellen: r.toestellen || null, toelichting: r.toelichting || '', datum: new Date().toISOString() };
      opslaan();
      $('claudeUit').textContent = `✓ ${n} velden ingevuld door Claude (controleer ze).\n` + (r.toelichting || '') + (r.toestellen ? `\nGezien: ${Object.entries(r.toestellen).map(([k, v]) => `${k} ${v}`).join(', ')}. Duid ze in de bril aan via Rondgang.` : '');
    } catch (e) {
      uit.textContent = { not_granted: 'Je gaf geen toestemming om Claude te gebruiken.', rate_limited: 'Even te veel aanvragen; probeer het zo opnieuw.', images_unavailable: 'Afbeeldingen doorsturen is hier niet beschikbaar.' }[e.code] || ('Lukte niet: ' + (e.message || e.code || e));
      knop.disabled = false;
    }
  }

  // ---------- plan op schaal zetten ----------
  function openSchaal(url) {
    const m = $('planModal'), cv = $('planCanvas'), ctx = cv.getContext('2d');
    const img = new Image();
    let pts = [];
    img.onload = () => {
      const max = Math.min(window.innerWidth * 0.86, 900), sc = Math.min(1, max / img.width, (window.innerHeight * 0.6) / img.height);
      cv.width = img.width * sc; cv.height = img.height * sc; cv.dataset.sc = sc;
      teken2();
    };
    function teken2() {
      ctx.drawImage(img, 0, 0, cv.width, cv.height);
      ctx.fillStyle = '#ff3b30'; ctx.strokeStyle = '#ff3b30'; ctx.lineWidth = 3;
      pts.forEach(p => { ctx.beginPath(); ctx.arc(p[0], p[1], 6, 0, 7); ctx.fill(); });
      if (pts.length === 2) { ctx.beginPath(); ctx.moveTo(...pts[0]); ctx.lineTo(...pts[1]); ctx.stroke(); }
      $('planStap').textContent = pts.length < 2 ? `Klik punt ${pts.length + 1} van 2 (bv. de twee uiteinden van een muur of een maatlijn).` : 'Vul de echte afstand tussen de twee punten in en druk Toepassen.';
    }
    cv.onclick = (e) => { const r = cv.getBoundingClientRect(); const p = [(e.clientX - r.left) * cv.width / r.width, (e.clientY - r.top) * cv.height / r.height]; pts = pts.length >= 2 ? [p] : [...pts, p]; teken2(); };
    $('planOk').onclick = () => {
      const afst = parseFloat(String($('planAfst').value).replace(',', '.'));
      if (pts.length < 2 || !(afst > 0)) { $('planStap').textContent = 'Klik eerst twee punten en vul een afstand in meter in (bv. 4,9).'; return; }
      const sc = +cv.dataset.sc, px = Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]) / sc;
      const d = S.data, oud = d.plan || {};
      const [cx, cz] = api.midden();
      d.plan = { schaal: afst / px, b: img.width, h: img.height, x: oud.x ?? cx, z: oud.z ?? cz, rot: oud.rot ?? 0, op: oud.op ?? 0.6 };
      bewaarData(); m.hidden = true; tekenPlan(); teken();
      melding('Plan op schaal gezet. Verschuif en draai het met de schuiven tot het over je kamer ligt.', 6000);
    };
    $('planNiet').onclick = () => { m.hidden = true; teken(); };
    $('planAfst').value = ''; m.hidden = false; img.src = url;
  }
  return { teken };
}

export async function verklein(file, max, q) {
  const bmp = await createImageBitmap(file);
  const sc = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas'); c.width = Math.round(bmp.width * sc); c.height = Math.round(bmp.height * sc);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', q);
}
export function dataUrlNaarBlob(url) {
  const [kop, data] = url.split(','); const mime = /:(.*?);/.exec(kop)[1];
  const bin = atob(data); const arr = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}
