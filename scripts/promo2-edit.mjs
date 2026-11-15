// v2 预告片剪辑：变速(快进/慢动作+运动插值)、变焦冲击、黑边、白闪、×4 徽标、
// 动画章节卡、合成音效(whoosh/sub-drop/riser)、颗粒+暗角。用法：node scripts/promo2-edit.mjs
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync, readFileSync, renameSync, existsSync, copyFileSync } from 'node:fs';
import { REFERENCE_DATE } from '../src/subscriptions.js';

const FF = process.env.LOCALAPPDATA + '/Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-9.0.2-full_build/bin/ffmpeg.exe';
const DIR = 'shots/.promo2-edit';
const ROOT = process.cwd().replace(/\\/g, '/');
const MECHANICS = 'subscriptions-tokens-v1';
const LOCAL_NOTICE = '宣传摆拍 · 纯本地游戏 · 订阅 / Token / 封号 / 保护道具均为虚构 · 无真实 API / 账号 / 支付 / 资料采集';
const M = JSON.parse(readFileSync('shots/.promo2-markers.json', 'utf8'));
const recordedCards = JSON.parse(readFileSync('shots/.promo2-cards.json', 'utf8'));
const mk = M.markers;
if ([M, recordedCards].some(data => data.mechanics !== MECHANICS || data.referenceDate !== REFERENCE_DATE)
  || !['initialPlan', 'plans', 'benefits', 'protections', 'over'].every(name => Number.isFinite(mk?.[name]))) {
  throw new Error('Subscription footage and captions required; manually re-record with the updated promo2-record.mjs before editing.');
}
const CARDS = recordedCards.frames;
mkdirSync(DIR, { recursive: true });
copyFileSync('C:/Windows/Fonts/msyh.ttc', `${DIR}/msyh.ttc`);
writeFileSync(`${DIR}/local-notice.txt`, LOCAL_NOTICE);

function run(args, tag) {
  const r = spawnSync(FF, args, { encoding: 'utf8', maxBuffer: 1024 * 1024 * 64 });
  if (r.status !== 0) { console.error(tag, 'FAILED\n', (r.stderr || '').slice(-3000)); throw new Error(tag + ' failed'); }
  return r.stderr || '';
}
function measureDur(file) {
  const err = run(['-i', file, '-f', 'null', '-'], 'measure ' + file);
  const times = [...err.matchAll(/time=(\d+:\d+:\d+\.\d+)/g)].map((m) => m[1]);
  const [h, m, s] = times[times.length - 1].split(':');
  return +h * 3600 + +m * 60 + +s;
}

const fullDur = measureDur('shots/.promo2-full.webm');
const musicDur = measureDur('shots/.promo2-music.webm');
const musicStart = M.fullStart + (fullDur - musicDur);
console.log(`fullDur=${fullDur.toFixed(2)} musicDur=${musicDur.toFixed(2)} musicStart offset=${(musicStart - M.fullStart).toFixed(2)}`);

// ---- 块表：trans 为到下一块的转场时长（0=硬切） ----
const B = [];
const frames = (name, a, b, o = {}) => B.push(Object.assign({ name, kind: 'frames', a, b, speed: 1, audio: 'full', trans: 0.3, ttype: 'fade' }, o));
const card = (name, c, o = {}) => B.push(Object.assign({ name, kind: 'card', c, speed: 1, audio: 'music', trans: 0.3, ttype: 'fade' }, o));

