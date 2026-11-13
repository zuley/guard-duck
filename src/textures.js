import * as THREE from 'three';
import { mulberry32 } from './rules.js';

const cache = new Map();

function makeCanvas(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return c;
}

function makeNoise(seed, grid = 64) {
  const rng = mulberry32(seed);
  const g = new Float32Array(grid * grid);
  for (let i = 0; i < g.length; i++) g[i] = rng();
  const smooth = (t) => t * t * (3 - 2 * t);
  function at(x, y) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = smooth(x - xi), yf = smooth(y - yi);
    const w = (a, b) => g[((b % grid) + grid) % grid * grid + (((a % grid) + grid) % grid)];
    const v00 = w(xi, yi), v10 = w(xi + 1, yi), v01 = w(xi, yi + 1), v11 = w(xi + 1, yi + 1);
    return v00 + (v10 - v00) * xf + (v01 - v00) * yf + (v00 - v10 - v01 + v11) * xf * yf;
  }
  return function fbm(x, y, oct = 4) {
    let v = 0, amp = 0.5, f = 1, norm = 0;
    for (let o = 0; o < oct; o++) {
      v += at(x * f, y * f) * amp;
      norm += amp;
      amp *= 0.5;
      f *= 2;
    }
    return v / norm;
  };
}

function heightToNormal(src, strength = 2) {
  const size = src.width;
  const sctx = src.getContext('2d');
  const data = sctx.getImageData(0, 0, size, size).data;
  const out = makeCanvas(size);
  const octx = out.getContext('2d');
  const img = octx.createImageData(size, size);
  const h = (x, y) => {
    x = (x + size) % size; y = (y + size) % size;
    return data[(y * size + x) * 4] / 255;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (h(x + 1, y) - h(x - 1, y)) * strength;
      const dy = (h(x, y + 1) - h(x, y - 1)) * strength;
      const len = Math.sqrt(dx * dx + dy * dy + 1);
      const i = (y * size + x) * 4;
      img.data[i] = ((-dx / len) * 0.5 + 0.5) * 255;
      img.data[i + 1] = ((-dy / len) * 0.5 + 0.5) * 255;
      img.data[i + 2] = ((1 / len) * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  }
  octx.putImageData(img, 0, 0);
  return out;
}

function toTexture(canvas, { srgb = true, repeat = true } = {}) {
  const t = new THREE.CanvasTexture(canvas);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; }
  t.anisotropy = 8;
  return t;
}

function cached(key, fn) {
  if (!cache.has(key)) cache.set(key, fn());
  return cache.get(key);
}

/* ---------------- 地面 / 道具 PBR 贴图 ---------------- */

export function grassMaps() {
  return cached('grass', () => {
    const size = 512;
    const c = makeCanvas(size), ctx = c.getContext('2d');
    const hC = makeCanvas(size), hCtx = hC.getContext('2d');
    const fbm = makeNoise(11);
    const rng = mulberry32(21);
    const img = ctx.createImageData(size, size);
    const hImg = hCtx.createImageData(size, size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const n = fbm(x / 48, y / 48, 5);
        const patch = fbm(x / 130 + 40, y / 130 + 9, 3);
        let r = 74 + n * 46, g = 118 + n * 52, b = 48 + n * 30;
        if (patch > 0.62) {
          const t = Math.min(1, (patch - 0.62) * 5);
          r = r + (122 - r) * t; g = g + (96 - g) * t; b = b + (62 - b) * t;
        }
        const i = (y * size + x) * 4;
        img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b; img.data[i + 3] = 255;
        const hv = 90 + n * 110;
        hImg.data[i] = hImg.data[i + 1] = hImg.data[i + 2] = hv; hImg.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    hCtx.putImageData(hImg, 0, 0);
    for (let i = 0; i < 5200; i++) {
      const x = rng() * size, y = rng() * size;
      const len = 3 + rng() * 6, ang = -Math.PI / 2 + (rng() - 0.5) * 1.2;
      const shade = 0.6 + rng() * 0.8;
      ctx.strokeStyle = `rgba(${Math.round(88 * shade)},${Math.round(150 * shade)},${Math.round(60 * shade)},0.55)`;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, y);
      ctx.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len); ctx.stroke();
      hCtx.strokeStyle = `rgba(255,255,255,${0.25 + rng() * 0.3})`;
      hCtx.beginPath(); hCtx.moveTo(x, y);
      hCtx.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len); hCtx.stroke();
    }
    return {
      map: toTexture(c),
      normalMap: toTexture(heightToNormal(hC, 2.2), { srgb: false }),
    };
  });
}

