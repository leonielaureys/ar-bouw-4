// ifc.js — eigen Revit-modellen (IFC) laden met web-ifc en indelen in lagen
import * as THREE from 'three';

const CFG = window.AR_CFG || {};
const WASM = CFG.ifcWasm || 'https://cdn.jsdelivr.net/npm/web-ifc@0.0.78/';
let apiP = null;

async function api() {
  if (!apiP) apiP = (async () => {
    const WebIFC = await import('web-ifc');
    const a = new WebIFC.IfcAPI();
    a.SetWasmPath(WASM, true);
    await a.Init(undefined, true);
    return { a, WebIFC };
  })();
  return apiP;
}

/** IFC-klassen -> laag */
function laagVoor(W, type) {
  const T = (n) => W[n];
  const map = [
    [['IFCREINFORCINGBAR', 'IFCREINFORCINGMESH', 'IFCTENDON', 'IFCREINFORCINGELEMENT'], 'wapening'],
    [['IFCCABLESEGMENT', 'IFCCABLECARRIERSEGMENT', 'IFCCABLEFITTING', 'IFCCABLECARRIERFITTING', 'IFCOUTLET', 'IFCSWITCHINGDEVICE', 'IFCLIGHTFIXTURE', 'IFCLAMP', 'IFCELECTRICAPPLIANCE', 'IFCELECTRICDISTRIBUTIONBOARD', 'IFCJUNCTIONBOX', 'IFCPROTECTIVEDEVICE'], 'elektriciteit'],
    [['IFCSANITARYTERMINAL', 'IFCWASTETERMINAL'], 'afvoer'],
    [['IFCDUCTSEGMENT', 'IFCDUCTFITTING', 'IFCAIRTERMINAL', 'IFCFAN', 'IFCDAMPER'], 'ventilatie'],
    [['IFCPIPESEGMENT', 'IFCPIPEFITTING', 'IFCVALVE', 'IFCPUMP', 'IFCTANK'], 'water'],
    [['IFCSPACEHEATER', 'IFCBOILER', 'IFCHEATEXCHANGER'], 'verwarming'],
    [['IFCFIRESUPPRESSIONTERMINAL', 'IFCALARM', 'IFCSENSOR'], 'brand'],
    [['IFCWALL', 'IFCWALLSTANDARDCASE', 'IFCSLAB', 'IFCCOLUMN', 'IFCBEAM', 'IFCFOOTING', 'IFCROOF', 'IFCSTAIR', 'IFCSTAIRFLIGHT', 'IFCRAMP', 'IFCMEMBER', 'IFCPLATE', 'IFCPILE', 'IFCCOVERING', 'IFCCURTAINWALL', 'IFCRAILING'], 'structuur'],
  ];
  for (const [names, laag] of map) if (names.some(n => T(n) === type)) return laag;
  return 'ifc';
}

