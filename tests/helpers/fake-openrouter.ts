import http from 'node:http';
import type { AddressInfo } from 'node:net';

// A local stand-in for OpenRouter's /chat/completions: per model, a queue of scripted answers; every request is
// recorded. An empty queue answers 500. `respond`, when set, answers before the queues.

export type Script = { status: number; content?: string; body?: unknown };
export type Seen = { model: string; body: Record<string, unknown> };

export type FakeOpenRouter = {
  baseUrl: string;
  seen: Seen[];
  scripts: Record<string, Script[]>;
  // When set, answers every request first; returning undefined falls through to the scripts.
  respond?: ((body: Record<string, unknown>) => Script | undefined) | undefined;
  reset(): void;
  close(): Promise<void>;
};

export const okJson = (value: unknown): Script => ({ status: 200, content: JSON.stringify(value) });
export const okText = (content: string): Script => ({ status: 200, content });
export const failWith = (code: number): Script => ({ status: code, body: { error: { code } } });

// The text of the last user message the fake received for a model.
export function lastPrompt(fake: FakeOpenRouter, model?: string): string {
  const hits = fake.seen.filter((s) => model === undefined || s.model === model);
  const messages = (hits.at(-1)?.body.messages ?? []) as { role: string; content: string }[];
  return messages.map((m) => m.content).join('\n');
}

export async function startFakeOpenRouter(): Promise<FakeOpenRouter> {
  const fake: FakeOpenRouter = {
    baseUrl: '',
    seen: [],
    scripts: {},
    reset() {
      fake.seen.length = 0;
      fake.respond = undefined;
      for (const key of Object.keys(fake.scripts)) delete fake.scripts[key];
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as Record<string, unknown>;
      const model = String(body.model);
      fake.seen.push({ model, body });
      const next = fake.respond?.(body) ?? fake.scripts[model]?.shift() ?? failWith(500);
      res.writeHead(next.status, { 'Content-Type': 'application/json' });
      const payload =
        next.content !== undefined
          ? { id: 'x', model, choices: [{ message: { role: 'assistant', content: next.content } }] }
          : next.body;
      res.end(JSON.stringify(payload));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  fake.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return fake;
}
