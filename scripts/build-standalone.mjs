#!/usr/bin/env node
/**
 * Folds the standalone Vite output into one self-contained HTML file, then
 * emits an artifact variant containing only page content (no document
 * wrapper), which is the shape a hosted artifact page expects.
 *
 * Run after `npm run build:standalone --workspace web`.
 */
import { readFile, writeFile, rm, readdir, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve against the repo root, not the caller's cwd — npm runs this from the
// web workspace.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(repoRoot, 'web/dist-standalone');
const htmlPath = path.join(dist, 'index.html');

/**
 * Neutralises the only two sequences that can end an inline script element
 * early: a closing tag, and the comment opener that puts the parser into its
 * double-escaped state. Both become no-op backslash escapes inside JS string
 * and regex literals, so the code's behaviour is unchanged.
 */
const escapeScript = (code) => code.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');

async function main() {
  let html = await readFile(htmlPath, 'utf8');
  const assetDir = path.join(dist, 'assets');
  const assets = await readdir(assetDir).catch(() => []);

  let inlinedJs = 0;
  let inlinedCss = 0;

  for (const name of assets) {
    const contents = await readFile(path.join(assetDir, name), 'utf8');
    const quoted = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // Bundled code contains sequences like `$&` (React's key escaping). Passing
    // it as a replacement *string* would expand those as backreferences and
    // splice the matched tag into the middle of the script, so always replace
    // through a function.
    if (name.endsWith('.js')) {
      const scriptTag = new RegExp(`<script[^>]*src="[^"]*${quoted}"[^>]*>\\s*</script>`, 'g');
      if (scriptTag.test(html)) inlinedJs += 1;
      html = html
        .replace(scriptTag, () => `<script type="module">${escapeScript(contents)}</script>`)
        // Preload hints for a file that no longer exists would 404.
        .replace(new RegExp(`<link[^>]*(?:modulepreload|preload)[^>]*href="[^"]*${quoted}"[^>]*>`, 'g'), '');
    } else if (name.endsWith('.css')) {
      const linkTag = new RegExp(`<link[^>]*href="[^"]*${quoted}"[^>]*>`, 'g');
      if (linkTag.test(html)) inlinedCss += 1;
      html = html.replace(linkTag, () => `<style>${contents}</style>`);
    }
  }

  if (inlinedJs === 0) throw new Error('no script tag was inlined — check the build output');
  if (inlinedCss === 0) throw new Error('no stylesheet was inlined — check the build output');

  // Check the markup only: an inlined bundle may legitimately contain asset
  // paths inside its own JavaScript strings.
  const markupOnly = html
    .replace(/<script[\s\S]*?<\/script>/gi, '<script></script>')
    .replace(/<style[\s\S]*?<\/style>/gi, '<style></style>');
  const leftover = markupOnly.match(/(?:src|href)="[^"]*assets\/[^"]*"/g);
  if (leftover) throw new Error(`asset references remain in the page: ${leftover.join(', ')}`);

  // Exactly one closing tag per inlined script: an unescaped `</script` inside
  // the bundle would truncate the element and dump the rest of the code into
  // the page as text. (A bare `<script` inside the code is harmless — only
  // `</script` and `<!--` can end the element.)
  const closes = (html.match(/<\/script>/gi) ?? []).length;
  if (closes !== inlinedJs) {
    throw new Error(`expected ${inlinedJs} inline script(s), found ${closes} closing tag(s)`);
  }

  await writeFile(htmlPath, html);
  await rm(assetDir, { recursive: true, force: true });

  // Static hosts serve 404.html for unknown paths. Shipping the app there means
  // a mistyped or deep URL still opens the terminal instead of a host error.
  await writeFile(path.join(dist, '404.html'), html);

  // Artifact variant: page content only, since the host supplies the document
  // wrapper. Keep the title so the tab and gallery card are named correctly.
  const title = html.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? 'Sentinal MT5';
  const head = html.slice(html.indexOf('<head>') + 6, html.indexOf('</head>'));
  const body = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>'));
  // The artifact is a lone file: manifest, icons and the worker are not served
  // alongside it, so their tags are dropped rather than left to 404. The app
  // treats a missing manifest link as "no service worker here".
  const artifactHead = head
    .replace(/<title>[\s\S]*?<\/title>/, '')
    .replace(/<meta charset[^>]*>/, '')
    .replace(/<link[^>]*rel="(?:manifest|icon|apple-touch-icon)"[^>]*>/g, '')
    .trim();
  const artifact = `<title>${title}</title>\n${artifactHead}\n${body.trim()}\n`;

  // Markup only — the inlined bundle mentions rel="manifest" in its own code.
  const artifactMarkup = artifact.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');
  if (/rel="(?:manifest|icon|apple-touch-icon)"/.test(artifactMarkup)) {
    throw new Error('artifact still references files it does not ship');
  }

  await mkdir(path.join(repoRoot, 'web/dist-artifact'), { recursive: true });
  await writeFile(path.join(repoRoot, 'web/dist-artifact/sentinal-mt5.html'), artifact);

  const kb = (s) => `${(Buffer.byteLength(s) / 1024).toFixed(0)} kB`;
  console.log(`standalone: web/dist-standalone/index.html (${kb(html)})`);
  console.log(`artifact:   web/dist-artifact/sentinal-mt5.html (${kb(artifact)})`);
}

await main();