/** Laadt een IFC (ArrayBuffer) -> { group, picks, leidingen, rapport } */
export async function loadIFC(buffer, naam = 'model.ifc', onProgress = () => {}) {
  const { a, WebIFC } = await api();
  const id = a.OpenModel(new Uint8Array(buffer), { COORDINATE_TO_ORIGIN: true });
  const group = new THREE.Group(); group.name = 'ifc';
  const perLaag = new Map(); // laag -> {geos:[], picks}
  const picks = [];
  const tmpM = new THREE.Matrix4();
  const typeNaam = {};
  const elementen = [];
  let n = 0;
  const materialen = leesMaterialen(a, WebIFC, id);
  const gezien = new Set();
  const verwerk = (mesh) => {
    if (gezien.has(mesh.expressID)) return; gezien.add(mesh.expressID);
    const type = a.GetLineType(id, mesh.expressID);
    if (type === WebIFC.IFCOPENINGELEMENT) return;
    const isRuimte = type === WebIFC.IFCSPACE;
    let laag = isRuimte ? 'ruimte' : laagVoor(WebIFC, type);
    const geos = [];
    let kleur = null;
    for (let i = 0; i < mesh.geometries.size(); i++) {
      const pg = mesh.geometries.get(i);
      const geom = a.GetGeometry(id, pg.geometryExpressID);
      const v = a.GetVertexArray(geom.GetVertexData(), geom.GetVertexDataSize());
      const idx = a.GetIndexArray(geom.GetIndexData(), geom.GetIndexDataSize());
      const pos = new Float32Array(v.length / 2), nor = new Float32Array(v.length / 2);
      for (let k = 0, j = 0; k < v.length; k += 6, j += 3) { pos[j] = v[k]; pos[j + 1] = v[k + 1]; pos[j + 2] = v[k + 2]; nor[j] = v[k + 3]; nor[j + 1] = v[k + 4]; nor[j + 2] = v[k + 5]; }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
      g.setIndex(new THREE.BufferAttribute(new Uint32Array(idx), 1));
      tmpM.fromArray(pg.flatTransformation); g.applyMatrix4(tmpM);
      geos.push(g); kleur ??= pg.color;
      geom.delete?.();
    }
    if (!geos.length) return;
    let info = '';
    try {
      const line = a.GetLine(id, mesh.expressID);
      typeNaam[type] ||= a.GetNameFromTypeCode ? a.GetNameFromTypeCode(type) : String(type);
      info = `${typeNaam[type]}\n${line?.Name?.value || ''}${line?.ObjectType?.value ? '\n' + line.ObjectType.value : ''}${materialen.get(mesh.expressID) ? '\nMateriaal: ' + materialen.get(mesh.expressID) : ''}\n✔ Uit IFC-model`;
    } catch { info = 'IFC-element\n✔ Uit IFC-model'; }
    const { mergeGeometries } = THREE.BufferGeometryUtils || {};
    void mergeGeometries;
    const g = geos.length === 1 ? geos[0] : mergeSimple(geos);
    let lnaam = '', ltype = '';
    try { const line = a.GetLine(id, mesh.expressID); lnaam = line?.Name?.value || ''; ltype = line?.ObjectType?.value || ''; } catch { /* */ }
    // IFC2x3 / Revit: generieke MEP-klassen (IfcFlowSegment, -Terminal, proxy…) indelen op naam
    const tekst = `${lnaam} ${ltype} ${materialen.get(mesh.expressID) || ''}`;
    let laagF = laag;
    if (!isRuimte && (laag === 'ifc' || /FLOW|DISTRIBUTION|PROXY/.test(typeNaam[type] || ''))) laagF = laagOpNaam(tekst) || laag;
    elementen.push({ type: (typeNaam[type] || '').toUpperCase(), laag: laagF, naam: lnaam, objType: ltype, materiaal: materialen.get(mesh.expressID) || '', geo: g, expressID: mesh.expressID });
    if (isRuimte) return;
    laag = laagF;
    const op = laag === 'structuur' ? 0.16 : laag === 'ifc' ? 0.12 : 0.9;
    const c = laag === 'ifc' || laag === 'structuur' ? null : null;
    void c;
    const col = laag === 'structuur' ? 0x4da3ff : laag === 'ifc' ? new THREE.Color(kleur.x, kleur.y, kleur.z).getHex() : LAAGKLEUR[laag];
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: col, transparent: op < 1, opacity: op, depthWrite: op >= 1, side: THREE.DoubleSide }));
    m.userData = { laag, info, naam: typeNaam[type], fase: laag === 'structuur' || laag === 'wapening' ? 1 : laag === 'ifc' ? 5 : 3, aanname: false, pickable: true, expressID: mesh.expressID };
    group.add(m); picks.push(m);
    if (laag === 'structuur' && g.attributes.position.count < 20000) {
      const e = new THREE.LineSegments(new THREE.EdgesGeometry(g, 30), new THREE.LineBasicMaterial({ color: 0x8cc4ff, transparent: true, opacity: 0.5 }));
      e.userData = { laag, fase: 1, pickable: false }; group.add(e);
    }
    if (++n % 50 === 0) onProgress(n);
  };
  a.StreamAllMeshes(id, verwerk);
  try { a.StreamAllMeshesWithTypes(id, [WebIFC.IFCSPACE], verwerk); } catch (e) { console.warn('geen ruimtes', e); }
  a.CloseModel(id);
  void perLaag;
  // model op de vloer zetten (laagste punt = 0 niet forceren: Revit-niveau 0 blijft 0)
  const box = new THREE.Box3().setFromObject(group);
  return { group, picks, elementen, leidingen: [], rapport: [`IFC-model ${naam}: ${picks.length} elementen`, `Afmetingen: ${fmtv(box.getSize(new THREE.Vector3()))} m`], box };
}
const LAAGKLEUR = { wapening: 0xff3b30, elektriciteit: 0xffd400, afvoer: 0xff8c1a, ventilatie: 0x7fe3d0, water: 0x29b6f6, verwarming: 0xc86bff, brand: 0xff2d55 };
const fmtv = v => `${v.x.toFixed(2)} × ${v.z.toFixed(2)} × ${v.y.toFixed(2)}`;