frames('cold', mk.bossKill + 0.05, mk.bossKill + 0.85, { speed: 0.3, zoom: 1.12, lb: 1, audio: 'music', trans: 0.35, ttype: 'fadeblack' });
card('title', 'c0', { trans: 0.3 });
frames('initialPlan', mk.initialPlan + 0.1, mk.beauty1 - 0.1, { trans: 0.3 });
frames('beauty1', mk.beauty1 + 0.3, mk.beauty1 + 3.5, { audio: 'music', trans: 0.4 });
frames('beauty2', mk.beauty2 + 0.3, mk.beauty2 + 3.1, { audio: 'music', trans: 0.3 });
frames('mont1', mk.cast1 + 0.5, mk.cast1 + 1.2, { zoom: 1.15, audio: 'music', trans: 0 });
frames('mont2', mk.shotgunFire + 0.15, mk.shotgunFire + 0.85, { zoom: 1.15, audio: 'music', trans: 0 });
frames('mont3', mk.dodgeDash - 0.15, mk.dodgeDash + 0.55, { zoom: 1.15, audio: 'music', trans: 0 });
frames('mont4', mk.cast2 + 0.6, mk.cast2 + 1.3, { zoom: 1.15, audio: 'music', trans: 0.3 });
card('card1', 'c1');
frames('ff', mk.ff + 1, mk.ff + 25, { speed: 4, badge: 1, audio: 'music' });
frames('combat1a', mk.combat1 + 0.6, mk.combat1 + 2.6, { trans: 0 });
frames('combat1p', mk.combat1 + 2.6, mk.combat1 + 3.2, { zoom: 1.18, trans: 0 });
frames('combat1b', mk.combat1 + 3.2, mk.combat1 + 5.8, { trans: 0.25 });
frames('shotgun1', mk.shotgunFire - 0.9, mk.shotgunFire + 0.25, { trans: 0 });
frames('shotgunSlow', mk.shotgunFire + 0.25, mk.shotgunFire + 1.15, { speed: 0.3, zoom: 1.1, audio: 'music', trans: 0 });
frames('shotgun2', mk.shotgunFire + 1.15, mk.shotgunFire + 2.6, { trans: 0.25 });
frames('dodge1', mk.dodgeDash - 0.9, mk.dodgeDash + 0.1, { trans: 0 });
frames('dodgeSlow', mk.dodgeDash + 0.1, mk.dodgeDash + 0.9, { speed: 0.4, audio: 'music', trans: 0 });
frames('dodge2', mk.dodgeDash + 0.9, mk.dodgeDash + 1.8, { trans: 0.3 });
frames('bossCu', mk.boss + 0.2, mk.boss + 2.6, { lb: 1, audio: 'music', trans: 0 });
frames('bossFire', mk.boss + 2.9, mk.boss + 5.3, { lb: 1, trans: 0 });
frames('bossRiser', mk.bossKill - 1.2, mk.bossKill, { lb: 1, audio: 'music', trans: 0 });
frames('bossSlow', mk.bossKill, mk.bossKill + 0.9, { speed: 0.3, zoom: 1.12, lb: 1, audio: 'music', trans: 0 });
frames('bossLoot', mk.bossKill + 0.9, mk.bossKill + 2.4, { lb: 1, audio: 'music', trans: 0.3 });
card('card2', 'c2');
frames('skill1', mk.cast1 - 0.15, mk.cast1 + 2.6, { flash: 1, trans: 0.25 });
frames('skill2', mk.cast2 - 0.15, mk.cast2 + 2.6, { flash: 1, trans: 0.25 });
frames('skill3', mk.cast3 - 0.15, mk.cast3 + 2.8, { flash: 1, trans: 0.25 });
frames('skill4', mk.cast4 - 0.15, mk.cast4 + 2.6, { flash: 1, trans: 0.3 });
card('card3', 'c3');
frames('talents', mk.talents + 0.2, mk.skills - 0.3, { speed: 2 });
card('card4', 'c4');
frames('plans', mk.plans + 0.8, mk.benefits - 0.3, { speed: 1.4, trans: 0 });
frames('benefits', mk.benefits + 0.2, mk.protections - 0.3, { speed: 2, trans: 0.25 });
frames('protections', mk.protections + 0.2, mk.over - 0.3, { speed: 1.5, trans: 0.4 });
frames('over', mk.over + 0.8, mk.over + 4.8, { trans: 0.4 });
card('end', 'c5', { trans: 0 });

