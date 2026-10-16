// app.js — AR-Bouw: projecten, 3D-voorbeeld op pc, AR op Meta Quest 3 (WebXR)
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';
import { XRHandModelFactory } from 'three/addons/webxr/XRHandModelFactory.js';
const PROFIELEN = 'https://cdn.jsdelivr.net/npm/@webxr-input-profiles/assets@1.0.20/dist/profiles';
import { generate, defaults, LAGEN, FASEN, VLOERTYPES } from './generator.js';
import { Panel } from './xrui.js';
import { makeLabel, distToPolyline, V3, polyCentroid, pointInPoly } from './geo.js';
import { startScan } from './qr.js';
import { maakFiche, volledigheid, dataUrlNaarBlob } from './fiche.js';

export const VERSIE = 'v1.0';
const $ = (id) => document.getElementById(id);

// ---------------- opslag ----------------
const LS = {
  get(k, d = null) { try { const v = localStorage.getItem('arb:' + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('arb:' + k, JSON.stringify(v)); } catch { /* vol of geblokkeerd */ } },
  del(k) { try { localStorage.removeItem('arb:' + k); } catch { /* */ } },
};
const IDB = {
  db: null,
  async open() {
    if (this.db) return this.db;
    this.db = await new Promise((res, rej) => { const r = indexedDB.open('arbouw', 1); r.onupgradeneeded = () => r.result.createObjectStore('ifc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    return this.db;
  },
  async put(k, v) { try { const db = await this.open(); await new Promise((res, rej) => { const t = db.transaction('ifc', 'readwrite'); t.objectStore('ifc').put(v, k); t.oncomplete = res; t.onerror = rej; }); } catch { /* */ } },
  async get(k) { try { const db = await this.open(); return await new Promise((res) => { const r = db.transaction('ifc').objectStore('ifc').get(k); r.onsuccess = () => res(r.result); r.onerror = () => res(null); }); } catch { return null; } },
  async keys() { try { const db = await this.open(); return await new Promise((res) => { const r = db.transaction('ifc').objectStore('ifc').getAllKeys(); r.onsuccess = () => res(r.result); r.onerror = () => res([]); }); } catch { return []; } },
};

// ---------------- toestand ----------------
const S = {
  projecten: [], entry: null, data: null, model: null,
  lagen: Object.fromEntries(Object.keys(LAGEN).map(k => [k, true])), fase: 0, labels: true,
  mode: 'verkennen', sub: null, markers: [], notities: [], pendingMarker: null, markerId: 'M1',
  punten: [], extraWand: [], plaatsType: 'stopcontact', notitieType: 'Opmerking', snede: null, snedeVast: false,
  meet: { a: null }, highlight: null, anchor: null, floorY: 0, panelVrij: false,
};
LAGEN.notities = { naam: 'Notities', kleur: 0xffffff };
LAGEN.plan = { naam: 'Plan op de vloer', kleur: 0xe6edf5 };
S.lagen.notities = true; S.lagen.afwerking = false;

// ---------------- scène ----------------
const midden = $('midden');
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.xr.enabled = true;
renderer.localClippingEnabled = true;
midden.prepend(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, 1, 0.02, 200);
camera.position.set(6, 5, 7);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(2.4, 1, 1.6); controls.enableDamping = true;
scene.add(new THREE.HemisphereLight(0xffffff, 0x334455, 1.2));
{ const zon = new THREE.DirectionalLight(0xffffff, 1.2); zon.position.set(1, 3, 2); scene.add(zon); }
const grid = new THREE.GridHelper(20, 40, 0x2a3442, 0x1a222d); grid.position.y = -0.001; scene.add(grid);
const root = new THREE.Group(); root.name = 'project'; root.matrixAutoUpdate = false; scene.add(root);
const notesGroup = new THREE.Group(); root.add(notesGroup);
const helpers = new THREE.Group(); scene.add(helpers); // reticle, meetlijnen (wereldcoördinaten)

function resize() {
  const r = midden.getBoundingClientRect();
  if (renderer.xr.isPresenting) return;
  renderer.setSize(r.width, r.height, false); camera.aspect = r.width / Math.max(1, r.height); camera.updateProjectionMatrix();
}
addEventListener('resize', resize);

// ---------------- projecten ----------------
async function laadLijst() {
  const lijst = [];
  try {
    const idx = await (await fetch('projecten/index.json', { cache: 'no-cache' })).json();
    for (const f of idx.projecten) {
      try { const d = await (await fetch('projecten/' + f, { cache: 'no-cache' })).json(); lijst.push({ id: d.id, naam: d.naam, soort: 'ruimte', bron: 'vast', basis: d }); } catch (e) { console.warn('project', f, e); }
    }
  } catch (e) { console.warn('geen projecten/index.json', e); }
  if (window.AR_CFG?.artifact) {
    try {
      const db = await window.claude?.use?.('db');
      if (db) { const snap = await db.collection('lokalen').get(); for (const doc of snap.docs || []) { const d = doc.data ? doc.data() : doc; if (d?.id && d.ruimte && !lijst.find(p => p.id === d.id)) lijst.push({ id: d.id, naam: d.naam, soort: 'ruimte', bron: 'vast', basis: d, uitDb: true }); } }
    } catch (e) { console.warn('lokalen uit db', e); }
  }
  for (const id of LS.get('lokaal', [])) { const d = LS.get('proj:' + id); if (d && !lijst.find(p => p.id === id)) lijst.push({ id, naam: d.naam, soort: 'ruimte', bron: 'lokaal', basis: d }); }
  // IFC: GitHub-repo + eerder geopende bestanden
  try {
    const { githubModellen } = await import('./ifc.js');
    for (const m of await githubModellen()) lijst.push({ id: 'ifc:' + m.naam, naam: m.naam, soort: 'ifc', bron: 'github', url: m.url });
  } catch (e) { console.warn(e); }
  for (const k of (await IDB.keys()).filter(k => /\.ifc$/i.test(k))) if (!lijst.find(p => p.id === 'ifc:' + k)) lijst.push({ id: 'ifc:' + k, naam: k, soort: 'ifc', bron: 'lokaal' });
  try { const m = await fetch('modellen/modellen.json', { cache: 'no-cache' }); if (m.ok) for (const n of (await m.json()).modellen || []) if (!lijst.find(p => p.id === 'ifc:' + n)) lijst.push({ id: 'ifc:' + n, naam: n, soort: 'ifc', bron: 'site', url: 'modellen/' + n }); } catch { /* */ }
  S.projecten = lijst;
  tekenLijst();
}
const tabVan = p => p.soort === 'ifc' ? 'ifc' : p.bron === 'lokaal' ? 'scan' : 'db';
function kiesTab(t, bewaar = true) {
  for (const k of ['db', 'scan', 'ifc']) { $('tab-' + k).hidden = k !== t; $('tabbtn-' + k).setAttribute('aria-selected', String(k === t)); }
  if (bewaar) LS.set('tab', t);
}
document.querySelectorAll('.tab').forEach(b => { b.onclick = () => kiesTab(b.dataset.tab); });
// ---------- hoofdmenu (startscherm) ----------
function toonStart(aan) {
  $('startScherm').hidden = !aan;
  if (aan) {
    const tel = t => S.projecten.filter(p => tabVan(p) === t).length;
    $('telDb').textContent = `${tel('db')} lokalen`; $('telScan').textContent = `${tel('scan')} eigen project(en)`; $('telIfc').textContent = `${tel('ifc')} IFC-model(len)`;
    setTimeout(() => document.querySelector('.tegel')?.focus(), 0);
  } else resize();
}
document.querySelectorAll('.tegel').forEach(b => { b.onclick = () => {
  const t = b.dataset.start; kiesTab(t); toonStart(false);
  if (!S.entry || tabVan(S.entry) !== t) { const p = S.projecten.find(x => tabVan(x) === t); if (p) openProject(p); }
  if (t === 'scan') setTimeout(() => $('nwNaam')?.focus(), 50);
}; });
$('btnMenu').onclick = () => toonStart(true);
function tekenLijst() {
  const lijsten = { db: $('lijstDb'), scan: $('lijstScan'), ifc: $('lijstIfc') };
  for (const el of Object.values(lijsten)) el.innerHTML = '';
  for (const p of S.projecten) {
    const d = document.createElement('div');
    d.className = 'kaart' + (S.entry?.id === p.id ? ' actief' : '');
    d.tabIndex = 0;
    const gewijzigd = p.soort === 'ruimte' && LS.get('proj:' + p.id) && p.bron === 'vast';
    const st = p.basis?.status === 'ingemeten' || LS.get('proj:' + p.id)?.status === 'ingemeten';
    d.innerHTML = `<b>${esc(p.naam)}</b>${p.soort === 'ifc' ? '<span class="badge ifc">IFC</span>' : st ? '<span class="badge lok">ingemeten</span>' : '<span class="badge">nog in te meten</span>'}${gewijzigd ? '<span class="badge lok">lokaal aangepast</span>' : ''}<small>${esc(p.basis?.beschrijving || (p.soort === 'ifc' ? 'Revit-model (IFC) ' + (p.bron === 'github' ? 'uit je GitHub-repo' : p.bron === 'site' ? 'op de site' : 'geüpload op dit toestel') : ''))}</small>`;
    if (tabVan(p) === 'db') {
      const r = document.createElement('div'); r.className = 'rij';
      const q = document.createElement('button'); q.type = 'button'; q.className = 'klein'; q.textContent = 'QR-codes';
      q.onclick = (e) => { e.stopPropagation(); toonQR(p); };
      r.appendChild(q); d.appendChild(r);
    }
    d.onclick = () => openProject(p);
    d.onkeydown = (e) => { if (e.key === 'Enter') openProject(p); };
    lijsten[tabVan(p)].appendChild(d);
  }
  for (const [k, el] of Object.entries(lijsten)) if (!el.children.length) el.innerHTML = `<div class="leeg">${{ db: 'Nog geen vaste lokalen.', scan: 'Nog geen eigen projecten. Maak er hierboven een aan.', ifc: 'Nog geen IFC-modellen. Upload er een.' }[k]}</div>`;
}

// ---------- QR-codes per lokaal ----------
let qrState = null;
async function toonQR(p) {
  if (!window.qrcode) { try { await new Promise((res, rej) => { const sc = document.createElement('script'); sc.src = 'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js'; sc.onload = res; sc.onerror = rej; document.head.appendChild(sc); }); } catch { melding('QR-bibliotheek kon niet laden.'); return; } }
  qrState = { p, m: 1 }; tekenQR(); $('qrToon').hidden = false;
}
function tekenQR() {
  const { p, m } = qrState; const mid = 'M' + m;
  const opWeb = /^https?:/.test(location.href) && !window.AR_CFG?.artifact && !window.AR_CFG?.demo;
  const url = opWeb ? new URL(`index.html?p=${encodeURIComponent(p.id)}&m=${mid}`, location.href).toString() : `arbouw:p=${p.id}&m=${mid}`;
  const qr = window.qrcode(0, 'M'); qr.addData(url); qr.make();
  $('qrTitel').textContent = `${p.naam} · blad ${mid}`;
  $('qrBeeld').innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  $('qrBlad').textContent = mid;
  $('qrTekst').textContent = opWeb ? 'Print via "QR-bladen printen" (met de kruisjes L en R), of scan deze code met de app.' : 'Code voor de app (scannen werkt in de online versie). Printbare bladen met kruisjes maak je in de online versie via "QR-bladen printen".';
}
$('qrVorige').onclick = () => { qrState.m = Math.max(1, qrState.m - 1); tekenQR(); };
$('qrVolgende').onclick = () => { qrState.m = Math.min(8, qrState.m + 1); tekenQR(); };
$('qrSluit').onclick = () => { $('qrToon').hidden = true; };
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function openProject(p, { stil = false } = {}) {
  S.entry = p; LS.set('laatste', p.id);
  if (!stil) kiesTab(tabVan(p));
  S.highlight = null; S.anchor = null;
  root.clear(); root.add(notesGroup);
  if (p.soort === 'ruimte') {
    S.data = defaults(structuredClone(LS.get('proj:' + p.id) || p.basis));
    bouwModel();
  } else {
    melding('IFC laden…');
    try {
      let buf = await IDB.get(p.naam);
      if (!buf && p.url) { buf = await (await fetch(p.url)).arrayBuffer(); }
      if (!buf) throw new Error('bestand niet gevonden');
      const { loadIFC } = await import('./ifc.js');
      S.data = { id: p.id, naam: p.naam, soort: 'ifc', markers: [] };
      S.model = await loadIFC(buf, p.naam, n => melding(`IFC laden… ${n} elementen`));
      const b = S.model.box; S.model.group.position.set(-(b.min.x + b.max.x) / 2 + 0, -b.min.y, -(b.min.z + b.max.z) / 2);
      root.add(S.model.group);
      if ($('ifcWap').checked || $('ifcTech').checked) {
        melding('Wapening en technieken genereren…');
        await new Promise(r => setTimeout(r, 30));
        const { genereerUitIFC } = await import('./ifcgen.js');
        const gen = genereerUitIFC(S.model.elementen, { wapening: $('ifcWap').checked, technieken: $('ifcTech').checked, onbekendIsBeton: $('ifcBeton').checked, vloerverwarming: $('ifcVV').checked });
        S.model.group.add(gen.group);
        S.model.picks.push(...gen.picks);
        const off = S.model.group.position;
        S.model.leidingen = gen.leidingen.map(l => ({ ...l, pts: l.pts.map(q => q.clone().add(off)) }));
        S.model.rapport.push(...gen.rapport);
      }
      melding(`${p.naam}: ${S.model.elementen.length} IFC-elementen geladen`, 3000);
    } catch (e) { melding('IFC kon niet laden: ' + e.message, 6000); console.error(e); return; }
  }
  S.markers = [...(S.data.markers || []).map(m => markerUitJson(m)).filter(Boolean), ...LS.get('markers:' + p.id, [])];
  S.notities = LS.get('notes:' + p.id, []);
  tekenNotities();
  root.matrix.identity(); root.matrixWorldNeedsUpdate = true;
  if (S.data.soort === 'ruimte') { const [cx, cz] = polyCentroid(S.data.ruimte.vloer); controls.target.set(cx, 1, cz); camera.position.set(cx + 5, 5, cz + 6); }
  else { controls.target.set(0, 1, 0); camera.position.set(8, 7, 10); }
  updateZichtbaarheid(); tekenLijst(); tekenRechts();
  planMesh?.parent?.remove(planMesh); planMesh = null; tekenPlan();
  $('btnAR').disabled = false; $('btnAR').classList.toggle('uit', !S.xrOK);
  if (panel && !session) panelUpdate();
  if (!stil) document.title = 'AR-Bouw · ' + p.naam;
}
function bouwModel() {
  if (S.model?.group && S.model.group.parent) root.remove(S.model.group);
  S.model = generate(S.data);
  root.add(S.model.group);
  if (planMesh && planMesh.parent !== root) root.add(planMesh);
  updateZichtbaarheid();
  if (S.snede) zetSnede(true);
  tekenRechts();
}
function bewaarData() {
  LS.set('proj:' + S.entry.id, S.data);
  if (S.entry.bron === 'lokaal') { const l = LS.get('lokaal', []); if (!l.includes(S.entry.id)) LS.set('lokaal', [...l, S.entry.id]); }
}

// ---------------- zichtbaarheid ----------------
function updateZichtbaarheid() {
  if (!S.model) return;
  const pres = S.mode === 'presentatie';
  root.traverse(o => {
    const u = o.userData; if (!u || !u.laag) return;
    let v = S.lagen[u.laag] !== false && (S.fase === 0 || (u.fase || 1) <= S.fase);
    if (u.isLabel) { v = v && S.labels && (u.kern || pres || S.mode === 'fasen'); u.baseScale ||= o.scale.clone(); o.scale.copy(u.baseScale).multiplyScalar(pres ? 1.8 : 1); }
    o.visible = v;
  });
}
function zetSnede(aan) {
  root.traverse(o => { if (o.material && !Array.isArray(o.material)) { const want = aan ? [snedeVlak] : null; if (o.material.clippingPlanes !== want) { o.material.clippingPlanes = want; o.material.needsUpdate = true; } } });
  if (S.highlight?.userData.origMat) { S.highlight.userData.origMat.clippingPlanes = aan ? [snedeVlak] : null; }
}

// ---------------- 2D-zijpaneel ----------------
function tekenRechts() {
  const d = S.data; if (!d) return;
  $('projInfo').innerHTML = d.soort === 'ifc' ? `<b>${esc(d.naam)}</b><br>Eigen IFC-model` :
    `<b>${esc(d.naam)}</b><br>${esc(d.beschrijving || '')}<br><span class="waarsch">Status: ${d.status === 'ingemeten' ? 'ingemeten (vorm), technieken = aanname' : 'aanname — nog niet ingemeten'}</span>`;
  $('lagen').innerHTML = '';
  for (const [k, l] of Object.entries(LAGEN)) {
    const lab = document.createElement('label'); lab.className = 'laag';
    lab.innerHTML = `<input type="checkbox" ${S.lagen[k] !== false ? 'checked' : ''}><i style="background:#${l.kleur.toString(16).padStart(6, '0')}"></i>${l.naam}`;
    lab.querySelector('input').onchange = (e) => { S.lagen[k] = e.target.checked; updateZichtbaarheid(); };
    $('lagen').appendChild(lab);
  }
  fiche.teken();
  $('rapport').textContent = (S.model?.rapport || []).join('\n');
}
// ---------- plan op de vloer ----------
let planMesh = null, planTex = null, planVoor = null;
async function tekenPlan() {
  const d = S.data;
  if (!d?.plan || d.soort !== 'ruimte') { if (planMesh) { planMesh.parent?.remove(planMesh); planMesh = null; } return; }
  const id = S.entry.id;
  if (planVoor !== id || !planTex) {
    const url = await IDB.get('plan:' + id); if (!url) return;
    planTex?.dispose(); planTex = await new THREE.TextureLoader().loadAsync(url); planTex.colorSpace = THREE.SRGBColorSpace; planVoor = id;
  }
  const p = d.plan, w = p.b * p.schaal, h = p.h * p.schaal;
  if (!planMesh) { planMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide })); planMesh.rotation.order = 'YXZ'; planMesh.renderOrder = 2; }
  planMesh.material.map = planTex; planMesh.material.opacity = p.op; planMesh.material.needsUpdate = true;
  planMesh.scale.set(w, h, 1); planMesh.rotation.set(-Math.PI / 2, -p.rot * Math.PI / 180, 0);
  planMesh.position.set(p.x, 0.004, p.z);
  planMesh.userData = { laag: 'plan', fase: 0, pickable: false };
  if (planMesh.parent !== root) root.add(planMesh);
  planMesh.visible = S.lagen.plan !== false;
}
const fiche = maakFiche({ S, IDB, $, bewaarData: () => bewaarData(), bouwModel: () => bouwModel(), melding: (t, ms) => melding(t, ms), tekenPlan: () => tekenPlan(), midden: () => polyCentroid(S.data.ruimte.vloer) });
$('fase').oninput = (e) => { S.fase = +e.target.value; $('faseNaam').textContent = FASEN[S.fase]; updateZichtbaarheid(); };

let meldT = 0;
function melding(t, ms = 2500) { const m = $('melding'); m.textContent = t; m.style.display = 'block'; clearTimeout(meldT); meldT = setTimeout(() => (m.style.display = 'none'), ms); if (panel) { S.panelMelding = t; panelUpdate(); } }

// klikken in pc-voorbeeld
const ray = new THREE.Raycaster();
renderer.domElement.addEventListener('click', (e) => {
  if (renderer.xr.isPresenting || !S.model) return;
  const r = renderer.domElement.getBoundingClientRect();
  ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
  const h = pickVisible(ray);
  setHighlight(h?.object || null);
  $('info').textContent = h ? h.object.userData.naam + '\n' + h.object.userData.info : 'Niets geraakt.';
  if (panel && !session) { S.hoverInfo = h ? h.object.userData.naam + '\n' + h.object.userData.info : null; panelUpdate(); }
});
function pickVisible(rc) {
  const vis = (S.model?.picks || []).filter(m => isVisible(m));
  const hits = rc.intersectObjects(vis, false);
  // voorkeur voor leidingen/kleine elementen boven grote transparante vlakken
  hits.sort((a, b) => (a.object.material.opacity < 0.3) - (b.object.material.opacity < 0.3) || a.distance - b.distance);
  return hits[0] || null;
}
function isVisible(o) { while (o) { if (!o.visible) return false; o = o.parent; } return true; }
const hlMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthTest: false });
function setHighlight(m) {
  if (S.highlight === m) return;
  if (S.highlight) S.highlight.material = S.highlight.userData.origMat;
  S.highlight = m;
  if (m) { m.userData.origMat = m.material; m.material = hlMat; }
}

