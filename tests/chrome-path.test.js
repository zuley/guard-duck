import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CHROME_STATIC_CANDIDATES,
  CHROME_CANDIDATES,
  findChrome,
  chromeUserDataDir,
} from '../scripts/chrome-path.mjs';

describe('chrome-path 可移植性', () => {
  it('静态候选同时包含 Windows 与 Linux 路径', () => {
    const s = CHROME_STATIC_CANDIDATES.join('\n');
    expect(s).toMatch(/chrome\.exe/);
    expect(s).toMatch(/C:\/Program Files/);
    expect(s).toMatch(/\/usr\/bin\/google-chrome/);
    expect(s).toMatch(/\/usr\/bin\/chromium/);
  });

  it('CHROME_CANDIDATES 至少包含全部静态路径', () => {
    for (const p of CHROME_STATIC_CANDIDATES) {
      expect(CHROME_CANDIDATES).toContain(p);
    }
  });

  it('findChrome 尊重 exists 回调，全部不存在时返回 null', () => {
    expect(findChrome(() => false)).toBe(null);
    const hit = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
    expect(findChrome((p) => p === hit)).toBe(hit);
    expect(findChrome((p) => p === '/usr/bin/google-chrome-stable')).toBe('/usr/bin/google-chrome-stable');
  });

  it('若本机找到 Chrome，路径必须来自候选列表且确实存在（不启动浏览器）', () => {
    const found = findChrome();
    if (found === null) return; // 环境无浏览器不算失败
    expect(CHROME_CANDIDATES).toContain(found);
    expect(existsSync(found)).toBe(true);
  });

  it('chromeUserDataDir 写在给定仓库的 shots/ 下，不再写死 D:/Code/swyy', () => {
    const root = mkdtempSync(join(tmpdir(), 'gd-chrome-'));
    try {
      const dir = chromeUserDataDir('unit-profile', root);
      expect(dir).toBe(join(root, 'shots', '.unit-profile'));
      expect(existsSync(dir)).toBe(true);
      expect(dir).not.toMatch(/D:\\Code\\swyy|D:\/Code\/swyy/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('e2e 与 playtest 通过 helper 取 Chrome 路径和 user-data-dir', () => {
    const e2e = readFileSync(new URL('../scripts/e2e.mjs', import.meta.url), 'utf8');
    const pt = readFileSync(new URL('../scripts/playtest.mjs', import.meta.url), 'utf8');
    for (const src of [e2e, pt]) {
      expect(src).toContain("from './chrome-path.mjs'");
      expect(src).toContain('findChrome()');
      expect(src).toContain('chromeUserDataDir(');
      expect(src).not.toMatch(/D:\/Code\/swyy/);
      expect(src).not.toContain("const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'");
    }
  });
});