// ---- 切片 + 编码 ----
let musicCursor = 0.5;
const starts = [];
let acc = 0;
for (let i = 0; i < B.length; i++) {
  const b = B[i];
  let srcFrames, dur;
  if (b.kind === 'frames') {
    srcFrames = M.frames.filter((f) => f.ts >= b.a && f.ts < b.b);
    if (srcFrames.length < 4) throw new Error('block ' + b.name + ' too few frames: ' + srcFrames.length);
    dur = (b.b - b.a) / b.speed;
  } else {
    srcFrames = CARDS[b.c];
    dur = srcFrames[srcFrames.length - 1].ts - srcFrames[0].ts;
  }
  b.dur = dur;
  starts[i] = i === 0 ? 0 : acc - (B[i - 1].trans > 0 ? B[i - 1].trans : 0);
  acc = starts[i] + dur;

  const span = b.kind === 'frames' ? (b.b - b.a) : (srcFrames[srcFrames.length - 1].ts - srcFrames[0].ts + 0.024);
  const list = srcFrames.map((f, j) => {
    const d = j < srcFrames.length - 1 ? srcFrames[j + 1].ts - f.ts : Math.max(0.024, span - (f.ts - srcFrames[0].ts));
    const p = b.kind === 'frames' ? `shots/.promo2-frames/${f.file}` : `shots/.promo2-cards/${b.c}/${f.file}`;
    return `file '${ROOT}/${p}'\nduration ${d.toFixed(4)}`;
  }).join('\n');
  writeFileSync(`${DIR}/${b.name}.txt`, list + '\n');

  const vf = [`setpts=PTS/${b.speed}`];
  vf.push(b.kind === 'frames' && b.speed <= 1 ? 'minterpolate=fps=60:mi_mode=mci:mc_mode=aobmc:vsbmc=1' : 'fps=60');
  if (b.zoom) vf.push(`crop=iw/${b.zoom}:ih/${b.zoom}`, 'scale=1920:1080');
  if (b.lb) vf.push('drawbox=x=0:y=0:w=iw:h=132:color=black:t=fill', 'drawbox=x=0:y=ih-132:w=iw:h=132:color=black:t=fill');
  if (b.flash) vf.push('fade=t=in:st=0:d=0.1:color=white');
  if (b.badge) vf.push(`drawtext=fontfile=${DIR}/msyh.ttc:text=×4:fontsize=60:fontcolor=white@0.9:box=1:boxcolor=black@0.45:boxborderw=16:x=w-tw-56:y=150`);
  if (b.kind === 'frames') vf.push('drawbox=x=0:y=ih-46:w=iw:h=46:color=black@0.7:t=fill',
    `drawtext=fontfile=${DIR}/msyh.ttc:textfile=${DIR}/local-notice.txt:fontsize=22:fontcolor=white:x=(w-tw)/2:y=h-34`);
  vf.push(`tpad=stop_mode=clone:stop_duration=${dur.toFixed(4)}`, `trim=duration=${dur.toFixed(4)}`, 'setpts=PTS-STARTPTS');
  vf.push('setsar=1', 'format=yuv420p');

  let audioArgs, af;
  if (b.audio === 'full') {
    audioArgs = ['-ss', (b.a - M.fullStart).toFixed(3), '-t', (b.b - b.a).toFixed(3), '-i', 'shots/.promo2-full.webm'];
    af = (b.speed !== 1 ? `atempo=${b.speed},` : '') + 'aresample=48000';
  } else {
    let ss = musicCursor;
    if (ss + dur > musicDur - 0.1) ss = Math.max(0, musicDur - 0.1 - dur);
    musicCursor = ss + dur;
    audioArgs = ['-ss', ss.toFixed(3), '-t', dur.toFixed(3), '-i', 'shots/.promo2-music.webm'];
    af = 'aresample=48000';
  }
  af += `,apad=whole_dur=${dur.toFixed(4)},atrim=duration=${dur.toFixed(4)},asetpts=PTS-STARTPTS`;
  run(['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', `${DIR}/${b.name}.txt`,
    ...audioArgs, '-filter_complex', `[0:v]${vf.join(',')}[v];[1:a]${af}[a]`,
    '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-crf', '18', '-preset', 'medium',
    '-c:a', 'aac', '-b:a', '192k', `${DIR}/${b.name}.mp4`], 'block ' + b.name);
  console.log(`block ${b.name}: ${dur.toFixed(2)}s speed=${b.speed} audio=${b.audio} start=${starts[i].toFixed(2)}`);
}
const FP = FF.replace('ffmpeg.exe', 'ffprobe.exe');
const probeDur = (file) => parseFloat(spawnSync(FP, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' }).stdout.trim());
const vdur = B.map((b) => probeDur(`${DIR}/${b.name}.mp4`));
let racc = 0;
for (let i = 0; i < B.length; i++) {
  starts[i] = i === 0 ? 0 : racc - (B[i - 1].trans > 0 ? B[i - 1].trans : 0);
  racc = starts[i] + vdur[i];
}
const total = racc;
console.log(`assembling ${B.length} blocks, total ${total.toFixed(2)}s (actual-duration timeline)…`);

// ---- 拼接（xfade / 硬切） ----
const inputs = B.flatMap((b) => ['-i', `${DIR}/${b.name}.mp4`]);
const g = [];
for (let i = 0; i < B.length; i++) {
  g.push(`[${i}:v]settb=AVTB[fv${i}]`);
  g.push(`[${i}:a]apad=whole_dur=${vdur[i].toFixed(4)},atrim=duration=${vdur[i].toFixed(4)},asetpts=PTS-STARTPTS,asettb=AVTB[fa${i}]`);
}
let pv = '[fv0]', pa = '[fa0]';
for (let i = 1; i < B.length; i++) {
  const d = B[i - 1].trans;
  const ov = `[v${i}]`, oa = `[a${i}]`;
  if (d > 0) {
    g.push(`${pv}[fv${i}]xfade=transition=${B[i - 1].ttype}:duration=${d}:offset=${(starts[i]).toFixed(3)}${ov}`);
    g.push(`${pa}[fa${i}]acrossfade=d=${d}:c1=tri:c2=tri${oa}`);
  } else {
    g.push(`${pv}[fv${i}]concat=n=2:v=1:a=0${ov}`);
    g.push(`${pa}[fa${i}]concat=n=2:v=0:a=1${oa}`);
  }
  pv = ov; pa = oa;
}
writeFileSync(`${DIR}/graph.txt`, g.join(';\n'));
run(['-y', '-loglevel', 'error', ...inputs, '-filter_complex', readFileSync(`${DIR}/graph.txt`, 'utf8'),
  '-map', pv, '-map', pa, '-c:v', 'libx264', '-crf', '18', '-preset', 'medium',
  '-c:a', 'aac', '-b:a', '192k', `${DIR}/assembled.mp4`], 'assembly');

// ---- 合成音效 ----
run(['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'anoisesrc=color=pink:duration=0.6:sample_rate=48000',
  '-af', 'afade=t=in:d=0.08,afade=t=out:st=0.15:d=0.45,volume=0.22', `${DIR}/whoosh.wav`], 'whoosh');
run(['-y', '-loglevel', 'error', '-f', 'lavfi', '-i',
  'aevalsrc=exprs=sin(2*PI*52*t)*exp(-t*4)+0.3*sin(2*PI*110*t)*exp(-t*9):duration=1.1:sample_rate=48000',
  '-af', 'volume=0.6', `${DIR}/drop.wav`], 'drop');
run(['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'anoisesrc=color=white:duration=1.3:sample_rate=48000',
  '-af', 'highpass=f=400,afade=t=in:st=0:d=1.2,volume=0.18', `${DIR}/riser.wav`], 'riser');

const idx = (n) => B.findIndex((b) => b.name === n);
const events = [
  [2, starts[idx('cold')]],
  [1, starts[idx('title')]], [1, starts[idx('card1')]], [1, starts[idx('card2')]],
  [1, starts[idx('card3')]], [1, starts[idx('card4')]], [1, starts[idx('end')]],
  [2, starts[idx('shotgunSlow')]], [2, starts[idx('bossSlow')]],
  [3, starts[idx('bossRiser')]],
];
const sg = [];
const splitCount = { 1: 0, 2: 0, 3: 0 };
for (const [f] of events) splitCount[f]++;
const splitLabels = {};
for (const f of [1, 2, 3]) {
  if (!splitCount[f]) continue;
  splitLabels[f] = Array.from({ length: splitCount[f] }, (_, i) => `[s${f}_${i}]`);
  sg.push(`[${f}:a]asplit=${splitCount[f]}${splitLabels[f].join('')}`);
}
const used = { 1: 0, 2: 0, 3: 0 };
const mixIns = ['[0:a]'];
events.forEach(([f, t], i) => {
  const lb = splitLabels[f][used[f]++];
  const ms = Math.round(t * 1000);
  sg.push(`${lb}adelay=${ms}|${ms}[e${i}]`);
  mixIns.push(`[e${i}]`);
});
sg.push(`${mixIns.join('')}amix=inputs=${mixIns.length}:normalize=0[mix]`);
sg.push(`[mix]alimiter=limit=0.95,afade=t=out:st=${(total - 1.2).toFixed(2)}:d=1.2[aout]`);
sg.push(`[0:v]vignette=PI/5,noise=alls=4:allf=t,format=yuv420p[vout]`);
writeFileSync(`${DIR}/sfx.txt`, sg.join(';\n'));

if (existsSync('videos/guard-duck-promo.mp4') && !existsSync('videos/guard-duck-promo-v1.mp4')) {
  renameSync('videos/guard-duck-promo.mp4', 'videos/guard-duck-promo-v1.mp4');
}
run(['-y', '-loglevel', 'error', '-i', `${DIR}/assembled.mp4`, '-i', `${DIR}/whoosh.wav`, '-i', `${DIR}/drop.wav`, '-i', `${DIR}/riser.wav`,
  '-filter_complex', readFileSync(`${DIR}/sfx.txt`, 'utf8'), '-map', '[vout]', '-map', '[aout]',
  '-c:v', 'libx264', '-crf', '20', '-preset', 'medium', '-c:a', 'aac', '-b:a', '192k',
  '-movflags', '+faststart', 'videos/guard-duck-promo.mp4'], 'final');
console.log('EDIT DONE: videos/guard-duck-promo.mp4', total.toFixed(2) + 's');