export function dirtMaps() {
  return cached('dirt', () => {
    const size = 512;
    const c = makeCanvas(size), ctx = c.getContext('2d');
    const hC = makeCanvas(size), hCtx = hC.getContext('2d');
    const fbm = makeNoise(33);
    const rng = mulberry32(44);
    const img = ctx.createImageData(size, size);
    const hImg = hCtx.createImageData(size, size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const n = fbm(x / 40, y / 40, 5);
        const i = (y * size + x) * 4;
        img.data[i] = 124 + n * 40; img.data[i + 1] = 102 + n * 34; img.data[i + 2] = 76 + n * 26; img.data[i + 3] = 255;
        const hv = 80 + n * 120;
        hImg.data[i] = hImg.data[i + 1] = hImg.data[i + 2] = hv; hImg.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    hCtx.putImageData(hImg, 0, 0);
    for (let i = 0; i < 260; i++) {
      const x = rng() * size, y = rng() * size, r = 1 + rng() * 3.4;
      const g = 120 + rng() * 70;
      ctx.fillStyle = `rgba(${g},${g * 0.9},${g * 0.75},0.7)`;
      ctx.beginPath(); ctx.ellipse(x, y, r, r * 0.75, rng() * 3, 0, 7); ctx.fill();
      hCtx.fillStyle = 'rgba(255,255,255,0.5)';
      hCtx.beginPath(); hCtx.ellipse(x, y, r, r * 0.75, 0, 0, 7); hCtx.fill();
    }
    for (let i = 0; i < 26; i++) {
      ctx.strokeStyle = 'rgba(60,42,26,0.5)'; ctx.lineWidth = 1.2;
      let x = rng() * size, y = rng() * size;
      ctx.beginPath(); ctx.moveTo(x, y);
      for (let s = 0; s < 6; s++) { x += (rng() - 0.5) * 40; y += (rng() - 0.5) * 40; ctx.lineTo(x, y); }
      ctx.stroke();
    }
    return { map: toTexture(c), normalMap: toTexture(heightToNormal(hC, 2.6), { srgb: false }) };
  });
}

export function woodMaps() {
  return cached('wood', () => {
    const size = 512;
    const c = makeCanvas(size), ctx = c.getContext('2d');
    const hC = makeCanvas(size), hCtx = hC.getContext('2d');
    const fbm = makeNoise(55);
    const rng = mulberry32(66);
    ctx.fillStyle = '#8a6238'; ctx.fillRect(0, 0, size, size);
    hCtx.fillStyle = '#808080'; hCtx.fillRect(0, 0, size, size);
    const plank = 86;
    for (let p = 0; p < size / plank; p++) {
      const x0 = p * plank;
      const tone = 0.82 + rng() * 0.36;
      ctx.fillStyle = `rgb(${Math.round(138 * tone)},${Math.round(98 * tone)},${Math.round(56 * tone)})`;
      ctx.fillRect(x0, 0, plank - 3, size);
      for (let y = 0; y < size; y += 2) {
        const n = fbm(x0 / 30 + p * 7, y / 90, 4);
        const grain = Math.sin(y * 0.11 + n * 9 + p) * 0.5 + 0.5;
        ctx.fillStyle = `rgba(60,38,18,${0.08 + grain * 0.16})`;
        ctx.fillRect(x0, y, plank - 3, 2);
        hCtx.fillStyle = `rgba(${grain > 0.5 ? 255 : 0},${grain > 0.5 ? 255 : 0},${grain > 0.5 ? 255 : 0},0.08)`;
        hCtx.fillRect(x0, y, plank - 3, 2);
      }
      ctx.fillStyle = 'rgba(30,18,8,0.85)'; ctx.fillRect(x0 + plank - 3, 0, 3, size);
      hCtx.fillStyle = 'rgba(0,0,0,0.9)'; hCtx.fillRect(x0 + plank - 3, 0, 3, size);
      for (let k = 0; k < 3; k++) {
        const ny = 30 + rng() * (size - 60);
        ctx.fillStyle = 'rgba(40,30,20,0.9)';
        ctx.beginPath(); ctx.arc(x0 + 10, ny, 3, 0, 7); ctx.arc(x0 + plank - 14, ny, 3, 0, 7); ctx.fill();
        ctx.fillStyle = 'rgba(220,210,190,0.35)';
        ctx.beginPath(); ctx.arc(x0 + 9, ny - 1, 1.2, 0, 7); ctx.fill();
      }
      for (let k = 0; k < 8; k++) {
        ctx.strokeStyle = `rgba(210,180,140,${0.1 + rng() * 0.15})`; ctx.lineWidth = 1;
        const sx = x0 + rng() * (plank - 6), sy = rng() * size;
        ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(sx + (rng() - 0.5) * 8, sy + 14 + rng() * 30); ctx.stroke();
      }
    }
    return { map: toTexture(c), normalMap: toTexture(heightToNormal(hC, 2.0), { srgb: false }) };
  });
}

export function metalMaps() {
  return cached('metal', () => {
    const size = 256;
    const c = makeCanvas(size), ctx = c.getContext('2d');
    const fbm = makeNoise(77);
    const rng = mulberry32(88);
    const img = ctx.createImageData(size, size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const n = fbm(x / 26, y / 26, 4);
        const rust = fbm(x / 60 + 13, y / 60 + 5, 4);
        let r = 96 + n * 40, g = 102 + n * 40, b = 110 + n * 44;
        if (rust > 0.6) {
          const t = Math.min(1, (rust - 0.6) * 4.5);
          r = r + (128 - r) * t; g = g + (70 - g) * t; b = b + (38 - b) * t;
        }
        const i = (y * size + x) * 4;
        img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b; img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    for (let i = 0; i < 60; i++) {
      ctx.strokeStyle = `rgba(220,226,235,${0.08 + rng() * 0.14})`; ctx.lineWidth = 0.8;
      const x = rng() * size, y = rng() * size;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + (rng() - 0.5) * 40, y + (rng() - 0.5) * 12); ctx.stroke();
    }
    return { map: toTexture(c) };
  });
}

export function hayMaps() {
  return cached('hay', () => {
    const size = 256;
    const c = makeCanvas(size), ctx = c.getContext('2d');
    const hC = makeCanvas(size), hCtx = hC.getContext('2d');
    const rng = mulberry32(101);
    ctx.fillStyle = '#c9a24a'; ctx.fillRect(0, 0, size, size);
    hCtx.fillStyle = '#808080'; hCtx.fillRect(0, 0, size, size);
    for (let i = 0; i < 2600; i++) {
      const x = rng() * size, y = rng() * size;
      const len = 8 + rng() * 22, ang = (rng() - 0.5) * 0.9;
      const shade = 0.65 + rng() * 0.75;
      ctx.strokeStyle = `rgba(${Math.round(205 * shade)},${Math.round(165 * shade)},${Math.round(74 * shade)},0.7)`;
      ctx.lineWidth = 1.1;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len); ctx.stroke();
      hCtx.strokeStyle = `rgba(${rng() > 0.5 ? 255 : 0},${rng() > 0.5 ? 255 : 0},${rng() > 0.5 ? 255 : 0},0.2)`;
      hCtx.beginPath(); hCtx.moveTo(x, y); hCtx.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len); hCtx.stroke();
    }
    return { map: toTexture(c), normalMap: toTexture(heightToNormal(hC, 1.6), { srgb: false }) };
  });
}

