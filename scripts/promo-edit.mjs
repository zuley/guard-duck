// 宣发视频剪辑：按 markers 切分录制素材 + 渲染章节卡 + xfade/acrossfade 合成。
// 用法：node scripts/promo-edit.mjs
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import WebSocket from 'ws';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const FFMPEG = process.env.LOCALAPPDATA + '/Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-9.0.2-full_build/bin/ffmpeg.exe';
const PORT = 9225;
const W = 1920, H = 1080;
const EDIT_DIR = 'shots/.promo-edit';
const OUT = 'videos/guard-duck-promo.mp4';
const X = 0.4; // crossfade sec
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(EDIT_DIR, { recursive: true });
const { fullStart, markers: M, frames } = JSON.parse(readFileSync('shots/.promo-markers.json', 'utf8'));

// webm 无时长元数据且 MediaRecorder 起点有偏差，解码实测后反推 music 真实起点
function measureDur(file) {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-i', file, '-f', 'null', '-'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const ms = [...r.stderr.toString().matchAll(/time=(\d+):(\d+):(\d+\.\d+)/g)];
  const m = ms[ms.length - 1];
  return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
}
const fullDur = measureDur('shots/.promo-full.webm');
const musicDur = measureDur('shots/.promo-music.webm');
const musicStart = fullStart + (fullDur - musicDur);
console.log(`fullDur=${fullDur.toFixed(2)} musicDur=${musicDur.toFixed(2)} musicStart offset=${(musicStart - fullStart).toFixed(2)}`);