// ---------------- notities ----------------
function tekenNotities() {
  notesGroup.clear();
  for (const n of S.notities) {
    const p = V3(...n.p);
    const s = new THREE.Mesh(new THREE.SphereGeometry(0.02, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    s.position.copy(p); s.userData = { laag: 'notities', fase: 0, info: `Notitie: ${n.t}\n${n.d}`, naam: 'Notitie', pickable: true };
    const l = makeLabel(`📌 ${n.t}`, { size: 0.04, border: '#ffffff' }); l.position.copy(p).add(V3(0, 0.07, 0)); l.userData = { laag: 'notities', fase: 0, isLabel: true, kern: true };
    notesGroup.add(s, l);
  }
}

// ---------------- markers (QR-bladen) ----------------
const KRUIS = 0.12; // kruisjes op ±120 mm van het midden van het A4-blad (liggend)
function markerUitJson(m) {
  if (m.L && m.R) return m;
  if (S.data?.soort !== 'ruimte' || m.x == null) return null;
  const poly = S.data.ruimte.vloer;
  let best = null;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length]; let dx = b[0] - a[0], dz = b[1] - a[1]; const L = Math.hypot(dx, dz); dx /= L; dz /= L;
    let u = Math.max(0, Math.min(L, (m.x - a[0]) * dx + (m.z - a[1]) * dz)); const px = a[0] + dx * u, pz = a[1] + dz * u, d = Math.hypot(m.x - px, m.z - pz);
    if (!best || d < best.d) { let nx = -dz, nz = dx; if (!pointInPoly(px + nx * 0.01, pz + nz * 0.01, poly)) { nx = -nx; nz = -nz; } best = { d, px, pz, nx, nz }; }
  }
  const rx = best.nz, rz = -best.nx, y = m.hoogte ?? 1.5;
  return { id: m.id, L: [best.px - rx * KRUIS, y, best.pz - rz * KRUIS], R: [best.px + rx * KRUIS, y, best.pz + rz * KRUIS] };
}

// ---------------- kalibratie-wiskunde ----------------
const ang = (dx, dz) => Math.atan2(-dz, dx);
/** P: projectpunten, W: wereldpunten (gelijke volgorde). extra: wereldpunten op dezelfde wandlijn als P0-P1 */
function losKalibratie(P, W, extra = []) {
  let dWx = W[1].x - W[0].x, dWz = W[1].z - W[0].z;
  if (extra.length) {
    // lijn door alle wandpunten (PCA in xz), georiënteerd zoals W0->W1
    const pts = [W[0], W[1], ...extra]; const mx = pts.reduce((s, p) => s + p.x, 0) / pts.length, mz = pts.reduce((s, p) => s + p.z, 0) / pts.length;
    let sxx = 0, sxz = 0, szz = 0; for (const p of pts) { const x = p.x - mx, z = p.z - mz; sxx += x * x; sxz += x * z; szz += z * z; }
    const th = 0.5 * Math.atan2(2 * sxz, sxx - szz); let ex = Math.cos(th), ez = Math.sin(th);
    if (ex * dWx + ez * dWz < 0) { ex = -ex; ez = -ez; } dWx = ex; dWz = ez;
  }
  const theta = ang(dWx, dWz) - ang(P[1].x - P[0].x, P[1].z - P[0].z);
  const R = new THREE.Matrix4().makeRotationY(theta);
  const pm = P[0].clone().add(P[1]).multiplyScalar(0.5).applyMatrix4(R);
  const wm = W[0].clone().add(W[1]).multiplyScalar(0.5);
  const t = wm.sub(pm);
  return new THREE.Matrix4().makeTranslation(t.x, t.y, t.z).multiply(R);
}
function zetKalibratie(M, bron) {
  S.kalMatrix = M.clone(); S.verplaatst = false;
  root.matrix.copy(M); root.matrixWorldNeedsUpdate = true; S.anchor = null; S.kalBron = bron;
  melding('Uitgelijnd via ' + bron);
}
const rootInv = () => root.matrix.clone().invert();

// ---------------- XR ----------------
let panel = null, session = null, refSpace = null;
const ctrls = [];
const RONDGANG = [
  { id: 'scan', titel: 'Ruimte scannen', tekst: 'De app gebruikt je Ruimteconfiguratie van de Quest. Druk "Uitlijnen" en daarna "Maten overnemen". Ligt de deur aan de verkeerde kant? Druk "Deur aanwijzen".' },
  { id: 'deur', type: 'deur', titel: 'Deuren', tekst: 'Wijs het midden van elke deur aan (op ± 1 m hoogte) en druk de trekker.' },
  { id: 'raam', type: 'raam', titel: 'Ramen', tekst: 'Wijs het midden van elk raam aan.' },
  { id: 'stopcontact', type: 'stopcontact', titel: 'Stopcontacten', tekst: 'Wijs elk stopcontact aan, op de juiste hoogte.' },
  { id: 'schakelaar', type: 'schakelaar', titel: 'Schakelaars', tekst: 'Wijs elke schakelaar aan.' },
  { id: 'lichtpunt', type: 'lichtpunt', titel: 'Lichtpunten', tekst: 'Wijs elk lichtpunt op het plafond aan.' },
  { id: 'radiator', type: 'radiator', titel: 'Verwarming', tekst: 'Wijs elke radiator aan. Vloerverwarming of niets? Druk Volgende (zet het in de projectfiche).' },
  { id: 'lavabo', type: 'lavabo', titel: 'Water', tekst: 'Wijs de lavabo of kraan aan. Geen water? Druk Volgende.' },
  { id: 'schacht', type: 'schacht', titel: 'Schacht / koker', tekst: 'Tik twee tegenoverliggende hoeken van de schacht of koker op de vloer. Geen? Druk Volgende.' },
  { id: 'ventiel', type: 'ventiel', titel: 'Ventilatie', tekst: 'Wijs ventielen en roosters aan.' },
  { id: 'rookmelder', type: 'rookmelder', titel: 'Rookmelder', tekst: 'Wijs de rookmelder op het plafond aan.' },
  { id: 'kolom', type: 'kolom', titel: 'Kolommen', tekst: 'Wijs zichtbare kolommen aan (op de vloer, aan hun voet).' },
  { id: 'naad', type: 'naad', titel: 'Plafondnaden', tekst: 'Zie je rechte naden in het plafond? Wijs het begin en het einde van één naad aan. Zo weet de app in welke richting de vloer overspant.' },
];
const MODES = [
  { id: 'menu', label: '☰ Menu' }, { id: 'rondgang', label: 'Rondgang' }, { id: 'verkennen', label: 'Verkennen' }, { id: 'kalibreren', label: 'Kalibreren' }, { id: 'inmeten', label: 'Inmeten' },
  { id: 'plaatsen', label: 'Plaatsen' }, { id: 'snede', label: 'Snede' }, { id: 'meten', label: 'Meten' },
  { id: 'notities', label: 'Notities' }, { id: 'fasen', label: 'Bouwfasen' }, { id: 'presentatie', label: 'Presentatie' },
];
const reticle = new THREE.Mesh(new THREE.RingGeometry(0.03, 0.045, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x4da3ff, depthTest: false, transparent: true }));
reticle.renderOrder = 998; reticle.visible = false; helpers.add(reticle);
const meetLijn = new THREE.Line(new THREE.BufferGeometry().setFromPoints([V3(), V3()]), new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false }));
meetLijn.renderOrder = 998; meetLijn.visible = false; helpers.add(meetLijn);
let meetLabel = null;
function zetMeetLabel(t, pos, kleur = '#ffffff') {
  if (meetLabel) { helpers.remove(meetLabel); meetLabel.material.map.dispose(); }
  meetLabel = makeLabel(t, { size: 0.04, border: kleur }); meetLabel.position.copy(pos); helpers.add(meetLabel);
}
const puntenGroep = new THREE.Group(); helpers.add(puntenGroep);
function toonPunt(p, kleur = 0x4da3ff) { const m = new THREE.Mesh(new THREE.SphereGeometry(0.012, 12, 8), new THREE.MeshBasicMaterial({ color: kleur, depthTest: false })); m.position.copy(p); m.renderOrder = 998; puntenGroep.add(m); }