export function waterNormalMap() {
  return cached('waterN', () => {
    const size = 256;
    const hC = makeCanvas(size), hCtx = hC.getContext('2d');
    const fbm = makeNoise(123);
    const img = hCtx.createImageData(size, size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const n = fbm(x / 22, y / 22, 4) * 0.7 + fbm(x / 9 + 31, y / 9 + 17, 3) * 0.3;
        const i = (y * size + x) * 4;
        const v = n * 255;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255;
      }
    }
    hCtx.putImageData(img, 0, 0);
    return toTexture(heightToNormal(hC, 1.4), { srgb: false });
  });
}

/* ---------------- 粒子 / 贴花 sprite ---------------- */

function spriteCanvas(size, draw) {
  const c = makeCanvas(size);
  draw(c.getContext('2d'), size);
  return toTexture(c, { repeat: false });
}

export function featherSprite(color = '#ffd95e') {
  return cached('feather' + color, () => spriteCanvas(64, (ctx, s) => {
    ctx.translate(s / 2, s / 2);
    const grad = ctx.createLinearGradient(0, -26, 0, 26);
    grad.addColorStop(0, '#ffffff');
    grad.addColorStop(0.35, color);
    grad.addColorStop(1, color);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(0, -26);
    ctx.bezierCurveTo(13, -14, 12, 10, 0, 26);
    ctx.bezierCurveTo(-12, 10, -13, -14, 0, -26);
    ctx.fill();
    ctx.strokeStyle = 'rgba(120,90,20,0.55)'; ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.moveTo(0, -24); ctx.lineTo(0, 26); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 0.8;
    for (let i = -18; i < 20; i += 5) {
      ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(9, i - 4); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(-9, i - 4); ctx.stroke();
    }
  }));
}

