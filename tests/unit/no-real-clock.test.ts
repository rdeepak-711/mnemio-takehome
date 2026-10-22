import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

// Business time comes from sim_clock (src/clock.ts). Only src/ai/ may read the real clock,
// because OpenRouter's daily quota counts real days (llm_usage).
const SRC = fileURLToPath(new URL('../../src/', import.meta.url));
const ALLOWED = ['ai/'];

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return tsFiles(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

const files = tsFiles(SRC)
  .map((path) => relative(SRC, path).replace(/\\/g, '/'))
  .filter((file) => !ALLOWED.some((prefix) => file.startsWith(prefix)));

describe('no real clock in src/ (outside src/ai/)', () => {
  it('finds the source files', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it.each(files)('%s never calls new Date() without arguments or Date.now()', (file) => {
    const source = readFileSync(join(SRC, file), 'utf8');
    expect(source).not.toMatch(/new Date\(\s*\)/);
    expect(source).not.toMatch(/Date\.now\(/);
  });
});