function setupControllers() {
  for (let i = 0; i < 2; i++) {
    const c = renderer.xr.getController(i), grip = renderer.xr.getControllerGrip(i), hand = renderer.xr.getHand(i);
    const lijn = new THREE.Line(new THREE.BufferGeometry().setFromPoints([V3(0, 0, 0), V3(0, 0, -1)]), new THREE.LineBasicMaterial({ color: 0x8cc4ff, transparent: true, opacity: 0.8 }));
    lijn.scale.z = 3; c.add(lijn);
    const tip = new THREE.Mesh(new THREE.SphereGeometry(0.006, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false })); tip.position.set(0, 0, -0.03); tip.renderOrder = 999; c.add(tip);
    const st = { i, c, grip, hand, lijn, tip, source: null, grab: null, lastTip: [] };
    c.addEventListener('connected', (e) => { st.source = e.data; lijn.visible = !e.data.hand; tip.visible = !e.data.hand; });
    c.addEventListener('disconnected', () => { st.source = null; });
    c.addEventListener('select', () => onSelect(st));
    c.addEventListener('squeezestart', () => startGrab(st));
    c.addEventListener('squeezeend', () => { st.grab = null; });
    // zichtbare controllers en handen (altijd zichtbaar, ook als het model ervoor ligt)
    try {
      const cmf = new XRControllerModelFactory(); cmf.path = PROFIELEN;
      grip.add(cmf.createControllerModel(grip));
      const hmf = new XRHandModelFactory(); hmf.setPath?.(PROFIELEN + '/generic-hand/');
      hand.add(hmf.createHandModel(hand, 'mesh'));
    } catch (e) { console.warn('controllermodel', e); }
    grip.add(maakReserveController());
    st.reserve = grip.children[grip.children.length - 1];
    scene.add(c, grip, hand);
    ctrls.push(st);
  }
}
/** Eenvoudige controller (als het echte model niet kan laden, bv. offline of binnen Claude). */
function maakReserveController() {
  const g = new THREE.Group(); g.name = 'reserve';
  const m = new THREE.MeshStandardMaterial({ color: 0x2b3440, roughness: 0.5, metalness: 0.1 });
  const greep = new THREE.Mesh(new THREE.CylinderGeometry(0.017, 0.021, 0.11, 16), m); greep.rotation.x = -0.35; greep.position.set(0, -0.02, 0.045);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.038, 0.007, 10, 28), new THREE.MeshStandardMaterial({ color: 0xdfe8f5, roughness: 0.4 }));
  ring.rotation.x = Math.PI / 2 - 0.35; ring.position.set(0, 0.01, -0.01);
  g.add(greep, ring);
  g.traverse(o => { if (o.isMesh) { o.material.depthTest = false; o.renderOrder = 1001; } });
  return g;
}
/** Controller- en handmodellen bovenop alles tekenen, zodat je ze ziet als je in een muur of vloer grijpt. */
function controllersBovenop(st) {
  if (st.bovenopKlaar) return;
  let meshes = 0, echt = false;
  for (const ch of [...st.grip.children, ...(st.hand?.children || [])]) ch.traverse(o => { if (o.isMesh) { meshes++; if (!o.parent || o.parent.name !== 'reserve') if (ch.name !== 'reserve') echt = true; } });
  if (st.reserve) st.reserve.visible = !echt;
  if (!echt) return;
  for (const ch of [...st.grip.children, ...(st.hand?.children || [])]) ch.traverse(o => { if (o.isMesh && o.material) { o.material.depthTest = false; o.renderOrder = 1001; } });
  st.bovenopKlaar = true;
  void meshes;
}
function tipWorld(st, ago = 0) {
  if (st.source?.hand) {
    const j = st.hand.joints?.['index-finger-tip'];
    if (ago && st.lastTip.length) return st.lastTip[0].clone();
    return j ? j.getWorldPosition(V3()) : st.c.getWorldPosition(V3());
  }
  return st.tip.getWorldPosition(V3());
}
function rayFrom(st) {
  const rc = new THREE.Raycaster();
  const m = st.c.matrixWorld; rc.ray.origin.setFromMatrixPosition(m); rc.ray.direction.set(0, 0, -1).transformDirection(m);
  return rc;
}
const rechts = () => ctrls.find(s => s.source?.handedness === 'right') || ctrls.find(s => s.source);
const links = () => ctrls.find(s => s.source?.handedness === 'left');

async function startAR() {
  if (!S.data) return;
  try {
    session = await navigator.xr.requestSession('immersive-ar', { requiredFeatures: ['local-floor'], optionalFeatures: ['hand-tracking', 'plane-detection', 'anchors', 'hit-test'] });
  } catch (e) {
    const inClaude = !!(window.AR_CFG?.artifact || window.AR_CFG?.demo);
    melding(!navigator.xr ? 'Dit toestel heeft geen WebXR. Open de app in de browser van de Meta Quest 3.'
      : inClaude ? 'AR kon niet starten binnen deze Claude-pagina (' + e.message + '). Open de app via je GitHub-site in de Quest-browser.'
      : 'AR kon niet starten: ' + e.message, 9000);
    return;
  }
  renderer.xr.setReferenceSpaceType('local-floor');
  await renderer.xr.setSession(session);
  refSpace = renderer.xr.getReferenceSpace();
  S.kalBron = null; S.autoGeprobeerd = false; S.autoTeller = 0; S.floorScan = false; S.diagStart = performance.now(); S.diagGemeld = false;
  grid.visible = false; scene.background = null;
  if (!panel) { panel = new Panel(); scene.add(panel.mesh); }
  if (!ctrls.length) setupControllers();
  S.panelVrij = false; panel.mesh.visible = true;
  session.addEventListener('end', () => { scanGroep.clear(); grid.visible = true; session = null; zetSnede(false); S.snede = null; resize(); S.anchor = null; melding('AR gestopt. Wijzigingen zijn bewaard op dit toestel.'); });
  // startpositie
  const uuid = LS.get('anchor:' + S.entry.id);
  if (S.pendingMarker) { S.mode = 'kalibreren'; startSub('qr'); }
  else if (uuid && session.restorePersistentAnchor) {
    try { S.anchor = await session.restorePersistentAnchor(uuid); S.panelMelding = 'Positie hersteld van vorige keer (anchor). Controleer en verfijn indien nodig.'; } catch { S.panelMelding = 'Bewaarde positie niet gevonden — kalibreer via QR of 2 hoeken.'; zetStart(); }
  } else { zetStart(); S.panelMelding = 'Model voorlopig rond jou geplaatst. Kies Kalibreren om uit te lijnen.'; }
  panelUpdate();
}
function zetStart() {
  // projectmidden onder de gebruiker
  let cx = 0, cz = 0;
  if (S.data.soort === 'ruimte') [cx, cz] = polyCentroid(S.data.ruimte.vloer);
  root.matrix.makeTranslation(-cx, 0, -cz); root.matrixWorldNeedsUpdate = true;
}

// ---------- paneelinhoud ----------
function panelUpdate() {
  if (!panel) return;
  const acts = [];
  let info = S.panelMelding ? S.panelMelding + '\n' : '';
  const ruimte = S.data?.soort === 'ruimte';
  const m = S.mode;
  if (m === 'menu') {
    const cats = { db: 'Database', scan: 'Eigen project', ifc: 'Revit' };
    if (!S.menuCat) {
      for (const [k, l] of Object.entries(cats)) acts.push({ id: 'menu:cat:' + k, label: l, kleur: '#4da3ff' });
      acts.push({ id: 'stop', label: 'Stop AR', kleur: '#ff5b5b' });
      info += `Hoofdmenu. Nu open: ${S.data?.naam || '—'}.\nDatabase = vaste lokalen · Eigen project = ingemeten met de bril · Revit = je IFC-modellen.`;
    } else {
      const lijst = S.projecten.filter(p => tabVan(p) === S.menuCat).slice(0, 11);
      lijst.forEach(p => acts.push({ id: 'menu:proj:' + S.projecten.indexOf(p), label: p.naam, active: S.entry?.id === p.id }));
      acts.push({ id: 'menu:terug', label: '◀ Terug' });
      info += `${cats[S.menuCat]}: kies een project.` + (!lijst.length ? '\nNog geen projecten in deze categorie.' : '') + (S.menuCat === 'scan' ? '\nEen nieuw project maak je op het startscherm (buiten AR).' : '') + (S.menuCat === 'ifc' ? '\nEen IFC uploaden doe je op het startscherm (buiten AR).' : '');
    }
  } else if (m === 'verkennen') {
    for (const [k, l] of Object.entries(LAGEN)) if (k !== 'ifc' || !ruimte) acts.push({ id: 'laag:' + k, label: l.naam, active: S.lagen[k] !== false, kleur: '#' + l.kleur.toString(16).padStart(6, '0') });
    acts.push({ id: 'labels', label: 'Labels', active: S.labels }, { id: 'v:terug', label: 'Terug op zijn plaats', disabled: !S.verplaatst || !S.kalMatrix }, { id: 'stop', label: 'Stop AR', kleur: '#ff5b5b' });
    info += S.hoverInfo || 'Wijs met de straal naar een leiding of element voor info.\nWandelen zonder te stappen: linker joystick = verplaatsen, rechter joystick = draaien. "Terug op zijn plaats" zet het model terug.';
  } else if (m === 'rondgang') {
    S.rg ||= 0; const st = RONDGANG[S.rg];
    if (!ruimte) info += 'De rondgang is er voor ruimte-projecten (database of eigen project).';
    else {
      if (st.id === 'scan') acts.push({ id: 'rg:auto', label: 'Uitlijnen', kleur: '#4da3ff' }, { id: 'rg:deur', label: 'Deur aanwijzen', active: S.sub === 'deurkies' }, { id: 'rg:maten', label: 'Maten overnemen', kleur: '#4da3ff' }, { id: 'rg:capture', label: 'Scan opnieuw' }, { id: 'rg:toon', label: scanGroep.children.length ? 'Scan verbergen' : 'Scan tonen' });
      acts.push({ id: 'rg:-', label: '◀ Vorige', disabled: S.rg === 0 }, { id: 'rg:+', label: S.rg === RONDGANG.length - 1 ? 'Klaar ✓' : 'Volgende ▶', kleur: '#3ddc84' }, { id: 'rg:ongedaan', label: 'Laatste wissen', disabled: !st.type });
      const n = st.type ? [...S.data.ruimte.objecten, ...S.data.ruimte.openingen].filter(o => o.type === st.type && o.bevestigd).length : 0;
      const v = volledigheid({ ...S.data, fotosAantal: S.data.fotosAantal });
      if (S.scanInfo && st.id === 'scan') info += S.scanInfo + '\n';
      info += `Stap ${S.rg + 1}/${RONDGANG.length} — ${st.titel}${st.type && st.type !== 'naad' ? ` (${n} aangeduid)` : ''}\n${st.tekst}\nVolledigheid project: ${v ? v.pct : 0}%`;
    }
  } else if (m === 'kalibreren') {
    acts.push({ id: 'k:auto', label: 'Automatisch', disabled: !ruimte, kleur: '#4da3ff' }, { id: 'k:scan', label: scanGroep.children.length ? 'Scan verbergen' : 'Scan tonen' }, { id: 'k:deur', label: 'Deur aanwijzen', active: S.sub === 'deurkies', disabled: !ruimte }, { id: 'k:hoeken', label: '2 hoeken', active: S.sub === 'hoeken', disabled: !ruimte }, { id: 'k:qr', label: 'QR-kruisjes', active: S.sub === 'qr' },
      { id: 'k:reg', label: 'QR registreren', active: S.sub === 'reg' }, { id: 'k:blad', label: 'Blad: ' + S.markerId },
      { id: 'k:anchor', label: 'Bewaar positie' }, { id: 'k:midden', label: 'Midden hier' }, { id: 'k:draai', label: 'Draai 90°' }, { id: 'k:klaar', label: 'Klaar', kleur: '#3ddc84' });
    info += (S.scanInfo ? S.scanInfo + '\n' : '') + kalibratieTekst();
  } else if (m === 'inmeten') {
    acts.push({ id: 'i:scan', label: 'Uit ruimte-scan', disabled: !ruimte }, { id: 'i:capture', label: 'Scan opnieuw' }, { id: 'i:hoeken', label: 'Hoeken tikken', active: S.sub === 'ihoeken', disabled: !ruimte },
      { id: 'i:sluit', label: 'Sluit vorm', disabled: S.sub !== 'ihoeken' || S.punten.length < 3 }, { id: 'i:plafond', label: 'Plafond wijzen', active: S.sub === 'plafond', disabled: !ruimte },
      { id: 'i:h+', label: 'Hoogte +5 cm', disabled: !ruimte }, { id: 'i:h-', label: 'Hoogte −5 cm', disabled: !ruimte },
      { id: 'i:vloer', label: 'Vloer: ' + (VLOERTYPES[S.data?.gebouw?.vloer] || '—'), disabled: !ruimte }, { id: 'i:verw', label: 'Verw.: ' + (S.data?.gebouw?.verwarming || '—'), disabled: !ruimte },
      { id: 'i:ongedaan', label: 'Wis punten' }, { id: 'i:draai', label: 'Inrichting 180°', disabled: !ruimte }, { id: 'i:spiegel', label: 'Inrichting spiegelen', disabled: !ruimte });
    info += ruimte ? `Ruimte: ${S.data.ruimte.vloer.length} hoeken, hoogte ${S.data.ruimte.hoogte.toFixed(2)} m.\n` + (S.sub === 'ihoeken' ? `Wijs de vloerhoeken één voor één aan en druk de trekker (${S.punten.length} gezet). Daarna "Sluit vorm".` : S.sub === 'plafond' ? 'Wijs de hoek plafond–wand aan boven een vloerhoek en druk de trekker.' : 'Eerst kalibreren (zodat deur/schacht/lavabo goed liggen), dan inmeten.\n"Uit ruimte-scan" gebruikt de muren uit de Ruimte-instelling van de Quest.') : 'Inmeten werkt voor ruimte-projecten (niet voor IFC).';
  } else if (m === 'plaatsen') {
    for (const t of ['deur', 'raam', 'lavabo', 'radiator', 'stopcontact', 'schakelaar', 'lichtpunt', 'schacht', 'ventiel', 'rookmelder', 'kolom', 'naad']) acts.push({ id: 'p:' + t, label: t[0].toUpperCase() + t.slice(1), active: S.plaatsType === t, disabled: !ruimte });
    acts.push({ id: 'p:wis', label: 'Verwijder', active: S.plaatsType === 'wis', disabled: !ruimte });
    info += ruimte ? `Gekozen: ${S.plaatsType}. Wijs naar de echte plek in de kamer (muur, plafond of vloer) en druk de trekker.\nWat je plaatst geldt als BEVESTIGD; de app trekt de leidingen ernaartoe volgens het AREI.${S.plaatsType === 'schacht' ? '\nSchacht: tik twee tegenoverliggende hoeken op de vloer.' : ''}` : 'Plaatsen werkt voor ruimte-projecten.';
  } else if (m === 'snede') {
    acts.push({ id: 's:v', label: 'Verticaal', active: S.snede === 'v' }, { id: 's:h', label: 'Horizontaal', active: S.snede === 'h' }, { id: 's:vast', label: S.snedeVast ? 'Losmaken' : 'Vastzetten' }, { id: 's:uit', label: 'Uit' });
    info += 'Het snijvlak volgt je rechterhand. Trekker = vastzetten/losmaken.';
  } else if (m === 'meten') {
    acts.push({ id: 'm:wis', label: 'Wis meting' });
    info += 'Boorcheck: houd de witte punt tegen de muur — je ziet de afstand tot de dichtstbijzijnde leiding.\nTrekker = meetlint (2 punten).\n' + (S.meetInfo || '');
  } else if (m === 'notities') {
    for (const t of ['Opmerking', 'Scheur', 'Vochtvlek', 'Vraag', 'Foto nodig', 'OK']) acts.push({ id: 'n:' + t, label: t, active: S.notitieType === t });
    acts.push({ id: 'n:wis', label: 'Wis laatste' });
    info += `Trekker = pin "${S.notitieType}" op de witte punt. ${S.notities.length} notitie(s). Bewaard op dit toestel en mee geëxporteerd.`;
  } else if (m === 'fasen') {
    acts.push({ id: 'f:-', label: '◀ Vorige' }, { id: 'f:+', label: 'Volgende ▶' }, { id: 'f:0', label: 'Alles' });
    info += 'Fase: ' + FASEN[S.fase];
  } else if (m === 'presentatie') {
    acts.push({ id: 'pr:verberg', label: 'Menu verbergen' }, { id: 'labels', label: 'Labels', active: S.labels });
    info += 'Grote labels. Menu terug: knop Y (links) of B (rechts).';
  }
  panel.set({ acols: m === 'menu' && S.menuCat ? 2 : 4, title: S.data?.naam || 'AR-Bouw', status: S.kalBron ? 'uitgelijnd: ' + S.kalBron : 'niet uitgelijnd', statusKleur: S.kalBron ? '#5be38f' : '#ffb340', modes: MODES, activeMode: m, actions: acts, info, plan: m === 'kalibreren' && S.sub === 'hoeken' && ruimte ? { poly: S.data.ruimte.vloer, hl: S.punten.length } : null });
}
function kalibratieTekst() {
  const t = {
    deurkies: 'Staat de deur aan de verkeerde kant? Wijs met de straal de ONDERKANT van je echte deur (de drempel) aan en druk de trekker. De app draait het model dan zelf de juiste kant op.',
    hoeken: `Wijs vloerhoek ${S.punten.length + 1} van 2 aan (zie plannetje: oranje punt) en druk de trekker.`,
    qr: `Blad ${S.markerId}: raak met de witte punt het LINKER kruisje aan en druk de trekker, daarna het RECHTER. ${S.punten.length}/2.` + (S.punten.length >= 2 ? '\nOptioneel: tik nog punten op DEZELFDE muur, zo ver mogelijk van het blad (betere hoek). Dan "Klaar".' : ''),
    reg: `Registreren van blad ${S.markerId}: lijn het model eerst goed uit. Raak dan het LINKER en RECHTER kruisje aan. ${S.punten.length}/2.`,
  }[S.sub];
  return (t || 'Kies een methode. Grijpknop (zijkant) ingedrukt = model verslepen en draaien.\nLinker joystick = verschuiven, rechter joystick = draaien (links/rechts) en hoogte (op/neer).') + (S.markers.length ? `\nBekende bladen: ${S.markers.map(m => m.id).join(', ')}` : '\nNog geen bladen geregistreerd voor dit project.');
}
function startSub(sub) { S.sub = sub; S.punten = []; S.extraWand = []; puntenGroep.clear(); panelUpdate(); }