export function puffSprite() {
  return cached('puff', () => spriteCanvas(128, (ctx, s) => {
    const rng = mulberry32(5);
    for (let i = 0; i < 14; i++) {
      const x = s / 2 + (rng() - 0.5) * s * 0.42;
      const y = s / 2 + (rng() - 0.5) * s * 0.42;
      const r = s * (0.14 + rng() * 0.2);
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, 'rgba(255,255,255,0.32)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
    }
  }));
}

export function sparkSprite() {
  return cached('spark', () => spriteCanvas(32, (ctx, s) => {
    const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    g.addColorStop(0, 'rgba(255,255,240,1)');
    g.addColorStop(0.25, 'rgba(255,210,120,0.9)');
    g.addColorStop(1, 'rgba(255,140,40,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, s, s);
  }));
}

export function flashSprite() {
  return cached('flash', () => spriteCanvas(128, (ctx, s) => {
    const c = s / 2;
    const g = ctx.createRadialGradient(c, c, 0, c, c, c);
    g.addColorStop(0, 'rgba(255,255,230,1)');
    g.addColorStop(0.2, 'rgba(255,220,130,0.95)');
    g.addColorStop(0.5, 'rgba(255,150,50,0.45)');
    g.addColorStop(1, 'rgba(255,120,20,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, s, s);
    ctx.strokeStyle = 'rgba(255,240,190,0.9)'; ctx.lineWidth = 3;
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + 0.4;
      ctx.beginPath(); ctx.moveTo(c, c);
      ctx.lineTo(c + Math.cos(a) * c * 0.95, c + Math.sin(a) * c * 0.95); ctx.stroke();
    }
  }));
}

export function glowSprite() {
  return cached('glow', () => spriteCanvas(64, (ctx, s) => {
    const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.35, 'rgba(255,255,255,0.4)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, s, s);
  }));
}

export function scorchSprite() {
  return cached('scorch', () => spriteCanvas(128, (ctx, s) => {
    const rng = mulberry32(9);
    const c = s / 2;
    const g = ctx.createRadialGradient(c, c, 0, c, c, c * 0.9);
    g.addColorStop(0, 'rgba(18,12,8,0.85)');
    g.addColorStop(0.6, 'rgba(24,16,10,0.5)');
    g.addColorStop(1, 'rgba(24,16,10,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, s, s);
    for (let i = 0; i < 24; i++) {
      const a = rng() * Math.PI * 2, d = rng() * c * 0.8;
      ctx.fillStyle = `rgba(15,10,6,${0.2 + rng() * 0.3})`;
      ctx.beginPath(); ctx.arc(c + Math.cos(a) * d, c + Math.sin(a) * d, 2 + rng() * 6, 0, 7); ctx.fill();
    }
  }));
}

export function ringSprite() {
  return cached('ring', () => spriteCanvas(128, (ctx, s) => {
    const c = s / 2;
    ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 6;
    ctx.beginPath(); ctx.arc(c, c, c * 0.72, 0, 7); ctx.stroke();
    const g = ctx.createRadialGradient(c, c, c * 0.5, c, c, c);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.75, 'rgba(255,255,255,0.25)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, s, s);
  }));
}

export function textTexture(text, color = '#ffe28a') {
  const font = '900 64px "Yuanti SC","YouYuan","Microsoft YaHei",sans-serif';
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  ctx.font = font;
  const w = Math.max(128, Math.ceil(ctx.measureText(text).width) + 24);
  c.width = w; c.height = 128;
  ctx.font = font;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.lineWidth = 10; ctx.strokeStyle = 'rgba(20,12,4,0.9)';
  ctx.strokeText(text, w / 2, 64);
  ctx.fillStyle = color;
  ctx.fillText(text, w / 2, 64);
  return toTexture(c, { repeat: false });
}