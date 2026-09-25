import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isAllowedAttachmentUrl } from '../server/proxy/attachmentProxy.js';
import { createTestContext, type TestContext } from './helpers/context.js';
import { hang } from './helpers/fakeFetch.js';

let ctx: TestContext;
let cookie: string;

beforeEach(async () => {
  ctx = await createTestContext();
  ({ cookie } = await ctx.loginAs());
});
afterEach(async () => {
  await ctx.close();
});

const proxy = (url: string) => ctx.req(`/api/attachment-proxy?url=${encodeURIComponent(url)}`, { cookie });
const S3 = 'https://s3.amazonaws.com/cdn.freshdesk.com/data/helpdesk/attachments/production/5000/original/foto.jpg?X-Amz-Signature=abc';

describe('isAllowedAttachmentUrl', () => {
  it('accepts only exact hosts and path prefixes over https', () => {
    const allow = ctx.deps.config.attachmentAllow;
    const ok = (u: string) => isAllowedAttachmentUrl(new URL(u), allow);
    expect(ok(S3)).toBe(true);
    expect(ok('https://flptest.freshdesk.com/helpdesk/attachments/1')).toBe(true);
    expect(ok('https://attachment.freshdesk.com/inline/attachment?token=x')).toBe(true);
    expect(ok('https://s3.amazonaws.com/some-other-bucket/secret.txt')).toBe(false);
    expect(ok('https://s3-eu-west-1.amazonaws.com/cdn.freshdesk.com/x')).toBe(false);
    expect(ok('http://attachment.freshdesk.com/x')).toBe(false);
    expect(ok('https://attachment.freshdesk.com.evil.com/x')).toBe(false);
    expect(ok('https://other.freshdesk.com/x')).toBe(false);
    expect(ok('https://user:pw@attachment.freshdesk.com/x')).toBe(false);
    expect(ok('https://attachment.freshdesk.com:8443/x')).toBe(false);
  });
});

describe('GET /api/attachment-proxy', () => {
  it('fetches an allowed attachment without credentials and returns it', async () => {
    ctx.fake.on('GET', 'https://s3.amazonaws.com/cdn.freshdesk.com/', () =>
      new Response(Buffer.from('JPEGDATA'), { headers: { 'content-type': 'image/jpeg' } }),
    );
    const res = await proxy(S3);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('JPEGDATA');
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(res.headers.get('cache-control')).toBe('private, max-age=300');
    expect(ctx.fake.calls[0]?.url).toBe(S3);
    expect(ctx.fake.calls[0]?.headers.get('authorization')).toBeNull();
  });

  it('refuses disallowed hosts before any request is made', async () => {
    const res = await proxy('https://169.254.169.254/latest/meta-data');
    expect(res.status).toBe(403);
    expect((await res.json()).error.message).toBe('Domain nicht erlaubt: 169.254.169.254');
    expect((await proxy('not a url')).status).toBe(400);
    expect((await ctx.req('/api/attachment-proxy', { cookie })).status).toBe(400);
    expect(ctx.fake.calls).toHaveLength(0);
  });

  it('re-checks every redirect hop', async () => {
    ctx.fake
      .on('GET', 'https://attachment.freshdesk.com/', () =>
        new Response(null, { status: 302, headers: { location: 'https://s3.amazonaws.com/cdn.freshdesk.com/ok.png' } }),
      )
      .on('GET', 'https://s3.amazonaws.com/cdn.freshdesk.com/ok.png', () =>
        new Response(null, { status: 302, headers: { location: 'https://evil.example/steal' } }),
      );
    const res = await proxy('https://attachment.freshdesk.com/inline/attachment?token=t');
    expect(res.status).toBe(403);
    expect(ctx.fake.calls.map((c) => c.url)).toEqual([
      'https://attachment.freshdesk.com/inline/attachment?token=t',
      'https://s3.amazonaws.com/cdn.freshdesk.com/ok.png',
    ]);
  });

  it('caps the size at 5 MB and maps upstream errors', async () => {
    ctx.fake
      .on('GET', 'https://attachment.freshdesk.com/big', () => new Response(Buffer.alloc(5 * 1024 * 1024 + 1)))
      .on('GET', 'https://attachment.freshdesk.com/gone', () => new Response('nope', { status: 404 }));
    expect((await proxy('https://attachment.freshdesk.com/big')).status).toBe(413);
    const gone = await proxy('https://attachment.freshdesk.com/gone');
    expect(gone.status).toBe(404);
    expect(await gone.json()).toEqual({ error: { type: 'UPSTREAM_ERROR', message: 'Upstream 404' } });
  });

  it('requires a session', async () => {
    expect((await ctx.req(`/api/attachment-proxy?url=${encodeURIComponent(S3)}`)).status).toBe(401);
  });
});

describe('GET /api/attachment-proxy timeouts', () => {
  it('answers 504 when the attachment host does not respond in time, or stalls mid-body', async () => {
    const slow = await createTestContext({ timeouts: { upstreamMs: 50 } });
    try {
      const { cookie: slowCookie } = await slow.loginAs();
      slow.fake
        .on('GET', 'https://attachment.freshdesk.com/hang', hang)
        .on('GET', 'https://attachment.freshdesk.com/stall', (call) =>
          new Response(
            new ReadableStream({
              start(controller) {
                call.signal?.addEventListener('abort', () => controller.error(call.signal?.reason));
              },
            }),
            { headers: { 'content-type': 'image/jpeg' } },
          ),
        );
      for (const url of ['https://attachment.freshdesk.com/hang', 'https://attachment.freshdesk.com/stall']) {
        const res = await slow.req(`/api/attachment-proxy?url=${encodeURIComponent(url)}`, { cookie: slowCookie });
        expect(res.status, url).toBe(504);
        expect((await res.json()).error.type, url).toBe('UPSTREAM_TIMEOUT');
      }
    } finally {
      await slow.close();
    }
  });
});