function onAction(id) {
  const [k, v] = id.split(':');
  S.panelMelding = '';
  if (k === 'menu') {
    const w = id.split(':')[2];
    if (v === 'cat') S.menuCat = w;
    else if (v === 'terug') S.menuCat = null;
    else if (v === 'proj') {
      const p = S.projecten[+w];
      if (p) openProject(p).then(() => {
        S.kalBron = null; S.autoGeprobeerd = false; S.autoTeller = 0; S.anchor = null;
        if (session) { zetStart(); S.mode = 'verkennen'; S.panelMelding = `${p.naam} geopend. ${p.soort === 'ruimte' ? 'De app lijnt automatisch uit op je ruimte-scan.' : 'Lijn uit met grijpen of een QR-blad (Kalibreren).'}`; }
        S.menuCat = null; panelUpdate();
      });
    }
    panelUpdate(); return;
  }
  if (k === 'mode') { S.mode = v; S.sub = null; S.punten = []; puntenGroep.clear(); if (v !== 'snede') { zetSnede(false); S.snede = null; } if (v === 'meten') S.meet.a = null; meetLijn.visible = false; if (meetLabel) meetLabel.visible = false; updateZichtbaarheid(); }
  else if (k === 'laag') { S.lagen[v] = !S.lagen[v]; updateZichtbaarheid(); }
  else if (id === 'labels') { S.labels = !S.labels; updateZichtbaarheid(); }
  else if (id === 'stop') { session?.end(); }
  else if (id === 'v:terug') { if (S.kalMatrix) { root.matrix.copy(S.kalMatrix); root.matrixWorldNeedsUpdate = true; S.verplaatst = false; S.panelMelding = 'Model terug op de uitgelijnde plaats.'; } }
  else if (k === 'k') {
    if (v === 'auto') pending.push((fr) => autoUitlijnen(fr, false));
    else if (v === 'deur') startSub('deurkies');
    else if (v === 'scan') { if (scanGroep.children.length) { scanGroep.clear(); S.scanInfo = null; } else pending.push((fr) => { toonScan(fr); panelUpdate(); }); }
    else if (v === 'hoeken' || v === 'qr' || v === 'reg') {
      if (v === 'qr' && !S.markers.find(m => m.id === S.markerId)) { S.panelMelding = `Blad ${S.markerId} is nog niet geregistreerd voor dit project. Lijn eerst uit (2 hoeken of grijpen) en kies "QR registreren".`; }
      else startSub(v);
    } else if (v === 'blad') { const n = (parseInt(S.markerId.slice(1)) % 8) + 1; S.markerId = 'M' + n; }
    else if (v === 'anchor') pending.push(bewaarAnchor);
    else if (v === 'midden') pending.push(middenHier);
    else if (v === 'draai') { const c = projMidden(); const T = new THREE.Matrix4().makeTranslation(c.x, 0, c.z).multiply(new THREE.Matrix4().makeRotationY(Math.PI / 2)).multiply(new THREE.Matrix4().makeTranslation(-c.x, 0, -c.z)); root.matrix.premultiply(T); root.matrixWorldNeedsUpdate = true; S.anchor = null; }
    else if (v === 'klaar') { if (S.sub === 'qr' && S.punten.length >= 2) rondQRaf(); S.sub = null; S.punten = []; puntenGroep.clear(); }
  } else if (k === 'i') {
    if (v === 'scan') pending.push(inmetenUitScan);
    else if (v === 'capture') { if (session?.initiateRoomCapture) session.initiateRoomCapture().catch(() => {}); else S.panelMelding = 'Ruimte-scan starten wordt door deze browser niet ondersteund. Doe het via Quest-instellingen › Fysieke ruimte › Ruimte-instelling.'; }
    else if (v === 'hoeken') startSub('ihoeken');
    else if (v === 'sluit') sluitVorm();
    else if (v === 'plafond') startSub('plafond');
    else if (v === 'h+' || v === 'h-') { S.data.ruimte.hoogte = +(S.data.ruimte.hoogte + (v === 'h+' ? 0.05 : -0.05)).toFixed(3); bewaarData(); bouwModel(); }
    else if (v === 'vloer') { const ks = Object.keys(VLOERTYPES); S.data.gebouw.vloer = ks[(ks.indexOf(S.data.gebouw.vloer) + 1) % ks.length]; bewaarData(); bouwModel(); }
    else if (v === 'verw') { const ks = ['vloer', 'radiator', 'geen']; S.data.gebouw.verwarming = ks[(ks.indexOf(S.data.gebouw.verwarming) + 1) % ks.length]; bewaarData(); bouwModel(); }
    else if (v === 'ongedaan') startSub(S.sub);
    else if (v === 'draai' || v === 'spiegel') { transformeerInrichting(v); }
  } else if (k === 'rg') {
    const st = RONDGANG[S.rg || 0];
    if (v === 'auto') pending.push((fr) => autoUitlijnen(fr, false));
    else if (v === 'deur') { S.sub = 'deurkies'; }
    else if (v === 'maten') pending.push(inmetenUitScan);
    else if (v === 'capture') { if (session?.initiateRoomCapture) session.initiateRoomCapture().catch(() => {}); }
    else if (v === 'toon') { if (scanGroep.children.length) { scanGroep.clear(); S.scanInfo = null; } else pending.push((fr) => { toonScan(fr); panelUpdate(); }); }
    else if (v === '+' || v === '-') {
      if (v === '+' && S.rg === RONDGANG.length - 1) { S.mode = 'verkennen'; S.panelMelding = 'Rondgang klaar ✓ Druk Stop AR en daarna "Stuur naar Claude" of "Exporteer project".'; }
      else { S.rg = Math.max(0, Math.min(RONDGANG.length - 1, (S.rg || 0) + (v === '+' ? 1 : -1))); }
      S.sub = null; S.punten = []; puntenGroep.clear(); S.plaatsType = RONDGANG[S.rg].type || 'stopcontact';
    } else if (v === 'ongedaan' && st.type) {
      const R = S.data.ruimte;
      for (const lijst of ['objecten', 'openingen']) { const i = R[lijst].map(o => o.type === st.type && o.bevestigd).lastIndexOf(true); if (i >= 0) { R[lijst].splice(i, 1); break; } }
      bewaarData(); bouwModel(); S.panelMelding = 'Laatste ' + st.titel.toLowerCase() + ' gewist.';
    }
  } else if (k === 'p') { if (v === 'wis') S.plaatsType = 'wis'; else S.plaatsType = v; S.punten = []; puntenGroep.clear(); }
  else if (k === 's') {
    if (v === 'uit') { S.snede = null; zetSnede(false); }
    else if (v === 'vast') S.snedeVast = !S.snedeVast;
    else { S.snede = v; S.snedeVast = false; zetSnede(true); }
  } else if (k === 'm') { S.meet.a = null; meetLijn.visible = false; puntenGroep.clear(); }
  else if (k === 'n') { if (v === 'wis') { S.notities.pop(); LS.set('notes:' + S.entry.id, S.notities); tekenNotities(); updateZichtbaarheid(); } else S.notitieType = v; }
  else if (k === 'f') { S.fase = v === '0' ? 0 : Math.max(0, Math.min(5, S.fase + (v === '+' ? 1 : -1))); $('fase').value = S.fase; $('faseNaam').textContent = FASEN[S.fase]; updateZichtbaarheid(); }
  else if (k === 'pr') { panel.mesh.visible = false; }
  panelUpdate();
}
const snedeVlak = new THREE.Plane(new THREE.Vector3(1, 0, 0), 0);
const pending = []; // acties die een XRFrame nodig hebben

function projMidden() {
  let c = V3();
  if (S.data?.soort === 'ruimte') { const [cx, cz] = polyCentroid(S.data.ruimte.vloer); c.set(cx, 0, cz); }
  return c.applyMatrix4(root.matrix);
}
function middenHier() {
  const cam = renderer.xr.getCamera(); const p = V3().setFromMatrixPosition(cam.matrixWorld);
  const d = V3(0, 0, -1).transformDirection(cam.matrixWorld); const yaw = Math.atan2(-d.z, d.x) - Math.PI / 2;
  let cx = 0, cz = 0; if (S.data.soort === 'ruimte') [cx, cz] = polyCentroid(S.data.ruimte.vloer);
  const M = new THREE.Matrix4().makeTranslation(p.x, S.floorY, p.z).multiply(new THREE.Matrix4().makeRotationY(yaw)).multiply(new THREE.Matrix4().makeTranslation(-cx, 0, -cz));
  zetKalibratie(M, 'midden hier (ruw)');
}
async function bewaarAnchor(frame) {
  if (!frame.createAnchor) { S.panelMelding = 'Anchors worden niet ondersteund in deze browser.'; panelUpdate(); return; }
  try {
    const p = V3(), q = new THREE.Quaternion(), s = V3(); root.matrix.decompose(p, q, s);
    const anchor = await frame.createAnchor(new XRRigidTransform({ x: p.x, y: p.y, z: p.z }, { x: q.x, y: q.y, z: q.z, w: q.w }), refSpace);
    if (anchor.requestPersistentHandle) {
      const oud = LS.get('anchor:' + S.entry.id);
      if (oud && session.deletePersistentAnchor) { try { await session.deletePersistentAnchor(oud); } catch { /* */ } }
      const uuid = await anchor.requestPersistentHandle(); LS.set('anchor:' + S.entry.id, uuid);
      S.panelMelding = 'Positie bewaard. Volgende keer laadt het model meteen op de juiste plek.';
    } else S.panelMelding = 'Positie bewaard voor deze sessie (blijvend bewaren niet ondersteund).';
    S.anchor = anchor;
  } catch (e) { S.panelMelding = 'Bewaren mislukt: ' + e.message; }
  panelUpdate();
}

