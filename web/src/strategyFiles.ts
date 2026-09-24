import type { StrategyFile } from '@sentinal/engine';

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

/**
 * MetaEditor has saved source as UTF-16 for most of its life and as UTF-8
 * lately; both arrive here, with or without a byte-order mark.
 */
export function decodeSource(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder('utf-8').decode(bytes.subarray(3));
  // UTF-16 without a mark: ASCII source leaves every other byte zero.
  let zeros = 0;
  const sample = Math.min(bytes.length, 400);
  for (let i = 1; i < sample; i += 2) if (bytes[i] === 0) zeros += 1;
  if (sample > 8 && zeros > sample / 4) return new TextDecoder('utf-16le').decode(bytes);
  return new TextDecoder('utf-8').decode(bytes);
}

export async function readStrategyFile(file: File): Promise<StrategyFile> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (/\.ex5$/i.test(file.name)) return { name: file.name, content: toBase64(bytes), encoding: 'base64' };
  return { name: file.name, content: decodeSource(bytes), encoding: 'text' };
}

