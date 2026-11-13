/**
 * 跨平台定位 Chrome/Chromium 与可写 user-data-dir。
 * e2e / playtest 共用，避免写死 Windows 路径。本模块不启动浏览器。
 */
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 静态候选（不含环境变量），便于单测断言 Linux + Windows 均在列表中。 */
export const CHROME_STATIC_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/snap/bin/chromium',
];

export const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  process.env.CHROME,
  ...CHROME_STATIC_CANDIDATES,
].filter((p) => typeof p === 'string' && p.length > 0);

export function findChrome(exists = existsSync, candidates = CHROME_CANDIDATES) {
  for (const p of candidates) {
    if (exists(p)) return p;
  }
  return null;
}

/** 仓库内 shots/.{name}，不再写死 D:/Code/swyy。 */
export function chromeUserDataDir(name = 'chrome-profile', repoRoot = REPO_ROOT) {
  const dir = join(repoRoot, 'shots', `.${name}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}