// ---------- selecteren ----------
function onSelect(st) {
  if (!session) return;
  const rc = rayFrom(st);
  if (panel?.mesh.visible) { const h = panel.pick(rc); if (h.hit) { if (h.id) onAction(h.id); return; } }
  const tip = tipWorld(st, st.source?.hand ? 1 : 0);
  const M = S.mode;
  if (M === 'rondgang') {
    const st = RONDGANG[S.rg || 0];
    if (S.sub === 'deurkies') { const w = vloerHit(rc); if (w) { kiesViaDeur(w); S.sub = null; } }
    else if (st.type) { S.plaatsType = st.type; plaats(rc); }
    panelUpdate(); return;
  }
  if (M === 'kalibreren') {
    if (S.sub === 'deurkies') { const w = vloerHit(rc); if (w) { kiesViaDeur(w); startSub(null); } }
    else if (S.sub === 'hoeken') {
      const w = vloerHit(rc); if (!w) return; S.punten.push(w); toonPunt(w, 0xffb340);
      if (S.punten.length === 2) {
        const poly = S.data.ruimte.vloer, P = [V3(poly[0][0], 0, poly[0][1]), V3(poly[1][0], 0, poly[1][1])];
        const W = S.punten.map(p => V3(p.x, S.floorY, p.z));
        zetKalibratie(losKalibratie(P, W), '2 hoeken'); startSub(null);
      }
    } else if (S.sub === 'qr' || S.sub === 'reg') {
      if (S.punten.length < 2) { S.punten.push(tip); toonPunt(tip, S.punten.length === 1 ? 0x3ddc84 : 0xff3b30); }
      else { S.extraWand.push(tip); toonPunt(tip, 0xffffff); }
      if (S.sub === 'reg' && S.punten.length === 2) {
        const inv = rootInv(); const L = S.punten[0].clone().applyMatrix4(inv), R = S.punten[1].clone().applyMatrix4(inv);
        const m = { id: S.markerId, L: L.toArray(), R: R.toArray(), datum: new Date().toISOString() };
        S.markers = S.markers.filter(x => x.id !== m.id).concat(m);
        LS.set('markers:' + S.entry.id, S.markers.filter(x => x.datum));
        S.panelMelding = `Blad ${m.id} geregistreerd. Volgende keer: QR scannen → 2 kruisjes aantikken.`; startSub(null);
      } else if (S.sub === 'qr' && S.punten.length === 2 && !S.extraWand.length) rondQRaf(true);
      else if (S.sub === 'qr' && S.extraWand.length) rondQRaf(true);
    }
  } else if (M === 'inmeten') {
    if (S.sub === 'ihoeken') { const w = vloerHit(rc); if (w) { S.punten.push(w); toonPunt(w, 0xffb340); } }
    else if (S.sub === 'plafond') {
      // dichtste punt van de straal tot de verticale lijn boven de dichtste vloerhoek
      const inv = rootInv(); const poly = S.data.ruimte.vloer;
      let best = null; for (const [x, z] of poly) { const w = V3(x, 0, z).applyMatrix4(root.matrix); const d = rc.ray.distanceSqToPoint(V3(w.x, 1.5, w.z)); if (!best || d < best.d) best = { d, w }; }
      const line = new THREE.Ray(V3(best.w.x, 0, best.w.z), V3(0, 1, 0)); const pa = V3(), pb = V3();
      rc.ray.distanceSqToSegment(line.origin, V3(best.w.x, 5, best.w.z), pa, pb);
      const h = pb.clone().applyMatrix4(inv).y; if (h > 1.8 && h < 6) { S.data.ruimte.hoogte = +h.toFixed(3); bewaarData(); bouwModel(); S.panelMelding = `Plafondhoogte ${h.toFixed(2)} m`; }
      startSub(null);
    }
  } else if (M === 'plaatsen') plaats(rc);
  else if (M === 'snede') S.snedeVast = !S.snedeVast;
  else if (M === 'meten') {
    if (!S.meet.a) { S.meet.a = tip; puntenGroep.clear(); toonPunt(tip, 0xffffff); }
    else { const d = S.meet.a.distanceTo(tip); toonPunt(tip, 0xffffff); meetLijn.geometry.setFromPoints([S.meet.a, tip]); meetLijn.visible = true; S.meetInfo = `Meetlint: ${(d * 100).toFixed(1)} cm`; zetMeetLabel(`${(d * 100).toFixed(1)} cm`, S.meet.a.clone().add(tip).multiplyScalar(0.5)); S.meet.a = null; }
  } else if (M === 'notities') {
    const p = tip.clone().applyMatrix4(rootInv());
    S.notities.push({ p: p.toArray().map(v => +v.toFixed(3)), t: S.notitieType, d: new Date().toLocaleString('nl-BE') });
    LS.set('notes:' + S.entry.id, S.notities); tekenNotities(); updateZichtbaarheid();
  } else if (M === 'verkennen' && S.highlight) { S.hoverInfo = S.highlight.userData.naam + '\n' + S.highlight.userData.info; }
  panelUpdate();
}
function rondQRaf(auto) {
  const mk = S.markers.find(m => m.id === S.markerId); if (!mk) return;
  const P = [V3(...mk.L), V3(...mk.R)];
  zetKalibratie(losKalibratie(P, S.punten.slice(0, 2), S.extraWand), `QR ${mk.id}` + (S.extraWand.length ? ` + ${S.extraWand.length} wandpunt(en)` : ''));
  S.pendingMarker = null;
  if (auto) S.panelMelding = 'Uitgelijnd. Tik eventueel nog punten op dezelfde muur (ver van het blad) voor een nauwkeurigere hoek, of kies Klaar.';
}
function vloerHit(rc) {
  const pl = new THREE.Plane(V3(0, 1, 0), -S.floorY); const p = V3();
  return rc.ray.intersectPlane(pl, p) ? p : null;
}
/** Deur, ramen en toestellen 180° draaien of spiegelen binnen de (ingemeten) kamer. */
function transformeerInrichting(soort) {
  if (soort === 'draai' && S.data.status !== 'ingemeten') { onAction('k:draai'); onAction('k:draai'); S.panelMelding = 'Model 180° gedraaid.'; return; }
  const R = S.data.ruimte, xs = R.vloer.map(p => p[0]), zs = R.vloer.map(p => p[1]);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cz = (Math.min(...zs) + Math.max(...zs)) / 2;
  // spiegelen over de lange as van de kamer (links ↔ rechts als je door de deur kijkt)
  const langX = Math.max(...xs) - Math.min(...xs) >= Math.max(...zs) - Math.min(...zs);
  const f = soort === 'draai' ? (x, z) => [2 * cx - x, 2 * cz - z] : langX ? (x, z) => [x, 2 * cz - z] : (x, z) => [2 * cx - x, z];
  const r3 = v => +v.toFixed(3);
  for (const o of [...R.openingen, ...R.objecten]) {
    if (o.x0 != null) { const [a, b] = f(o.x0, o.z0), [c, d] = f(o.x1, o.z1); Object.assign(o, { x0: r3(a), z0: r3(b), x1: r3(c), z1: r3(d) }); }
    if (o.x != null) { const [a, b] = f(o.x, o.z); o.x = r3(a); o.z = r3(b); }
  }
  if (S.data.status !== 'ingemeten') {
    const n = R.vloer.length;
    R.vloer = R.vloer.map(([x, z]) => f(x, z).map(r3)).reverse();
    if (R.wanden) { const oud = R.wanden, nieuw = {}; for (let j = 0; j < n; j++) { const i = ((n - 2 - j) % n + n) % n; if (oud[i]) nieuw[j] = oud[i]; } R.wanden = nieuw; }
  }
  bewaarData(); bouwModel();
  S.panelMelding = soort === 'draai' ? 'Deur, raam en toestellen 180° gedraaid.' : 'Deur, raam en toestellen gespiegeld (links ↔ rechts).';
}
function sluitVorm() {
  if (S.punten.length < 3) return;
  const inv = rootInv();
  const poly = S.punten.map(p => { const q = V3(p.x, S.floorY, p.z).applyMatrix4(inv); return [+q.x.toFixed(3), +q.z.toFixed(3)]; });
  S.data.ruimte.vloer = poly; S.data.status = 'ingemeten'; delete S.data.ruimte.wanden;
  bewaarData(); bouwModel(); startSub(null); S.kalBron ||= 'inmeting';
  S.panelMelding = `Vorm bewaard (${poly.length} hoeken). Controleer deur/raam/schacht in "Plaatsen".`;
}

// ---------- inmeten uit de ruimte-scan van de Quest ----------
// ---------- automatisch uitlijnen op de ruimte-scan van de Quest ----------
/** Zoek rotatie + verschuiving die de modelvloer (projectkader) het best op de gescande vloer (wereld, xz) legt. */
export function pasVloerAan(model, scan, modelDeur = null, scanDeuren = []) {
  const cen = (P) => polyCentroid(P);
  const [mx, mz] = cen(model), [sx, sz] = cen(scan);
  const rand = (P) => P.map((p, i) => [p, P[(i + 1) % P.length]]);
  const dRand = (x, z, P) => { let d = Infinity; for (const [a, b] of rand(P)) { const dx = b[0] - a[0], dz = b[1] - a[1], L2 = dx * dx + dz * dz; let t = L2 ? ((x - a[0]) * dx + (z - a[1]) * dz) / L2 : 0; t = Math.max(0, Math.min(1, t)); d = Math.min(d, Math.hypot(x - a[0] - dx * t, z - a[1] - dz * t)); } return d; };
  const randen = rand(model).map(([a, b]) => ({ L: Math.hypot(b[0] - a[0], b[1] - a[1]), th: ang(b[0] - a[0], b[1] - a[1]) })).sort((p, q) => q.L - p.L);
  const thM = randen[0].th;
  const kand = new Set();
  for (const [a, b] of rand(scan)) { const th = ang(b[0] - a[0], b[1] - a[1]); for (const k of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) kand.add(+(th - thM + k).toFixed(4)); }
  // robuuste score: gemiddelde van de beste 70 % afstanden (een schachtkast die niet in de scan zit telt dan niet mee)
  const score = (M, ox = 0, oz = 0) => {
    const d = [];
    for (const [x, z] of M) d.push(dRand(x + ox, z + oz, scan));
    const Mo = M.map(([x, z]) => [x + ox, z + oz]);
    for (const [x, z] of scan) d.push(dRand(x, z, Mo));
    d.sort((p, q) => p - q); const k = Math.max(3, Math.ceil(d.length * 0.7));
    return d.slice(0, k).reduce((p, q) => p + q, 0) / k;
  };
  const lijst = [];
  for (const th of kand) {
    const c = Math.cos(th), sn = Math.sin(th);
    // rotatie rond Y (three.js): x' = x c + z s, z' = -x s + z c
    const tf = ([x, z]) => { const X = x - mx, Z = z - mz; return [X * c + Z * sn + sx, -X * sn + Z * c + sz]; };
    const M = model.map(tf);
    const sc0 = score(M);
    let sc = sc0;
    if (modelDeur && scanDeuren.length) { const [dx, dz] = tf(modelDeur); sc += 0.5 * Math.min(...scanDeuren.map(([x, z]) => Math.hypot(x - dx, z - dz))); }
    lijst.push({ sc, vorm: sc0, th, M });
  }
  // per kandidaat de verschuiving verfijnen (grof → fijn)
  const kandidaten = lijst.map(k => {
    let ox = 0, oz = 0, v0 = score(k.M);
    for (const stap of [0.2, 0.05, 0.01]) {
      let verbeterd = true;
      while (verbeterd) {
        verbeterd = false;
        for (const [dx, dz] of [[stap, 0], [-stap, 0], [0, stap], [0, -stap]]) { const v = score(k.M, ox + dx, oz + dz); if (v < v0 - 1e-6) { v0 = v; ox += dx; oz += dz; verbeterd = true; } }
      }
    }
    const M = new THREE.Matrix4().makeTranslation(sx + ox, 0, sz + oz).multiply(new THREE.Matrix4().makeRotationY(k.th)).multiply(new THREE.Matrix4().makeTranslation(-mx, 0, -mz));
    return { M, fout: v0, sc: k.sc - k.vorm + v0, theta: k.th };
  }).sort((a, b) => a.sc - b.sc);
  // dubbele hoeken weg
  const uniek = []; for (const k of kandidaten) if (!uniek.some(u => Math.abs(Math.atan2(Math.sin(u.theta - k.theta), Math.cos(u.theta - k.theta))) < 0.05)) uniek.push(k);
  return { ...uniek[0], kandidaten: uniek };
}
function scanUitFrame(frame) {
  const planes = frame.detectedPlanes; if (!planes || !planes.size) return null;
  let vloer = null; const deuren = [];
  for (const pl of planes) {
    const pose = frame.getPose(pl.planeSpace, refSpace); if (!pose) continue;
    const Mx = new THREE.Matrix4().fromArray(pose.transform.matrix);
    const pts = pl.polygon.map(p => V3(p.x, p.y, p.z).applyMatrix4(Mx));
    const lab = (pl.semanticLabel || '').toLowerCase();
    if (lab === 'floor' || (!lab && pl.orientation === 'horizontal' && (!vloer || pts[0].y < vloer.y))) {
      const area = Math.abs(polyAreaXZ(pts)); if (!vloer || lab === 'floor' || area > vloer.area) vloer = { pts, y: pts[0].y, area };
    } else if (lab.includes('door')) { const c = pts.reduce((a, p) => a.add(p), V3()).multiplyScalar(1 / pts.length); deuren.push([c.x, c.z]); }
  }
  return vloer ? { poly: vereenvoudig(vloer.pts.map(p => [p.x, p.z])), y: vloer.y, deuren } : null;
}
function autoUitlijnen(frame, stil) {
  if (S.data?.soort !== 'ruimte') return false;
  const sc = scanUitFrame(frame);
  if (!sc) { if (!stil) { S.panelMelding = 'Geen ruimte-scan gevonden. Stel eerst je ruimte in (Omgevingsinstellingen › Ruimteconfiguratie) en geef de site toegang tot je ruimtegegevens.'; panelUpdate(); } return false; }
  const deur = (S.data.ruimte.openingen || []).find(o => o.type === 'deur');
  const r = pasVloerAan(S.data.ruimte.vloer, sc.poly, deur ? [deur.x, deur.z] : null, sc.deuren);
  const opVloer = new THREE.Matrix4().makeTranslation(0, sc.y, 0);
  for (const k of r.kandidaten) k.M.premultiply(opVloer);
  S.floorY = sc.y;
  zetKalibratie(r.kandidaten[0].M, 'automatisch (ruimte-scan)');
  // even goede passingen (bv. een rechthoekige kamer 180° gedraaid) → laat de gebruiker de deur aanwijzen
  S.autoKand = r.kandidaten.filter(k => k.fout < r.kandidaten[0].fout + 0.12).slice(0, 4);
  const twijfel = S.autoKand.length > 1 && !sc.deuren.length;
  S.panelMelding = `Automatisch uitgelijnd op je ruimte-scan (afwijking ${(r.fout * 100).toFixed(0)} cm).`;
  if (twijfel) { if (S.mode !== 'rondgang') S.mode = 'kalibreren'; S.sub = 'deurkies'; S.punten = []; }
  else S.panelMelding += ' Enkel positie en richting aangepast; het model zelf blijft ongewijzigd.';
  toonScan(frame);
  panelUpdate();
  return true;
}
/** Kies de juiste richting door de echte deur aan te wijzen. */
function kiesViaDeur(p) {
  const deur = (S.data.ruimte.openingen || []).find(o => o.type === 'deur');
  if (!deur) { S.panelMelding = 'Er staat geen deur in het model.'; return; }
  let kand = S.autoKand;
  if (!kand || kand.length < 2) {
    // geen auto-kandidaten: huidige stand 0/90/180/270° draaien rond het kamermidden
    const [cx, cz] = polyCentroid(S.data.ruimte.vloer); const c = V3(cx, 0, cz).applyMatrix4(root.matrix);
    kand = [0, 1, 2, 3].map(i => ({ M: new THREE.Matrix4().makeTranslation(c.x, 0, c.z).multiply(new THREE.Matrix4().makeRotationY(i * Math.PI / 2)).multiply(new THREE.Matrix4().makeTranslation(-c.x, 0, -c.z)).multiply(root.matrix) }));
  }
  let best = null;
  for (const k of kand) { const d = V3(deur.x, 0, deur.z).applyMatrix4(k.M); const afst = Math.hypot(d.x - p.x, d.z - p.z); if (!best || afst < best.afst) best = { k, afst }; }
  zetKalibratie(best.k.M, 'automatisch + deur');

  S.autoKand = null;
  S.panelMelding = `Richting gekozen met de deur (deur ligt nu ${(best.afst * 100).toFixed(0)} cm van je aanwijspunt). Het model zelf blijft ongewijzigd.`;
}

