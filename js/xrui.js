// xrui.js — paneel in AR (canvas-textuur) met knoppen, te bedienen met de straal van de controller of hand
import * as THREE from 'three';
import { roundRect } from './geo.js';

const W = 1024, H = 800;
export class Panel {
  constructor({ width = 0.36 } = {}) {
    this.canvas = document.createElement('canvas'); this.canvas.width = W; this.canvas.height = H;
    this.ctx = this.canvas.getContext('2d');
    this.tex = new THREE.CanvasTexture(this.canvas); this.tex.colorSpace = THREE.SRGBColorSpace;
    const h = width * H / W;
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, h),
      new THREE.MeshBasicMaterial({ map: this.tex, transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide }));
    this.mesh.renderOrder = 1000; this.mesh.name = 'paneel';
    this.buttons = []; this.hoverId = null; this.state = {};
  }
  set(state) { this.state = { ...this.state, ...state }; this.draw(); }
  draw() {
    const c = this.ctx, s = this.state; this.buttons = [];
    c.clearRect(0, 0, W, H);
    c.fillStyle = 'rgba(12,16,24,0.93)'; roundRect(c, 0, 0, W, H, 34); c.fill();
    c.strokeStyle = 'rgba(77,163,255,0.6)'; c.lineWidth = 4; roundRect(c, 2, 2, W - 4, H - 4, 32); c.stroke();
    c.fillStyle = '#fff'; c.font = '700 34px system-ui'; c.textBaseline = 'middle';
    c.fillText(clip(c, s.title || 'AR-Bouw', 640), 28, 42);
    c.font = '500 24px system-ui'; c.fillStyle = s.statusKleur || '#9fb3c8'; c.textAlign = 'right';
    c.fillText(clip(c, s.status || '', 340), W - 28, 42); c.textAlign = 'left';
    // modi
    const modes = s.modes || [];
    const cols = modes.length > 9 ? 5 : 3, bw = (W - 56 - 12 * (cols - 1)) / cols, bh = 62;
    modes.forEach((m, i) => {
      const x = 28 + (i % cols) * (bw + 12), y = 84 + Math.floor(i / cols) * (bh + 12);
      this.btn({ id: 'mode:' + m.id, label: m.label, x, y, w: bw, h: bh, active: m.id === s.activeMode, kind: 'mode' });
    });
    const y0 = 84 + Math.ceil(modes.length / cols) * (bh + 12) + 10;
    c.fillStyle = 'rgba(255,255,255,0.12)'; c.fillRect(28, y0 - 6, W - 56, 2);
    // acties
    const acts = s.actions || [];
    const acols = s.acols || 4, aw = (W - 56 - 14 * (acols - 1)) / acols, ah = 66;
    acts.forEach((a, i) => {
      const x = 28 + (i % acols) * (aw + 14), y = y0 + 10 + Math.floor(i / acols) * (ah + 12);
      this.btn({ id: a.id, label: a.label, x, y, w: aw, h: ah, active: a.active, disabled: a.disabled, kind: 'act', kleur: a.kleur });
    });
    const yi = y0 + 10 + Math.ceil(acts.length / acols) * (ah + 12) + 6;
    // info
    c.fillStyle = '#dbe7f3'; c.font = '500 25px system-ui';
    const planW = s.plan ? 290 : 0;
    const lines = wrap(c, s.info || '', W - 56 - planW);
    const maxL = Math.floor((H - yi - 16) / 31);
    lines.slice(0, maxL).forEach((l, i) => {
      if (l.startsWith('⚠')) c.fillStyle = '#ffb340'; else if (l.startsWith('✔')) c.fillStyle = '#5be38f'; else c.fillStyle = '#dbe7f3';
      c.fillText(l, 28, yi + 16 + i * 31);
    });
    if (s.plan) this.drawPlan(s.plan, W - 28 - 270, yi, 270, H - yi - 20);
    this.tex.needsUpdate = true;
  }
  drawPlan({ poly, hl }, x, y, w, h) {
    const c = this.ctx;
    const xs = poly.map(p => p[0]), zs = poly.map(p => p[1]);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minZ = Math.min(...zs), maxZ = Math.max(...zs);
    const sc = Math.min((w - 40) / Math.max(0.1, maxX - minX), (h - 40) / Math.max(0.1, maxZ - minZ));
    const P = ([px, pz]) => [x + 20 + (px - minX) * sc, y + 20 + (pz - minZ) * sc];
    c.fillStyle = 'rgba(255,255,255,0.05)'; roundRect(c, x, y, w, h, 12); c.fill();
    c.strokeStyle = '#8cc4ff'; c.lineWidth = 4; c.beginPath();
    poly.forEach((p, i) => { const [a, b] = P(p); i ? c.lineTo(a, b) : c.moveTo(a, b); }); c.closePath(); c.stroke();
    for (let i = 0; i < 2; i++) {
      const [a, b] = P(poly[i]);
      c.fillStyle = i < hl ? '#3ddc84' : i === hl ? '#ffb340' : '#5f6b78';
      c.beginPath(); c.arc(a, b, 14, 0, Math.PI * 2); c.fill();
      c.fillStyle = '#000'; c.font = '700 18px system-ui'; c.textAlign = 'center'; c.fillText(String(i + 1), a, b + 1); c.textAlign = 'left';
    }
  }
  btn(b) {
    const c = this.ctx; this.buttons.push(b);
    const hov = this.hoverId === b.id;
    c.fillStyle = b.disabled ? 'rgba(255,255,255,0.05)' : b.active ? (b.kleur || '#2f7fe0') : hov ? 'rgba(77,163,255,0.35)' : 'rgba(255,255,255,0.10)';
    roundRect(c, b.x, b.y, b.w, b.h, 14); c.fill();
    if (b.kleur && !b.active) { c.fillStyle = b.kleur; c.fillRect(b.x + 10, b.y + b.h - 8, b.w - 20, 4); }
    if (hov) { c.strokeStyle = '#8cc4ff'; c.lineWidth = 3; roundRect(c, b.x + 1.5, b.y + 1.5, b.w - 3, b.h - 3, 13); c.stroke(); }
    c.fillStyle = b.disabled ? '#5f6b78' : (b.active && b.kleur) ? '#0b1220' : '#fff'; c.font = `${b.kind === 'mode' ? 600 : 500} ${b.kind === 'mode' ? 25 : 24}px system-ui`;
    c.textAlign = 'center'; c.fillText(clip(c, b.label, b.w - 16), b.x + b.w / 2, b.y + b.h / 2 + 1); c.textAlign = 'left';
  }
  /** raycaster -> knop-id of null (en hover bijwerken) */
  pick(raycaster) {
    if (!this.mesh.visible) return { hit: false };
    const hit = raycaster.intersectObject(this.mesh, false)[0];
    let id = null;
    if (hit && hit.uv) {
      const px = hit.uv.x * W, py = (1 - hit.uv.y) * H;
      const b = this.buttons.find(b => px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h && !b.disabled);
      id = b ? b.id : null;
    }
    if (id !== this.hoverId) { this.hoverId = id; this.draw(); }
    return { hit: !!hit, id, point: hit?.point };
  }
}

function clip(c, t, w) { t = String(t); if (c.measureText(t).width <= w) return t; while (t.length > 1 && c.measureText(t + '…').width > w) t = t.slice(0, -1); return t + '…'; }
function wrap(c, text, w) {
  const out = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const word of para.split(' ')) {
      const t = line ? line + ' ' + word : word;
      if (c.measureText(t).width > w && line) { out.push(line); line = word; } else line = t;
    }
    out.push(line);
  }
  return out;
}
