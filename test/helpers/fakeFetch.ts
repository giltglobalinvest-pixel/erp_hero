export interface FakeCall {
  method: string;
  url: string;
  headers: Headers;
  body: Buffer | null;
  signal: AbortSignal | null;
}

type Responder = (call: FakeCall) => Response | Promise<Response>;

/** Scriptable stand-in for fetch: records every call, answers from registered routes. */
export class FakeFetch {
  readonly calls: FakeCall[] = [];
  private readonly routes: { method: string; prefix: string; respond: Responder }[] = [];

  on(method: string, urlPrefix: string, respond: Responder): this {
    this.routes.push({ method, prefix: urlPrefix, respond });
    return this;
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const body = request.body ? Buffer.from(await request.arrayBuffer()) : null;
    const call: FakeCall = {
      method: request.method,
      url: request.url,
      headers: request.headers,
      body,
      signal: init?.signal ?? null,
    };
    this.calls.push(call);
    const route = this.routes.find((r) => r.method === call.method && call.url.startsWith(r.prefix));
    if (!route) throw new Error(`Unexpected upstream call: ${call.method} ${call.url}`);
    return route.respond(call);
  };
}

export const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/** Never settles until the request is aborted (for timeout tests). */
export const hang = (call: FakeCall): Promise<Response> =>
  new Promise((_resolve, reject) => {
    call.signal?.addEventListener('abort', () => reject(call.signal?.reason));
  });
