// qr.js — QR-codes scannen met de camera (Quest 3: passthrough-camera via getUserMedia, Quest Browser ≥ 40)
const JSQR = (window.AR_CFG && window.AR_CFG.jsqr) || 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js';

function loadScript(src) {
  return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
}

/** Leest projectcode + markercode uit de QR-inhoud (een link naar deze app). */
export function parseQR(text) {
  try {
    const u = new URL(text, location.href);
    const p = u.searchParams.get('p'), m = u.searchParams.get('m');
    if (p) return { p, m };
  } catch { /* geen URL */ }
  const mm = /p=([\w-]+).*?(?:m=([\w-]+))?/.exec(text);
  return mm ? { p: mm[1], m: mm[2] || null } : null;
}

/** Start scannen; roept onResult({p,m,text}) één keer aan. Geeft stop()-functie terug. */
export async function startScan(video, onResult, onMsg = () => {}) {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 960 } }, audio: false });
  } catch (e) {
    onMsg('Geen camera-toegang: ' + (e.message || e.name) + '. Geef de browser toestemming voor de camera (Quest: Instellingen › Privacy › Camera).');
    return () => {};
  }
  video.srcObject = stream; await video.play().catch(() => {});
  let detector = null;
  if ('BarcodeDetector' in window) { try { detector = new window.BarcodeDetector({ formats: ['qr_code'] }); } catch { detector = null; } }
  if (!detector && !window.jsQR) { try { await loadScript(JSQR); } catch { onMsg('QR-bibliotheek kon niet laden (offline?)'); } }
  const c = document.createElement('canvas'), ctx = c.getContext('2d', { willReadFrequently: true });
  let stopped = false;
  const stop = () => { stopped = true; stream.getTracks().forEach(t => t.stop()); video.srcObject = null; };
  const tick = async () => {
    if (stopped) return;
    if (video.readyState >= 2) {
      let text = null;
      try {
        if (detector) { const r = await detector.detect(video); if (r.length) text = r[0].rawValue; }
        else if (window.jsQR) {
          c.width = video.videoWidth; c.height = video.videoHeight; ctx.drawImage(video, 0, 0);
          const img = ctx.getImageData(0, 0, c.width, c.height);
          const r = window.jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' }); if (r) text = r.data;
        }
      } catch { /* volgende frame */ }
      if (text) { const q = parseQR(text); if (q) { stop(); onResult({ ...q, text }); return; } onMsg('QR gelezen, maar geen AR-Bouw-code: ' + text.slice(0, 60)); }
    }
    setTimeout(tick, 120);
  };
  tick();
  return stop;
}
