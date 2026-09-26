import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const FIXTURES = ["text-only", "tool-call-args", "text-and-tool-gemini", "reasoning-claude"];

export function fixture(name: string): Uint8Array {
  return readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)));
}

/** A stream that emits `bytes` in chunks of the given sizes (cycled). */
export function chunked(bytes: Uint8Array, sizes: number[] = [bytes.length]): ReadableStream {
  let pos = 0;
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pos >= bytes.length) {
        controller.close();
        return;
      }
      const n = Math.max(1, sizes[i++ % sizes.length] ?? 1);
      controller.enqueue(bytes.slice(pos, pos + n));
      pos += n;
    },
  });
}

/** Random chunk sizes between 1 and max, from a seeded PRNG so failures reproduce. */
export function randomSizes(seed: number, count = 64, max = 7): number[] {
  let s = seed;
  const out: number[] = [];
  for (let k = 0; k < count; k++) {
    s = (s * 1103515245 + 12345) % 2 ** 31;
    out.push(1 + (s % max));
  }
  return out;
}