// ---------- scan zichtbaar maken (controle) ----------
const scanGroep = new THREE.Group(); scanGroep.name = 'scan'; helpers.add(scanGroep);
const SCANKLEUR = { floor: 0x3ddc84, ceiling: 0x8cc4ff, wall: 0x00e5ff, 'door frame': 0xff2d55, 'window frame': 0xffd400 };
function toonScan(frame) {
  scanGroep.clear();
  const planes = frame?.detectedPlanes; S.scanInfo = null;
  if (!planes || !planes.size) { S.scanInfo = 'Scan: geen vlakken ontvangen (geef de site toegang tot je ruimtegegevens).'; return; }
  const tel = {};
  for (const pl of planes) {
    const pose = frame.getPose(pl.planeSpace, refSpace); if (!pose) continue;
    const Mx = new THREE.Matrix4().fromArray(pose.transform.matrix);
    const lab = (pl.semanticLabel || pl.orientation || '?').toLowerCase(); tel[lab] = (tel[lab] || 0) + 1;
    const pts = pl.polygon.map(p => V3(p.x, p.y, p.z).applyMatrix4(Mx)); if (pts.length < 2) continue;
    pts.push(pts[0].clone());
    const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: SCANKLEUR[lab] ?? 0xffffff, depthTest: false, transparent: true, opacity: 0.9 }));
    l.renderOrder = 997; scanGroep.add(l);
  }
  S.scanInfo = 'Scan: ' + Object.entries(tel).map(([k, v]) => `${v} ${k}`).join(', ') + ' (groen = vloer, cyaan = muren, rood = deur, geel = raam)';
}
function inmetenUitScan(frame) {
  const planes = frame.detectedPlanes;
  if (!planes || !planes.size) { S.panelMelding = 'Geen ruimte-scan gevonden. Kies "Scan opnieuw" of stel je ruimte in via de Quest-instellingen (Fysieke ruimte › Ruimte-instelling).'; panelUpdate(); return; }
  const wereld = (pl) => { const pose = frame.getPose(pl.planeSpace, refSpace); if (!pose) return null; const M = new THREE.Matrix4().fromArray(pose.transform.matrix); return { M, pts: pl.polygon.map(p => V3(p.x, p.y, p.z).applyMatrix4(M)) }; };
  let vloer = null, plafond = null; const deuren = [], ramen = [];
  for (const pl of planes) {
    const lab = (pl.semanticLabel || '').toLowerCase(); const w = wereld(pl); if (!w) continue;
    const area = Math.abs(polyAreaXZ(w.pts));
    if (pl.orientation === 'horizontal' || lab === 'floor' || lab === 'ceiling') {
      const y = w.pts[0].y;
      if (lab === 'floor' || (!lab && (!vloer || y < vloer.y))) { if (!vloer || lab === 'floor' || area > vloer.area) vloer = { ...w, y, area }; }
      if (lab === 'ceiling' || (!lab && (!plafond || y > plafond.y))) plafond = { ...w, y };
    } else if (lab.includes('door')) deuren.push(w); else if (lab.includes('window')) ramen.push(w);
  }
  if (!vloer) { S.panelMelding = 'Geen vloervlak in de scan gevonden.'; panelUpdate(); return; }
  S.floorY = vloer.y;
  // projectkader: als er nog geen kalibratie is, zet project op de vloer met wand 0 langs de eerste rand
  if (!S.kalBron) {
    const a = vloer.pts[0], b = vloer.pts[1]; const th = ang(b.x - a.x, b.z - a.z);
    root.matrix.makeTranslation(a.x, vloer.y, a.z).multiply(new THREE.Matrix4().makeRotationY(th)); root.matrixWorldNeedsUpdate = true; S.kalBron = 'ruimte-scan';
  } else { const t = V3().setFromMatrixPosition(root.matrix); root.matrix.setPosition(t.x, vloer.y, t.z); root.matrixWorldNeedsUpdate = true; }
  const inv = rootInv();
  let poly = vloer.pts.map(p => { const q = p.clone().applyMatrix4(inv); return [q.x, q.z]; });
  poly = vereenvoudig(poly);
  // rechttrekken: langste muur evenwijdig met de assen van het model, hoeken haaks (binnen 12°)
  const rt = rechtTrekken(poly);
  if (rt) {
    const c = V3(rt.cx, 0, rt.cz);
    // wereld ongewijzigd laten: root' = root · R(δ rond c)
    root.matrix.multiply(new THREE.Matrix4().makeTranslation(c.x, 0, c.z).multiply(new THREE.Matrix4().makeRotationY(rt.delta)).multiply(new THREE.Matrix4().makeTranslation(-c.x, 0, -c.z)));
    root.matrixWorldNeedsUpdate = true; S.kalMatrix = root.matrix.clone();
    poly = rt.poly; inv.copy(rootInv());
  }
  poly = poly.map(([x, z]) => [+x.toFixed(3), +z.toFixed(3)]);
  const R = S.data.ruimte; R.vloer = poly; delete R.wanden; // wandindices horen bij de oude vorm
  // volledige ruimteconfiguratie meebewaren (alle vlakken in projectcoördinaten) voor analyse/export
  const ruw = [];
  for (const pl of planes) { const w = wereld(pl); if (!w) continue; ruw.push({ label: pl.semanticLabel || '', orientatie: pl.orientation, punten: w.pts.map(p => p.clone().applyMatrix4(inv).toArray().map(v => +v.toFixed(3))) }); }
  S.data.ruimteconfiguratie = { datum: new Date().toISOString(), bron: 'Quest ruimte-instelling (WebXR plane-detection)', vlakken: ruw };
  if (plafond) R.hoogte = +(plafond.y - vloer.y).toFixed(3);
  const naarOpening = (w, type) => {
    const xs = w.pts.map(p => p.clone().applyMatrix4(inv)); const c = xs.reduce((s, p) => s.add(p), V3()).multiplyScalar(1 / xs.length);
    const ys = xs.map(p => p.y), h = Math.max(...ys) - Math.min(...ys);
    let br = 0; for (const p of xs) for (const q of xs) br = Math.max(br, Math.hypot(p.x - q.x, p.z - q.z));
    return { type, x: +c.x.toFixed(3), z: +c.z.toFixed(3), breedte: +br.toFixed(3), hoogte: +h.toFixed(3), borstwering: +Math.max(0, Math.min(...ys)).toFixed(3), bevestigd: true };
  };
  if (deuren.length || ramen.length) R.openingen = [...deuren.map(w => naarOpening(w, 'deur')), ...ramen.map(w => naarOpening(w, 'raam'))];
  S.data.status = 'ingemeten'; bewaarData(); bouwModel();
  if (window.AR_CFG?.artifact) stuurNaarClaude(true).then(ok => { if (ok) { S.panelMelding += '\n✔ Automatisch doorgestuurd naar Claude.'; panelUpdate(); } });
  S.panelMelding = `Ruimte-scan gebruikt: ${poly.length} hoeken, hoogte ${R.hoogte.toFixed(2)} m, ${deuren.length} deur(en), ${ramen.length} ra(a)m(en). Controleer schacht/lavabo in "Plaatsen".`;
  panelUpdate();
}
/** Draait een (bijna) rechthoekige vloer recht op de modelassen en maakt de hoeken haaks. */
function rechtTrekken(poly) {
  if (poly.length < 4) return null;
  let best = null;
  for (let i = 0; i < poly.length; i++) { const a = poly[i], b = poly[(i + 1) % poly.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (!best || L > best.L) best = { L, th: ang(b[0] - a[0], b[1] - a[1]) }; }
  const q = Math.PI / 2, delta = best.th - Math.round(best.th / q) * q;
  const [cx, cz] = polyCentroid(poly);
  const c = Math.cos(-delta), s = Math.sin(-delta);
  // draai -δ rond het midden (zelfde conventie als makeRotationY)
  const rot = poly.map(([x, z]) => { const X = x - cx, Z = z - cz; return [X * c + Z * s + cx, -X * s + Z * c + cz]; });
  // elke rand: horizontaal (langs x) of verticaal (langs z)?
  const randen = rot.map((a, i) => { const b = rot[(i + 1) % rot.length], dx = b[0] - a[0], dz = b[1] - a[1]; const hoek = Math.abs(Math.atan2(dz, dx)) % Math.PI; const h = Math.min(hoek, Math.PI - hoek) < 0.21, v = Math.abs(hoek - Math.PI / 2) < 0.21; return { a, b, h, v }; });
  if (randen.some(r => !r.h && !r.v)) return { poly: rot, delta, cx, cz }; // niet rechthoekig: enkel draaien
  // opeenvolgende randen met dezelfde richting samenvoegen
  const lijn = []; for (const r of randen) { const vorig = lijn[lijn.length - 1]; if (vorig && vorig.h === r.h) { vorig.b = r.b; vorig.pts.push(r.b); } else lijn.push({ ...r, pts: [r.a, r.b] }); }
  if (lijn.length > 1 && lijn[0].h === lijn[lijn.length - 1].h) { const l = lijn.pop(); lijn[0].pts.unshift(...l.pts); }
  for (const l of lijn) l.w = l.pts.reduce((t, p) => t + (l.h ? p[1] : p[0]), 0) / l.pts.length;
  const uit = lijn.map((l, i) => { const vorige = lijn[(i - 1 + lijn.length) % lijn.length]; return l.h ? [vorige.w, l.w] : [l.w, vorige.w]; });
  return uit.length >= 4 ? { poly: uit, delta, cx, cz } : { poly: rot, delta, cx, cz };
}
function polyAreaXZ(pts) { let a = 0; for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; a += p.x * q.z - q.x * p.z; } return a / 2; }
function vereenvoudig(poly) {
  // verwijder (bijna) collineaire punten en zeer korte randen
  let out = poly.slice();
  for (let it = 0; it < 3; it++) {
    const r = [];
    for (let i = 0; i < out.length; i++) {
      const a = out[(i - 1 + out.length) % out.length], b = out[i], c = out[(i + 1) % out.length];
      const ab = Math.hypot(b[0] - a[0], b[1] - a[1]), bc = Math.hypot(c[0] - b[0], c[1] - b[1]);
      const cross = Math.abs((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0])) / Math.max(1e-6, ab * bc);
      if (ab < 0.08 || cross < 0.05) continue; r.push(b);
    }
    if (r.length >= 3) out = r;
  }
  return out;
}