function mergeSimple(geos) {
  let nPos = 0, nIdx = 0; for (const g of geos) { nPos += g.attributes.position.count; nIdx += g.index.count; }
  const pos = new Float32Array(nPos * 3), nor = new Float32Array(nPos * 3), idx = new Uint32Array(nIdx);
  let po = 0, io = 0;
  for (const g of geos) {
    pos.set(g.attributes.position.array, po * 3); nor.set(g.attributes.normal.array, po * 3);
    const gi = g.index.array; for (let k = 0; k < gi.length; k++) idx[io + k] = gi[k] + po;
    po += g.attributes.position.count; io += gi.length;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.BufferAttribute(nor, 3)); g.setIndex(new THREE.BufferAttribute(idx, 1));
  return g;
}

/** Op GitHub Pages: lijst .ifc-bestanden in de repo (map modellen/ en ar/modellen/). */
export async function githubModellen() {
  const h = location.hostname;
  if (!h.endsWith('github.io')) return [];
  const user = h.split('.')[0];
  const parts = location.pathname.split('/').filter(Boolean);
  const repo = h === `${user}.github.io` && parts.length && !parts[0].includes('.') ? parts[0] : null;
  const repos = repo ? [repo] : [`${user}.github.io`];
  const out = [];
  for (const r of repos) for (const dir of ['modellen', 'ar/modellen']) {
    try {
      const res = await fetch(`https://api.github.com/repos/${user}/${r}/contents/${dir}`);
      if (!res.ok) continue;
      for (const f of await res.json()) if (/\.ifc$/i.test(f.name)) out.push({ naam: f.name, url: f.download_url, pad: dir });
    } catch { /* offline */ }
  }
  return out;
}

/** expressID -> materiaalnamen (uit IfcRelAssociatesMaterial, ook via lagen/types) */
function leesMaterialen(a, W, id) {
  const map = new Map();
  const namen = (o, diepte = 0, uit = new Set()) => {
    if (!o || diepte > 6) return uit;
    if (Array.isArray(o)) { for (const x of o) namen(x, diepte + 1, uit); return uit; }
    if (typeof o !== 'object') return uit;
    if (o.Name?.value && typeof o.Name.value === 'string') uit.add(o.Name.value);
    if (o.Category?.value) uit.add(o.Category.value);
    for (const k of ['Material', 'Materials', 'ForLayerSet', 'MaterialLayers', 'MaterialConstituents', 'MaterialProfiles', 'ForProfileSet', 'MaterialProfileSet']) if (o[k]) namen(o[k], diepte + 1, uit);
    return uit;
  };
  try {
    const ids = a.GetLineIDsWithType(id, W.IFCRELASSOCIATESMATERIAL);
    for (let i = 0; i < ids.size(); i++) {
      const rel = a.GetLine(id, ids.get(i), true);
      const txt = [...namen(rel.RelatingMaterial)].join(', ');
      if (!txt) continue;
      for (const ob of rel.RelatedObjects || []) {
        const eid = ob?.expressID ?? ob?.value; if (eid == null) continue;
        map.set(eid, map.has(eid) ? map.get(eid) + ', ' + txt : txt);
      }
    }
    // materiaal op type-niveau doorgeven aan de instanties
    const tids = a.GetLineIDsWithType(id, W.IFCRELDEFINESBYTYPE);
    for (let i = 0; i < tids.size(); i++) {
      const rel = a.GetLine(id, tids.get(i), false);
      const t = rel.RelatingType?.value; if (t == null || !map.has(t)) continue;
      for (const ob of rel.RelatedObjects || []) { const eid = ob?.value; if (eid != null && !map.has(eid)) map.set(eid, map.get(t)); }
    }
  } catch (e) { console.warn('materialen', e); }
  return map;
}

/** laag afleiden uit naam/type/materiaal (voor generieke IFC-klassen) */
export function laagOpNaam(t) {
  if (/kabel|cable|elektr|electr|conduit|kabelgoot|cable ?tray|stopcontact|socket|outlet|contactdoos|schakelaar|switch|lamp|light|armatuur|verlicht|luminaire|verdeelbord|panel board|domotica|data|utp/i.test(t)) return 'elektriciteit';
  if (/afvoer|riolering|riool|drain|waste|sewer|soil|vuilwater|regenwater|rwa|dwa|pvc ?[0-9]|wc|toilet|urinoir/i.test(t)) return 'afvoer';
  if (/duct|kanaal|luchtkanaal|ventil|air ?terminal|rooster|grille|diffuser|toevoer|extract|lucht/i.test(t)) return 'ventilatie';
  if (/verwarm|heating|radiator|convector|cv[- ]|vloerverwarm|heat/i.test(t)) return 'verwarming';
  if (/sprinkler|rookmelder|smoke|detector|brand|fire|blusser|haspel/i.test(t)) return 'brand';
  if (/pipe|leiding|water|koud|warm|kw\b|ww\b|sanitair|plumbing|lavabo|wastafel|sink|basin|douche|shower|kraan|tap/i.test(t)) return 'water';
  return null;
}
