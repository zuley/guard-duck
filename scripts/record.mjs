// 录制守卫鸭鸭演示视频：CDP screencast 抓整页画面（含 DOM HUD）+ 页面内 WebAudio 录音，
// 按时间戳拼接帧并音视频对齐，ffmpeg 合成 mp4。用法：node scripts/record.mjs [总秒数]
import { spawn, execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import WebSocket from 'ws';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const FFMPEG = process.env.LOCALAPPDATA + '/Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-9.0.2-full_build/bin/ffmpeg.exe';
const PORT = 9223;
const W = 1920, H = 1080;
const TOTAL = Number(process.argv[2]) || 35;
const TITLE_SEC = 3;
const FRAMES_DIR = 'shots/.rec-frames';
const OUT = 'videos/guard-duck-demo.mp4';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(FRAMES_DIR, { recursive: true });
mkdirSync('videos', { recursive: true });

const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox',
  '--hide-scrollbars', `--window-size=${W},${H}`,
  '--autoplay-policy=no-user-gesture-required',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  `--remote-debugging-port=${PORT}`, '--user-data-dir=D:/Code/swyy/shots/.chrome-rec',
  'about:blank',
], { stdio: 'ignore' });

let ws, msgId = 0;
const pending = new Map();
const frames = []; // { file, ts }  ts 为 epoch 秒

async function connect() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
        await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
        ws.on('message', (data) => {
          const m = JSON.parse(data);
          if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
          if (m.method === 'Page.screencastFrame') {
            const n = frames.length;
            const file = `f${String(n).padStart(5, '0')}.jpg`;
            writeFileSync(`${FRAMES_DIR}/${file}`, Buffer.from(m.params.data, 'base64'));
            frames.push({ file, ts: m.params.metadata.timestamp });
            send('Page.screencastFrameAck', { sessionId: m.params.sessionId });
          }
        });
        return;
      }
    } catch { /* retry */ }
    await sleep(500);
  }
  throw new Error('devtools not reachable');
}

const send = (method, params = {}) => new Promise((resolve) => {
  const id = ++msgId;
  pending.set(id, resolve);
  ws.send(JSON.stringify({ id, method, params }));
});

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.result.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.result.exceptionDetails));
  return r.result.result.value;
}

const snap = () => evaluate(`(() => { const g = window.__game; return {
  state: g.state, wave: g.wave, kills: g.kills, hp: Math.round(g.p.hp),
  enemies: g.enemies.length, fps: g.engine.fps }; })()`);

try {
  await connect();
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: 'http://127.0.0.1:5173/?bot' });
  await send('Page.bringToFront');
  let booted = false;
  for (let i = 0; i < 80; i++) {
    if (await evaluate('!!window.__game').catch(() => false)) { booted = true; break; }
    await sleep(500);
  }
  if (!booted) throw new Error('game boot failed');

  // 初始化音频（标题页就有环境声），并把 master 挂到录音总线
  await evaluate(`(() => { const g = window.__game; g.audio.init();
    window.__audioDest = g.audio.ctx.createMediaStreamDestination();
    g.audio.master.connect(window.__audioDest); return 1; })()`);
  await sleep(4000); // 等着色器编译 / 世界加载
  console.log('warmup:', JSON.stringify(await snap()));

  // 开始录音（记下 epoch 起点用于对齐）
  const audioStartMs = await evaluate(`(() => {
    const mr = new MediaRecorder(window.__audioDest.stream, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 192000 });
    window.__rec = { mr, chunks: [] };
    mr.ondataavailable = (e) => window.__rec.chunks.push(e.data);
    mr.start(250);
    return performance.timeOrigin + performance.now();
  })()`);

  // 开始抓帧
  await send('Page.startScreencast', { format: 'jpeg', quality: 90, maxWidth: W, maxHeight: H, everyNthFrame: 1 });
  const recT0 = Date.now();
  console.log(`recording ${TOTAL}s (${TITLE_SEC}s title + ${TOTAL - TITLE_SEC}s combat)…`);
  await sleep(TITLE_SEC * 1000);

  // 标题 → 开局
  await evaluate('window.__game.audio.uiClick(); window.__game.start()');

  let overAt = 0, lastLog = 0;
  while (Date.now() - recT0 < TOTAL * 1000) {
    await sleep(400);
    const s = await snap();
    if (s.state === 'paused') { await evaluate('window.__game.resume()'); console.log('auto-resume (headless focus quirk)'); }
    if (s.state === 'over') {
      if (!overAt) { overAt = Date.now(); console.log('bot died, showing results…'); }
      else if (Date.now() - overAt > 2600) {
        await evaluate('window.__game.start()');
        overAt = 0;
        console.log('restarted');
      }
    }
    if (Date.now() - lastLog > 5000) {
      lastLog = Date.now();
      const el = (Date.now() - recT0) / 1000;
      console.log(`t=${el.toFixed(0)}s frames=${frames.length} (${(frames.length / el).toFixed(1)}fps)`, JSON.stringify(s));
    }
  }

  await send('Page.stopScreencast');
  const audio = await evaluate(`(async () => {
    const r = window.__rec;
    const done = new Promise((res) => { r.mr.onstop = res; });
    r.mr.stop(); await done;
    const blob = new Blob(r.chunks, { type: 'audio/webm' });
    const f = new FileReader();
    const p = new Promise((res) => { f.onload = () => res(f.result); });
    f.readAsDataURL(blob);
    return { b64: (await p).split(',')[1], bytes: blob.size };
  })()`);
  writeFileSync('shots/.rec-audio.webm', Buffer.from(audio.b64, 'base64'));

  const span = frames[frames.length - 1].ts - frames[0].ts;
  console.log(`captured ${frames.length} frames over ${span.toFixed(2)}s (${(frames.length / span).toFixed(1)}fps), audio ${(audio.bytes / 1024).toFixed(0)}KB`);
  if (frames.length < 100) throw new Error('too few frames captured');

  // 按真实时间戳拼帧
  let list = '';
  for (let i = 0; i < frames.length; i++) {
    const dur = i + 1 < frames.length ? frames[i + 1].ts - frames[i].ts : 1 / 60;
    list += `file '${frames[i].file}'\nduration ${Math.max(0.001, dur).toFixed(6)}\n`;
  }
  list += `file '${frames[frames.length - 1].file}'\n`;
  writeFileSync(`${FRAMES_DIR}/list.txt`, list);

  // 音视频对齐：音频起点 vs 首帧时间戳
  const offset = frames[0].ts - audioStartMs / 1000;
  console.log('audio offset:', offset.toFixed(3), 's');
  execFileSync(FFMPEG, [
    '-y', '-f', 'concat', '-safe', '0', '-i', `${FRAMES_DIR}/list.txt`,
    '-itsoffset', offset.toFixed(3), '-i', 'shots/.rec-audio.webm',
    '-map', '0:v', '-map', '1:a',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '21', '-pix_fmt', 'yuv420p', '-r', '60',
    '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-shortest', OUT,
  ], { stdio: 'inherit' });
  console.log('done:', OUT);
} catch (e) {
  console.error('RECORD ERROR', e.message);
  process.exitCode = 1;
} finally {
  try { ws?.close(); } catch { /* ignore */ }
  chrome.kill();
}