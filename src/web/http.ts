import { BadRequest, SimBusy } from './errors';

// Runs a route's work and turns the result into JSON: 200, 400 for BadRequest, 409 for SimBusy, 500 otherwise.
// A Response returned by fn (a 404, say) is passed through as it is.
export async function handle(fn: () => Promise<unknown>): Promise<Response> {
  try {
    const value = await fn();
    return value instanceof Response ? value : Response.json(value);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = err instanceof BadRequest ? 400 : err instanceof SimBusy ? 409 : 500;
    return Response.json({ error: message }, { status });
  }
}

// The request body as JSON; an empty or malformed body is a BadRequest.
export async function readJson(req: Request): Promise<unknown> {
  const text = await req.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new BadRequest('body: expected JSON');
  }
}