// ---------- plaatsen van elementen ----------
function wandVlakken() {
  // onzichtbare vlakken (projectkader) voor wand/plafond/vloer-hits
  const g = new THREE.Group(); const R = S.data.ruimte, poly = R.vloer, H = R.hoogte;
  const mat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length]; const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(L, H), mat); m.position.set((a[0] + b[0]) / 2, H / 2, (a[1] + b[1]) / 2); m.rotation.y = Math.atan2(-(b[1] - a[1]), b[0] - a[0]); m.userData.soort = 'wand'; g.add(m);
  }
  const shape = new THREE.Shape(poly.map(([x, z]) => new THREE.Vector2(x, -z)));
  const pf = new THREE.Mesh(new THREE.ShapeGeometry(shape), mat); pf.rotation.x = -Math.PI / 2; pf.position.y = H; pf.userData.soort = 'plafond'; g.add(pf);
  const vl = new THREE.Mesh(new THREE.ShapeGeometry(shape), mat); vl.rotation.x = -Math.PI / 2; vl.userData.soort = 'vloer'; g.add(vl);
  g.visible = true; g.traverse(o => { o.visible = true; }); mat.visible = false;
  root.add(g); g.updateMatrixWorld(true);
  return g;
}
function plaats(rc) {
  if (S.data?.soort !== 'ruimte') return;
  const g = wandVlakken(); root.updateMatrixWorld(true);
  const hits = rc.intersectObjects(g.children, false); root.remove(g);
  const h = hits[0]; if (!h) return;
  const p = h.point.clone().applyMatrix4(rootInv()); const soort = h.object.userData.soort;
  const R = S.data.ruimte, t = S.plaatsType, r3 = v => +v.toFixed(3);
  if (t === 'wis') {
    let best = null; const all = [...R.openingen.map(o => ['o', o]), ...R.objecten.map(o => ['b', o])];
    for (const [k, o] of all) { const ox = o.x ?? (o.x0 + o.x1) / 2, oz = o.z ?? (o.z0 + o.z1) / 2; const d = Math.hypot(ox - p.x, oz - p.z) + Math.abs((o.y ?? p.y) - p.y) * 0.5; if (!best || d < best.d) best = { d, k, o }; }
    if (best && best.d < 0.8) { if (best.k === 'o') R.openingen = R.openingen.filter(o => o !== best.o); else R.objecten = R.objecten.filter(o => o !== best.o); S.panelMelding = 'Verwijderd: ' + best.o.type; }
  } else if (t === 'deur' || t === 'raam') {
    if (soort !== 'wand') { S.panelMelding = 'Wijs naar een muur.'; return; }
    R.openingen.push(t === 'deur' ? { type: 'deur', x: r3(p.x), z: r3(p.z), breedte: 0.93, hoogte: 2.11, bevestigd: true } : { type: 'raam', x: r3(p.x), z: r3(p.z), breedte: 1.2, hoogte: 1.3, borstwering: r3(Math.max(0, p.y - 0.65)), bevestigd: true });
  } else if (t === 'schacht') {
    if (soort !== 'vloer') { S.panelMelding = 'Tik twee hoeken van de schacht op de vloer.'; return; }
    S.punten.push(p); toonPunt(h.point, 0xffb340);
    if (S.punten.length < 2) { S.panelMelding = 'Nu de tegenoverliggende hoek.'; return; }
    const [a, b] = S.punten; R.objecten = R.objecten.filter(o => o.type !== 'schacht');
    R.objecten.push({ type: 'schacht', x0: r3(a.x), z0: r3(a.z), x1: r3(b.x), z1: r3(b.z), bevestigd: true }); S.punten = []; puntenGroep.clear();
  } else if (t === 'ventiel') {
    if (soort !== 'wand' && soort !== 'plafond') { S.panelMelding = 'Wijs naar een ventiel of rooster op de muur of het plafond.'; return; }
    R.objecten.push({ type: 'ventiel', x: r3(p.x), z: r3(p.z), y: r3(Math.min(p.y, R.hoogte - 0.05)), bevestigd: true });
  } else if (t === 'rookmelder') {
    if (soort !== 'plafond') { S.panelMelding = 'Wijs naar de rookmelder op het plafond.'; return; }
    R.objecten = R.objecten.filter(o => o.type !== 'rookmelder');
    R.objecten.push({ type: 'rookmelder', x: r3(p.x), z: r3(p.z), bevestigd: true });
  } else if (t === 'kolom') {
    if (soort !== 'vloer') { S.panelMelding = 'Wijs de voet van de kolom op de vloer aan.'; return; }
    R.objecten.push({ type: 'kolom', x: r3(p.x), z: r3(p.z), breedte: 0.2, bevestigd: true });
  } else if (t === 'naad') {
    if (soort !== 'plafond') { S.panelMelding = 'Wijs een punt op een plafondnaad aan.'; return; }
    S.punten.push(p); toonPunt(h.point, 0xffb340);
    if (S.punten.length < 2) { S.panelMelding = 'Nu het andere uiteinde van dezelfde naad.'; return; }
    const [a, b] = S.punten; S.punten = []; puntenGroep.clear();
    let dx = b.x - a.x, dz = b.z - a.z; const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
    const poly = R.vloer; let lw = null;
    for (let i = 0; i < poly.length; i++) { const q = poly[i], w = poly[(i + 1) % poly.length], len = Math.hypot(w[0] - q[0], w[1] - q[1]); if (!lw || len > lw.len) lw = { len, x: (w[0] - q[0]) / len, z: (w[1] - q[1]) / len }; }
    const lang = Math.abs(dx * lw.x + dz * lw.z) > 0.7;
    S.data.gebouw.draagrichting = lang ? 'lang' : 'kort';
    if (!S.data.gebouw.vloer || S.data.gebouw.vloer === 'onbekend') S.data.gebouw.vloer = 'welfsels';
    S.panelMelding = `Naad loopt in de ${lang ? 'lengte' : 'breedte'} van de kamer → de vloer overspant ${lang ? 'de lange' : 'de korte'} richting.`;
  } else if (t === 'lichtpunt') {
    R.objecten = R.objecten.filter(o => !(o.type === 'lichtpunt' && Math.hypot(o.x - p.x, o.z - p.z) < 0.3));
    R.objecten.push({ type: 'lichtpunt', x: r3(p.x), z: r3(p.z), bevestigd: true });
  } else {
    if (soort !== 'wand') { S.panelMelding = 'Wijs naar een muur.'; return; }
    const o = { type: t, x: r3(p.x), z: r3(p.z), bevestigd: true };
    if (t === 'stopcontact' || t === 'schakelaar') o.y = r3(p.y);
    if (t === 'lavabo') R.objecten = R.objecten.filter(x => x.type !== 'lavabo');
    R.objecten.push(o);
  }
  bewaarData(); bouwModel();
  S.panelMelding = (S.panelMelding || `${t} geplaatst`) + ' — model herberekend.';
}

// ---------- grijpen ----------
function startGrab(st) {
  if (!session) return;
  const m = st.c.matrixWorld; const p = V3().setFromMatrixPosition(m); const d = V3(0, 0, -1).transformDirection(m);
  st.grab = { p0: p, yaw0: Math.atan2(-d.z, d.x), M0: root.matrix.clone() };
  S.anchor = null;
}
function updateGrab(st) {
  const m = st.c.matrixWorld; const p = V3().setFromMatrixPosition(m); const d = V3(0, 0, -1).transformDirection(m);
  const dyaw = Math.atan2(-d.z, d.x) - st.grab.yaw0;
  const T = new THREE.Matrix4().makeTranslation(p.x, 0, p.z).multiply(new THREE.Matrix4().makeRotationY(dyaw)).multiply(new THREE.Matrix4().makeTranslation(-st.grab.p0.x, 0, -st.grab.p0.z));
  root.matrix.copy(T.multiply(st.grab.M0)); root.matrixWorldNeedsUpdate = true; S.kalBron = 'handmatig';
}

// ---------------- render-lus ----------------
const clock = new THREE.Clock();
let lastHover = null, knopVorig = {};
function loop(t, frame) {
  const dt = Math.min(0.05, clock.getDelta());
  if (renderer.xr.isPresenting && frame) xrUpdate(frame, dt);
  else controls.update();
  renderer.render(scene, camera);
}
function xrUpdate(frame, dt) {
  while (pending.length) { const f = pending.shift(); try { f(frame); } catch (e) { console.error(e); } }
  // anchor volgen
  if (S.anchor) { const pose = frame.getPose(S.anchor.anchorSpace, refSpace); if (pose) { root.matrix.fromArray(pose.transform.matrix); root.matrixWorldNeedsUpdate = true; S.kalBron ||= 'bewaarde positie'; } }
  // automatisch uitlijnen zodra de ruimte-scan binnen is (één keer per sessie, als er nog geen positie is)
  // automatisch uitlijnen op de ruimte-scan (één keer, zodra de vlakken binnen zijn) + echte maten overnemen
  if (!S.kalBron && !S.anchor && !S.autoGeprobeerd && S.data?.soort === 'ruimte' && frame.detectedPlanes?.size) {
    S.autoTeller = (S.autoTeller || 0) + 1;
    if (S.autoTeller > 30) { S.autoGeprobeerd = true; autoUitlijnen(frame, true); }
  }
  // diagnose: na ±3 s melden of de ruimte-scan wel binnenkomt
  if (!S.diagGemeld && S.diagStart && performance.now() - S.diagStart > 4000 && !S.kalBron) {
    S.diagGemeld = true;
    const n = frame.detectedPlanes?.size || 0;
    S.panelMelding = n ? `Ruimte-scan ontvangen (${n} vlakken), maar nog niet uitgelijnd: kies Kalibreren › Automatisch.`
      : 'GEEN ruimte-scan ontvangen. De site heeft geen toegang tot je ruimtegegevens, of de Ruimteconfiguratie ontbreekt. Oplossing: Stop AR, tik in de browser op het slotje naast het adres › Machtigingen › "Ruimtelijke gegevens" toestaan, en start AR opnieuw. Tot dan: Kalibreren › 2 hoeken of grijpen.';
    panelUpdate();
  }
  // vloerhoogte uit scan
  if (frame.detectedPlanes && !S.floorScan) { for (const pl of frame.detectedPlanes) if ((pl.semanticLabel || '') === 'floor') { const pose = frame.getPose(pl.planeSpace, refSpace); if (pose) { S.floorY = pose.transform.position.y; S.floorScan = true; } } }
  const cam = renderer.xr.getCamera(); const camPos = V3().setFromMatrixPosition(cam.matrixWorld);
  const L = links(), R = rechts();
  // paneel
  if (panel && !S.panelVrij) {
    if (L && L.source && !L.source.hand) { const p = V3().setFromMatrixPosition(L.grip.matrixWorld); panel.mesh.position.copy(p).add(V3(0, 0.17, 0)).lerp(camPos, 0.12); panel.mesh.lookAt(camPos); }
    else if (L && L.source?.hand) { const w = L.hand.joints?.wrist; if (w) { const p = w.getWorldPosition(V3()); panel.mesh.position.copy(p).add(V3(0, 0.2, 0)).lerp(camPos, 0.15); panel.mesh.lookAt(camPos); } }
    else if (!panel.placed) { const d = V3(0, 0, -1).transformDirection(cam.matrixWorld).setY(0).normalize(); panel.mesh.position.copy(camPos).addScaledVector(d, 0.6).add(V3(0, -0.15, 0)); panel.mesh.lookAt(camPos); panel.placed = true; }
  }
  // knoppen (Y/B = menu tonen/verbergen)
  for (const st of ctrls) {
    const gp = st.source?.gamepad; if (!gp) continue;
    const b5 = gp.buttons[5]?.pressed; const k = st.i + ':5';
    if (b5 && !knopVorig[k] && panel) { panel.mesh.visible = !panel.mesh.visible || S.mode === 'presentatie' ? true : false; if (st !== L) { panel.placed = false; S.panelVrij = !L; } }
    knopVorig[k] = b5;
    if (st.grab) updateGrab(st);
  }
  // wandelen met de joysticks (het model schuift onder je door): links = verplaatsen, rechts = 30° draaien
  if (['verkennen', 'presentatie', 'fasen', 'meten', 'snede', 'notities'].includes(S.mode)) {
    const gl = L?.source?.gamepad, gr = R?.source?.gamepad;
    const ax = (gp, i) => { const v = gp?.axes?.[i] || 0; return Math.abs(v) < 0.2 ? 0 : v; };
    const lx = ax(gl, 2), ly = ax(gl, 3), rx = ax(gr, 2);
    if (lx || ly) {
      const fwd = V3(0, 0, -1).transformDirection(cam.matrixWorld).setY(0).normalize(), rgt = V3().crossVectors(fwd, V3(0, 1, 0));
      const mv = V3().addScaledVector(rgt, -lx).addScaledVector(fwd, ly).multiplyScalar(1.2 * dt);
      root.matrix.premultiply(new THREE.Matrix4().makeTranslation(mv.x, 0, mv.z)); root.matrixWorldNeedsUpdate = true; S.anchor = null; if (!S.verplaatst) { S.verplaatst = true; panelUpdate(); }
    }
    if (Math.abs(rx) > 0.6 && !S.draaiVast) {
      S.draaiVast = true;
      const a = (rx > 0 ? -1 : 1) * Math.PI / 6;
      const T = new THREE.Matrix4().makeTranslation(camPos.x, 0, camPos.z).multiply(new THREE.Matrix4().makeRotationY(a)).multiply(new THREE.Matrix4().makeTranslation(-camPos.x, 0, -camPos.z));
      root.matrix.premultiply(T); root.matrixWorldNeedsUpdate = true; S.anchor = null; if (!S.verplaatst) { S.verplaatst = true; panelUpdate(); }
    } else if (Math.abs(rx) < 0.3) S.draaiVast = false;
  }
  // joysticks in kalibreren
  if (S.mode === 'kalibreren') {
    const fwd = V3(0, 0, -1).transformDirection(cam.matrixWorld).setY(0).normalize(), rgt = V3().crossVectors(fwd, V3(0, 1, 0));
    const gl = L?.source?.gamepad, gr = R?.source?.gamepad;
    const ax = (gp, i) => { const v = gp?.axes?.[i] || 0; return Math.abs(v) < 0.15 ? 0 : Math.sign(v) * v * v; };
    const mv = V3().addScaledVector(rgt, ax(gl, 2)).addScaledVector(fwd, -ax(gl, 3)).multiplyScalar(0.15 * dt);
    const rot = -ax(gr, 2) * 0.35 * dt, up = -ax(gr, 3) * 0.1 * dt;
    if (mv.lengthSq() || rot || up) {
      const c = projMidden();
      const T = new THREE.Matrix4().makeTranslation(mv.x, up, mv.z).multiply(new THREE.Matrix4().makeTranslation(c.x, 0, c.z)).multiply(new THREE.Matrix4().makeRotationY(rot)).multiply(new THREE.Matrix4().makeTranslation(-c.x, 0, -c.z));
      root.matrix.premultiply(T); root.matrixWorldNeedsUpdate = true; S.anchor = null; S.kalBron = 'handmatig';
    }
  }
  for (const st of ctrls) controllersBovenop(st);
  // tip-geschiedenis (handen: positie vóór de knijpbeweging)
  for (const st of ctrls) if (st.source?.hand) { st.lastTip.push(tipWorld(st)); if (st.lastTip.length > 12) st.lastTip.shift(); }
  if (!R) return;
  const rc = rayFrom(R);
  let opPaneel = false;
  if (panel?.mesh.visible) { const h = panel.pick(rc); opPaneel = h.hit; R.lijn.scale.z = h.hit ? rc.ray.origin.distanceTo(h.point) : 3; }
  reticle.visible = false;
  const M = S.mode;
  if (!opPaneel && ((M === 'kalibreren' && (S.sub === 'hoeken' || S.sub === 'deurkies')) || (M === 'rondgang' && (S.sub === 'deurkies' || ['schacht', 'kolom'].includes(RONDGANG[S.rg || 0].type))) || (M === 'inmeten' && S.sub === 'ihoeken') || (M === 'plaatsen' && S.plaatsType === 'schacht'))) {
    const p = vloerHit(rc); if (p) { reticle.position.copy(p); reticle.visible = true; }
  }
  if (M === 'verkennen' && !opPaneel) {
    root.updateMatrixWorld(true);
    const h = pickVisible(rc); const obj = h?.object || null;
    if (obj !== lastHover) { lastHover = obj; setHighlight(obj); S.hoverInfo = obj ? obj.userData.naam + '\n' + obj.userData.info : null; panelUpdate(); }
  } else if (lastHover) { lastHover = null; setHighlight(null); }
  if (M === 'snede' && S.snede && !S.snedeVast) {
    const p = tipWorld(R), d = V3(0, 0, -1).transformDirection(R.c.matrixWorld);
    if (S.snede === 'h') snedeVlak.setFromNormalAndCoplanarPoint(V3(0, -1, 0), p);
    else snedeVlak.setFromNormalAndCoplanarPoint(d.setY(0).normalize(), p);
  }
  if (M === 'meten' && S.model?.leidingen?.length) {
    const tip = tipWorld(R); const tp = tip.clone().applyMatrix4(rootInv());
    let best = null; for (const l of S.model.leidingen) { if (S.lagen[l.laag] === false) continue; const r = distToPolyline(tp, l.pts); if (!best || r.d < best.d) best = { ...r, l }; }
    if (best) {
      const q = best.q.clone().applyMatrix4(root.matrix);
      if (!S.meet.a) { meetLijn.geometry.setFromPoints([tip, q]); meetLijn.visible = true; }
      const cm = best.d * 100, kl = cm < 5 ? '#ff3b30' : cm < 15 ? '#ffb340' : '#3ddc84';
      meetLijn.material.color.set(kl);
      zetMeetLabel(`${best.l.naam}: ${cm.toFixed(0)} cm${cm < 5 ? ' — NIET BOREN' : ''}`, tip.clone().add(V3(0, 0.06, 0)), kl);
    }
  }
}

