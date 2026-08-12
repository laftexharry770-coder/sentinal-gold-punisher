#!/usr/bin/env node
/**
 * Renders the app icons from the in-app shield mark.
 *
 * Uses the headless browser already available for UI checks rather than adding
 * an image dependency. Regenerate with: node scripts/make-icons.mjs
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(repoRoot, 'web/public/icons');

/** @param {number} pad fraction of the canvas kept clear for maskable safe area */
const markup = (pad) => `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;width:512px;height:512px;background:transparent}
  .plate{
    position:absolute; inset:${pad * 512}px;
    border-radius:${pad > 0 ? 96 : 112}px;
    background:linear-gradient(145deg,#60a5fa 0%,#3b82f6 42%,#1d4ed8 100%);
    display:grid; place-items:center;
    box-shadow:inset 0 -18px 44px rgba(2,6,20,.35);
  }
  svg{width:58%;height:58%}
</style></head>
<body>
  <div class="plate">
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M12 2.6 4.8 5.6v6.1c0 4.3 2.9 8.3 7.2 9.5 4.3-1.2 7.2-5.2 7.2-9.5V5.6L12 2.6Z"
            stroke="#ffffff" stroke-width="1.7" stroke-linejoin="round" fill="rgba(255,255,255,.10)"/>
      <path d="M9 12.2l2.2 2.3L15.4 10" stroke="#ffffff" stroke-width="2"
            stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  </div>
</body></html>`;

const targets = [
  { file: 'icon-192.png', size: 192, pad: 0 },
  { file: 'icon-512.png', size: 512, pad: 0 },
  // Maskable icons are cropped to a circle on some launchers, so the mark sits
  // inside the safe area with the plate bleeding to the edges.
  { file: 'icon-maskable-512.png', size: 512, pad: 0.1 },
  { file: 'apple-touch-icon.png', size: 180, pad: 0 },
];

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
await mkdir(outDir, { recursive: true });

for (const { file, size, pad } of targets) {
  const page = await browser.newPage({
    viewport: { width: 512, height: 512 },
    deviceScaleFactor: size / 512,
  });
  await page.setContent(markup(pad), { waitUntil: 'load' });
  const buffer = await page.screenshot({ omitBackground: pad > 0 ? false : true, type: 'png' });
  await writeFile(path.join(outDir, file), buffer);
  await page.close();
  console.log(`${file} (${size}x${size})`);
}

await browser.close();
