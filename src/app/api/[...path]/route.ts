// Same-origin streaming gateway only. Business logic, credentials and storage live in Fastify.
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
async function proxy(req: Request) {
  const backend = new URL(process.env.API_INTERNAL_URL || 'http://127.0.0.1:3101');
  const incoming = new URL(req.url); const target = new URL(incoming.pathname + incoming.search, backend);
  const headers = new Headers(req.headers);
  for (const name of ['connection','transfer-encoding','keep-alive','proxy-authenticate','proxy-authorization','upgrade','x-forwarded-host','x-forwarded-proto','x-forwarded-for']) headers.delete(name);
  try {
    // Node's HTTP client preserves the original Host. Fetch may replace it with
    // the internal service hostname, breaking the API's same-origin checks.
    return await new Promise<Response>((resolve, reject) => {
      const upstream = (target.protocol === 'https:' ? httpsRequest : httpRequest)(target, {
        method: req.method, headers: Object.fromEntries(headers), signal: req.signal,
      }, result => {
        const outgoing = new Headers();
        for (let index = 0; index < result.rawHeaders.length; index += 2) outgoing.append(result.rawHeaders[index], result.rawHeaders[index + 1]);
        for (const name of ['connection','transfer-encoding','keep-alive']) outgoing.delete(name);
        const body = req.method === 'HEAD' || [204,304].includes(result.statusCode || 200) ? null : Readable.toWeb(result) as ReadableStream<Uint8Array>;
        resolve(new Response(body, { status: result.statusCode || 502, headers: outgoing }));
      });
      upstream.once('error', reject);
      if (req.body && !['GET','HEAD'].includes(req.method)) {
        const body = Readable.fromWeb(req.body as any);
        body.once('error', error => upstream.destroy(error));
        body.pipe(upstream);
      } else upstream.end();
    });
  } catch {
    return Response.json({ error: '后端服务暂不可用，请稍后重试' }, { status: 502, headers: { 'Cache-Control': 'no-store' } });
  }
}
export const GET = proxy;
export const HEAD = proxy;
export const POST = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
export const OPTIONS = proxy;
