// Pull the latin subset of the brand fonts so the standalone page needs no CDN.
const families = [
  ['Hanken+Grotesk', 'HankenGrotesk', [400, 600, 800]],
  ['JetBrains+Mono', 'JetBrainsMono', [400, 600]],
];
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36';
const out = [];
for (const [query, label, weights] of families) {
  const css = await (await fetch(
    `https://fonts.googleapis.com/css2?family=${query}:wght@${weights.join(';')}&display=swap`,
    { headers: { 'User-Agent': UA } },
  )).text();

  // Keep only the plain latin block for each weight — it carries the glyphs the
  // terminal actually renders and keeps the payload small.
  const blocks = css.split('@font-face').slice(1);
  for (const weight of weights) {
    const block = blocks.find(
      (b) => b.includes(`font-weight: ${weight};`) && b.includes('U+0000-00FF'),
    );
    if (!block) { console.error('missing latin block', label, weight); continue; }
    const url = block.match(/url\((https:[^)]+)\)/)?.[1];
    const buf = Buffer.from(await (await fetch(url, { headers: { 'User-Agent': UA } })).arrayBuffer());
    out.push({ label, weight, bytes: buf.length, b64: buf.toString('base64') });
    console.log(label, weight, (buf.length / 1024).toFixed(1) + 'KB');
  }
}
const css = out
  .map(
    (f) => `@font-face{font-family:'${f.label === 'HankenGrotesk' ? 'Hanken Grotesk' : 'JetBrains Mono'}';font-style:normal;font-weight:${f.weight};font-display:swap;src:url(data:font/woff2;base64,${f.b64}) format('woff2')}`,
  )
  .join('\n');
await (await import('node:fs/promises')).writeFile('web/src/fonts-embedded.css', css);
console.log('total', (css.length / 1024).toFixed(0) + 'KB of CSS');
