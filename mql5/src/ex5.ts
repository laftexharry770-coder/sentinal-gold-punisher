/**
 * Compiled experts (.ex5).
 *
 * An .ex5 is MetaQuotes' compiled, encrypted bytecode. Only a MetaTrader
 * terminal can execute it — there is no published format and no licensed way
 * to run or decompile it elsewhere, and MetaApi's cloud terminals accept
 * custom experts only for MT4 G1 accounts. So an uploaded .ex5 is identified
 * and fingerprinted, and the platform switches to mirror mode: the EA runs in
 * the operator's own MT5 on the master account, and the site copies every
 * position it opens onto the followers.
 */

export interface Ex5Info {
  name: string;
  size: number;
  /** SHA-256 of the file, so the dashboard can show exactly which build is in use. */
  sha256: string;
  /** False when the bytes look like text — usually an .mq5 renamed by mistake. */
  looksCompiled: boolean;
}

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function inspectEx5(name: string, bytes: Uint8Array): Promise<Ex5Info> {
  const sample = bytes.subarray(0, Math.min(bytes.length, 4096));
  let control = 0;
  for (const b of sample) if (b === 0 || (b < 9 && b !== 0)) control += 1;
  const looksCompiled = sample.length > 0 && control / sample.length > 0.01;
  const subtle = (globalThis as { crypto?: { subtle?: { digest(algorithm: string, data: ArrayBuffer): Promise<ArrayBuffer> } } }).crypto?.subtle;
  const copy = bytes.slice().buffer as ArrayBuffer;
  const digest = subtle ? hex(await subtle.digest('SHA-256', copy)) : '';
  return { name: name.replace(/^.*[\\/]/, ''), size: bytes.length, sha256: digest, looksCompiled };
}
