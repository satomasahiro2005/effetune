import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { chromium } from 'playwright';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const css = read('../../css/effetune-theme.css') +
  read('../../css/effetune.css').replace('@import url("effetune-theme.css");', '');

test('long artist and title do not move desktop playback controls', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 720 } });
    for (const expanded of [false, true]) {
      await page.setContent(`
        <body class="layout-desktop">
          <div class="audio-player" ${expanded ? 'data-expanded="true"' : ''}>
            <h2>Player</h2>
            <div class="player-artwork"></div>
            <div class="track-name-container"><div class="track-name">Artist - Title</div></div>
            <div class="player-controls">
              <input type="range" class="seek-bar">
              <div class="time-display">00:00</div>
              ${'<button class="player-button">▶</button>'.repeat(10)}
              <div class="player-playlist"></div>
            </div>
          </div>
          <div class="main-container" style="width: 1350px"></div>
        </body>`);
      await page.addStyleTag({ content: css });
      await page.evaluate(() => Promise.all(document.getAnimations().map(animation => animation.finished)));

      const measure = () => page.evaluate(() => {
        const rect = selector => document.querySelector(selector).getBoundingClientRect();
        const name = document.querySelector('.track-name');
        return {
          pageWidth: document.documentElement.scrollWidth,
          viewportWidth: window.innerWidth,
          controlsLeft: rect('.player-controls').left,
          seekLeft: rect('.seek-bar').left,
          lastButtonRight: document.querySelector('.player-controls .player-button:last-of-type')
            .getBoundingClientRect().right,
          trackRight: rect('.track-name-container').right,
          nameRight: name.getBoundingClientRect().right,
          nameClipped: name.scrollWidth > name.clientWidth
        };
      });
      const before = await measure();
      await page.locator('.track-name').evaluate(element => {
        element.textContent = `${'Very Long Artist '.repeat(30)} - ${'Very Long Title '.repeat(30)}`;
      });
      const after = await measure();

      assert.equal(after.pageWidth, before.pageWidth, 'track metadata must not widen the page');
      assert.equal(after.controlsLeft, before.controlsLeft, 'transport controls must stay in place');
      assert.equal(after.seekLeft, before.seekLeft, 'seek bar must stay in place');
      assert.ok(after.lastButtonRight <= after.viewportWidth, 'transport buttons must remain visible');
      assert.ok(after.nameRight <= after.trackRight, 'track name must remain inside its container');
      assert.equal(after.nameClipped, true, 'long track name should be clipped');
    }
  } finally {
    await browser.close();
  }
});