// ---------- 渲染章节卡 ----------
async function renderCards() {
  const chrome = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--hide-scrollbars', `--window-size=${W},${H}`,
    `--remote-debugging-port=${PORT}`, '--user-data-dir=D:/Code/swyy/shots/.chrome-cards',
    'about:blank',
  ], { stdio: 'ignore' });
  let ws, msgId = 0;
  const pending = new Map();
  try {
    for (let i = 0; i < 60; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
        const list = await res.json();
        const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
        if (page) {
          ws = new WebSocket(page.webSocketDebuggerUrl);
          await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
          ws.on('message', (d) => { const m = JSON.parse(d); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
          break;
        }
      } catch { /* retry */ }
      await sleep(400);
    }
    if (!ws) throw new Error('cards chrome not reachable');
    const send = (method, params = {}) => new Promise((res) => { const id = ++msgId; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
    await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
    for (const c of ['1', '2', '3', '4', 'end']) {
      await send('Page.navigate', { url: `file:///D:/Code/swyy/shots/cards.html?c=${c}` });
      await sleep(700);
      const r = await send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(`${EDIT_DIR}/card${c}.png`, Buffer.from(r.result.data, 'base64'));
      console.log('card rendered:', c);
    }
  } finally {
    try { ws?.close(); } catch { /* ignore */ }
    chrome.kill();
  }
}

// ---------- 切块 ----------
function framesInRange(from, to) {
  const sel = frames.filter((f) => f.ts >= from && f.ts < to);
  if (sel.length < 2) throw new Error(`too few frames in [${from}, ${to}]`);
  return sel;
}
function blockDur(sel) { return sel[sel.length - 1].ts - sel[0].ts + 1 / 60; }

let bedCursor = M.skills + 0.3 - musicStart;
const blocks = [];
function addFrames(id, from, to, audio) {
  const sel = framesInRange(from, to);
  const dur = blockDur(sel);
  let ss;
  if (audio === 'full') ss = from - fullStart;
  else { ss = bedCursor; bedCursor += dur; }
  blocks.push({ id, kind: 'frames', sel, dur, audio, ss });
}
function addCard(id, dur, audio, ssOverride) {
  let ss;
  if (audio === 'full') ss = 0;
  else if (ssOverride !== undefined) ss = ssOverride;
  else { ss = bedCursor; bedCursor += dur; }
  blocks.push({ id, kind: 'card', dur, audio, ss });
}

addFrames('title', M.title, M.beauty, 'full');
addFrames('beauty', M.beauty, M.beauty + 3.5, 'full');
addFrames('m1', M.skills + 0.3, M.skills + 1.5, 'music');
addFrames('m2', M.combatB + 0.7, M.combatB + 1.9, 'music');
addFrames('m3', M.combatD + 0.5, M.combatD + 1.7, 'music');
addFrames('m4', M.combatD + 5.6, M.combatD + 6.8, 'music');
addCard('card1', 1.8, 'music');
addFrames('combat', M.combatA, M.talents, 'full');
addCard('card2', 1.8, 'music');
addFrames('skills', M.skills, M.shop, 'full');
addCard('card3', 1.8, 'music');
addFrames('talents', M.talents, M.skills, 'full');
addCard('card4', 1.8, 'music');
addFrames('shop', M.shop, M.over, 'full');
addFrames('over', M.over, M.end, 'full');
addCard('cardend', 2.5, 'music', M.over + 1.2 - musicStart);

// ---------- 编码各块 ----------
function encodeBlock(b) {
  const out = `${EDIT_DIR}/${b.id}.mp4`;
  const args = ['-y'];
  if (b.kind === 'frames') {
    let list = '';
    for (let i = 0; i < b.sel.length; i++) {
      const dur = i + 1 < b.sel.length ? b.sel[i + 1].ts - b.sel[i].ts : 1 / 60;
      list += `file 'D:/Code/swyy/shots/.promo-frames/${b.sel[i].file}'\nduration ${Math.max(0.001, dur).toFixed(6)}\n`;
    }
    list += `file 'D:/Code/swyy/shots/.promo-frames/${b.sel[b.sel.length - 1].file}'\n`;
    writeFileSync(`${EDIT_DIR}/${b.id}.txt`, list);
    args.push('-f', 'concat', '-safe', '0', '-i', `${EDIT_DIR}/${b.id}.txt`);
  } else {
    args.push('-loop', '1', '-framerate', '60', '-i', `${EDIT_DIR}/card${b.id.replace('card', '')}.png`);
  }
  const audioFile = b.audio === 'full' ? 'shots/.promo-full.webm' : 'shots/.promo-music.webm';
  args.push('-ss', Math.max(0, b.ss).toFixed(3), '-t', b.dur.toFixed(3), '-i', audioFile);
  args.push('-map', '0:v', '-map', '1:a',
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', '60',
    '-c:a', 'aac', '-b:a', '192k', '-t', b.dur.toFixed(3), '-shortest', out);
  execFileSync(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  console.log(`block ${b.id}: ${b.dur.toFixed(2)}s audio=${b.audio} ss=${b.ss.toFixed(2)}`);
}

// ---------- 合成 ----------
function assemble() {
  const args = ['-y'];
  for (const b of blocks) args.push('-i', `${EDIT_DIR}/${b.id}.mp4`);
  const fc = [];
  let acc = blocks[0].dur;
  let vlabel = '0:v';
  let alabel = '0:a';
  fc.push(`[0:a]afade=t=in:d=0.3[a0]`);
  alabel = 'a0';
  for (let i = 1; i < blocks.length; i++) {
    const off = acc - X;
    const vo = `vx${i}`, ao = `ax${i}`;
    fc.push(`[${vlabel}][${i}:v]xfade=transition=fade:duration=${X}:offset=${off.toFixed(3)}[${vo}]`);
    fc.push(`[${alabel}][${i}:a]acrossfade=d=${X}:c1=tri:c2=tri[${ao}]`);
    vlabel = vo; alabel = ao;
    acc = acc + blocks[i].dur - X;
  }
  fc.push(`[${alabel}]afade=t=out:st=${(acc - 0.8).toFixed(3)}:d=0.8[aout]`);
  args.push('-filter_complex', fc.join(';'),
    '-map', `[${vlabel}]`, '-map', '[aout]',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '21', '-pix_fmt', 'yuv420p', '-r', '60',
    '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-t', acc.toFixed(3), OUT);
  console.log(`assembling ${blocks.length} blocks, total ${acc.toFixed(2)}s…`);
  execFileSync(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  console.log('EDIT DONE:', OUT);
}

try {
  await renderCards();
  for (const b of blocks) encodeBlock(b);
  assemble();
} catch (e) {
  console.error('EDIT ERROR', e.message);
  if (e.stderr) console.error(e.stderr.toString().slice(-3000));
  process.exitCode = 1;
}