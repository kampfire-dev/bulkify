import { createReadStream } from "fs";
import { createInterface } from "readline";

export async function* processFileLineByLine(path: string) {
  const readStream = createReadStream(path, { encoding: "utf8" });
  const rl = createInterface({
    input: readStream,
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    yield line;
  }
}

export function wait(ms: number) {
  return new Promise<void>((resolve) => setTimeout(() => resolve(), ms));
}

export function isArray<T>(value: T | T[]): value is T[] {
  return Array.isArray(value);
}
