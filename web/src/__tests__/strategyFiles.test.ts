import { describe, expect, it } from 'vitest';
import { decodeSource, readStrategyFile, toBase64 } from '../strategyFiles';

const SOURCE = '//+---+\n#property version "1.00"\ninput double InpLots = 0.01; // Lot size\nvoid OnTick() {}\n';

function utf16le(text: string, bom: boolean): Uint8Array {
  const bytes = new Uint8Array(text.length * 2 + (bom ? 2 : 0));
  let o = 0;
  if (bom) {
    bytes[o++] = 0xff;
    bytes[o++] = 0xfe;
  }
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    bytes[o++] = code & 0xff;
    bytes[o++] = code >> 8;
  }
  return bytes;
}

describe('reading uploaded EA files', () => {
  it('reads every encoding MetaEditor has saved source in', () => {
    expect(decodeSource(new TextEncoder().encode(SOURCE))).toBe(SOURCE);
    expect(decodeSource(new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(SOURCE)]))).toBe(SOURCE);
    expect(decodeSource(utf16le(SOURCE, true))).toBe(SOURCE);
    expect(decodeSource(utf16le(SOURCE, false))).toBe(SOURCE);
  });

  it('keeps an .ex5 byte for byte, as base64', async () => {
    const bytes = new Uint8Array(new ArrayBuffer(70_000)).map((_, i) => (i * 131) % 256);
    const file = new File([bytes.buffer as ArrayBuffer], 'Angel_Bot.ex5');
    const read = await readStrategyFile(file);
    expect(read.encoding).toBe('base64');
    expect(read.content).toBe(toBase64(bytes));
    expect(Uint8Array.from(atob(read.content), (c) => c.charCodeAt(0))).toEqual(bytes);
  });

  it('reads an .mq5 as text', async () => {
    const read = await readStrategyFile(new File([utf16le(SOURCE, true).buffer as ArrayBuffer], 'Angel_Bot.mq5'));
    expect(read).toEqual({ name: 'Angel_Bot.mq5', content: SOURCE, encoding: 'text' });
  });
});