// ---------------- 2D-knoppen ----------------
$('btnAR').onclick = () => {
  if (!S.data) { melding('Kies eerst een project.'); return; }
  startAR(); // altijd proberen: in een ingesloten pagina meldt de browser soms ten onrechte "niet ondersteund"
};
$('btnQR').onclick = async () => {
  $('qrModal').style.display = 'flex'; $('qrMsg').textContent = '';
  const stop = await startScan($('qrVideo'), async ({ p, m }) => {
    $('qrModal').style.display = 'none';
    await kiesViaQR(p, m);
  }, (msg) => { $('qrMsg').textContent = msg; });
  $('qrStop').onclick = () => { stop(); $('qrModal').style.display = 'none'; };
};
async function kiesViaQR(p, m) {
  const e = S.projecten.find(x => x.id === p);
  if (!e) { melding(`Project "${p}" niet gevonden op deze site.`, 5000); return; }
  await openProject(e);
  if (m) { S.pendingMarker = m; S.markerId = m; melding(`QR herkend: ${e.naam}, blad ${m}. Druk Start AR en tik de twee kruisjes aan.`, 8000); }
}
$('btnBladen').onclick = () => { if (!S.entry) return melding('Kies eerst een project.'); open(`qr.html?p=${encodeURIComponent(S.entry.id)}&naam=${encodeURIComponent(S.data?.naam || S.entry.id)}`, '_blank'); };
async function stuurNaarClaude(stil = false) {
  if (!S.data) return false;
  const out = JSON.parse(JSON.stringify({ ...S.data, markers: S.markers, notities: S.notities, export: { app: 'AR-Bouw ' + VERSIE, datum: new Date().toISOString(), toestel: navigator.userAgent.slice(0, 120) } }));
  try {
    const db = await window.claude?.use?.('db');
    if (!db) { if (!stil) melding('Doorsturen niet beschikbaar in deze weergave (meld je aan op claude.ai).', 6000); return false; }
    const sid = S.entry.id.replace(/[^\w-]/g, '_');
    await db.doc('scans/' + sid).set(out);
    const plan = await IDB.get('plan:' + S.entry.id), fotos = (await IDB.get('fotos:' + S.entry.id)) || [];
    let nm = 0;
    if (plan) { try { await db.doc('media/' + sid + '-plan').set({ project: sid, soort: 'plan', data: plan }); nm++; } catch (e) { console.warn('plan te groot', e); } }
    for (let i = 0; i < fotos.length; i++) { try { await db.doc('media/' + sid + '-foto-' + (i + 1)).set({ project: sid, soort: 'foto', nr: i + 1, data: fotos[i] }); nm++; } catch (e) { console.warn('foto te groot', e); } }
    if (nm) out.export.media = nm;
    melding('Doorgestuurd naar Claude ✓ — zeg in het gesprek dat de scan klaar is.', 7000);
    return true;
  } catch (e) { if (!stil) melding('Doorsturen mislukt: ' + (e.message || e.code || e), 7000); return false; }
}
$('btnExport').onclick = () => {
  if (!S.data) return;
  if (window.AR_CFG?.artifact) { stuurNaarClaude(); return; }
  const out = { ...S.data, markers: S.markers, notities: S.notities, export: { app: 'AR-Bouw ' + VERSIE, datum: new Date().toISOString() } };
  const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = (S.entry.id.replace(/[^\w-]/g, '_')) + '.json'; a.click();
  melding('Bestand gedownload. Stuur het door of zet het in de map projecten/ op GitHub.', 5000);
};
$('btnReset').onclick = () => {
  if (!S.entry) return;
  for (const k of ['proj:', 'markers:', 'notes:', 'anchor:']) LS.del(k + S.entry.id);
  melding('Lokale wijzigingen gewist.'); openProject(S.entry);
};
$('frmNieuw').onsubmit = (ev) => {
  ev.preventDefault();
  const naam = $('nwNaam').value.trim(); if (!naam) return;
  $('nwNaam').value = '';
  const id = 'lok-' + naam.toLowerCase().replace(/[^\w]+/g, '-').slice(0, 30) + '-' + Date.now().toString(36).slice(-4);
  const d = { id, naam, soort: 'ruimte', status: 'aanname', beschrijving: 'Eigen project — vul de projectfiche in en doe de rondgang met de bril (Start AR › Rondgang).', info: { functie: $('nwFunctie').value }, gebouw: { vloer: 'onbekend', verwarming: 'radiator', ventilatie: 'C' }, ruimte: { vloer: [[0, 0], [4, 0], [4, 3], [0, 3]], hoogte: 2.6, openingen: [{ type: 'deur', x: 0, z: 0.8 }], objecten: [] }, markers: [] };
  LS.set('proj:' + id, d); LS.set('lokaal', [...LS.get('lokaal', []), id]);
  const e = { id, naam, soort: 'ruimte', bron: 'lokaal', basis: d }; S.projecten.push(e); openProject(e);
  melding('Project aangemaakt. Vul rechts de projectfiche in, voeg een plan/foto\'s toe en doe daarna de Rondgang met de bril.', 8000);
};
for (const id of ['ifcWap', 'ifcTech', 'ifcBeton', 'ifcVV']) $(id).onchange = () => { if (S.entry?.soort === 'ifc') openProject(S.entry); };
$('fileIfc').onchange = async (ev) => {
  const f = ev.target.files[0]; if (!f) return;
  const buf = await f.arrayBuffer(); await IDB.put(f.name, buf);
  let e = S.projecten.find(p => p.id === 'ifc:' + f.name); if (!e) { e = { id: 'ifc:' + f.name, naam: f.name, soort: 'ifc', bron: 'lokaal' }; S.projecten.push(e); }
  openProject(e);
};
$('fileJson').onchange = async (ev) => {
  const f = ev.target.files[0]; if (!f) return;
  try {
    const d = JSON.parse(await f.text()); if (!d.id || !d.ruimte) throw new Error('geen AR-Bouw-project');
    LS.set('proj:' + d.id, d); if (d.markers) LS.set('markers:' + d.id, d.markers.filter(m => m.L)); if (d.notities) LS.set('notes:' + d.id, d.notities);
    let e = S.projecten.find(p => p.id === d.id);
    if (!e) { e = { id: d.id, naam: d.naam, soort: 'ruimte', bron: 'lokaal', basis: d }; S.projecten.push(e); LS.set('lokaal', [...LS.get('lokaal', []), d.id]); }
    openProject(e);
  } catch (e) { melding('Import mislukt: ' + e.message, 5000); }
};

// ---------------- demo (voorbeeld zonder bril) ----------------
function demoModus() {
  S.xrOK = false;
  for (const id of ['btnQR', 'btnBladen', 'btnExport']) $(id).hidden = true;
  $('xrStatus').textContent = 'Demo: in de bril ligt dit model over je echte kamer';
  const balk = $('balk');
  const mk = (t, f) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = t; b.onclick = f; balk.appendChild(b); return b; };
  const zicht = (binnen) => {
    if (S.data?.soort !== 'ruimte') return;
    const P = S.data.ruimte.vloer, xs = P.map(p => p[0]), zs = P.map(p => p[1]);
    const [cx, cz] = polyCentroid(P), x0 = Math.min(...xs), x1 = Math.max(...xs), z0 = Math.min(...zs), z1 = Math.max(...zs);
    if (binnen) { camera.position.set(x1 - 0.5, 1.6, cz + (z1 - z0) * 0.3); controls.target.set(x0, 1.1, cz); }
    else { camera.position.set(cx + 5, 5, cz + 6); controls.target.set(cx, 1, cz); }
    controls.update();
  };
  mk('Zicht in de kamer', () => zicht(true));
  mk('Overzicht', () => zicht(false));
  const wrap = document.createElement('div'); wrap.id = 'demoMenu';
  wrap.innerHTML = '<div class="demoKop">Menu in de bril <span class="zacht">(klik de knoppen)</span></div>';
  panel = new Panel(); wrap.appendChild(panel.canvas); $('midden').appendChild(wrap);
  const knop = mk('Bril-menu verbergen', () => { wrap.hidden = !wrap.hidden; knop.textContent = wrap.hidden ? 'Bril-menu tonen' : 'Bril-menu verbergen'; });
  panel.canvas.addEventListener('click', (e) => {
    const r = panel.canvas.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width * panel.canvas.width, py = (e.clientY - r.top) / r.height * panel.canvas.height;
    const b = panel.buttons.find(b => px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h && !b.disabled);
    if (b) { onAction(b.id); tekenRechts(); $('fase').value = S.fase; $('faseNaam').textContent = FASEN[S.fase]; }
  });
  S.panelMelding = 'Demo op pc. In de bril wijs je met de rechtercontroller naar deze knoppen.';
  panelUpdate();
}

// ---------------- start ----------------
(async function init() {
  resize();
  renderer.setAnimationLoop(loop);
  S.xrOK = !!(navigator.xr && await navigator.xr.isSessionSupported('immersive-ar').catch(() => false));
  $('xrStatus').textContent = S.xrOK ? 'AR beschikbaar ✓' : 'AR niet beschikbaar op dit toestel — 3D-voorbeeld';
  if (window.AR_CFG?.demo) demoModus();
  if (window.AR_CFG?.artifact) {
    for (const id of ['btnQR', 'btnBladen']) $(id).hidden = true;
    $('btnExport').textContent = 'Stuur naar Claude';
    if (!S.xrOK) $('xrStatus').textContent = navigator.xr ? 'AR wordt in deze Claude-pagina geblokkeerd — gebruik de GitHub-versie' : 'AR niet beschikbaar op dit toestel — 3D-voorbeeld';
  }
  await laadLijst();
  const q = new URLSearchParams(location.search);
  kiesTab(LS.get('tab', 'db'), false);
  if (q.get('p')) { toonStart(false); await kiesViaQR(q.get('p'), q.get('m')); }
  else { toonStart(true); const last = S.projecten.find(p => p.id === LS.get('laatste')) || S.projecten[0]; if (last) await openProject(last, { stil: true }); toonStart(true); }
  window.__arbouw = { pasVloerAan, autoUitlijnen: (f, s) => autoUitlijnen(f, s), inmeten: (f) => inmetenUitScan(f), S, root, scene, renderer, camera, controls, generate, onAction, losKalibratie, panelUpdate, get panel() { return panel; } };
})();
