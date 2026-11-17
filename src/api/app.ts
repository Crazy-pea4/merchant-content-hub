import Fastify from 'fastify';
import { Readable } from 'node:stream';
import { handleApi } from '../server/http';
import { databaseReady } from '../server/db';
import { maxUploadBytes } from '../server/media';
import { allowedOrigins } from './config';

export async function createApi() {
  await databaseReady;
  const origins = allowedOrigins();
  const app = Fastify({ logger: false, bodyLimit: Math.max(maxUploadBytes() + 2 * 1024 * 1024, 12 * 1024 * 1024), requestTimeout: 180000 });
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', (_request, payload, done) => done(null, payload));
  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'no-referrer').header('Cache-Control', 'no-store');
    const origin = request.headers.origin;
    if (origin && origins.includes(origin)) {
      reply.header('Access-Control-Allow-Origin', origin).header('Access-Control-Allow-Credentials', 'true').header('Vary', 'Origin');
      if (request.method === 'OPTIONS') return reply.header('Access-Control-Allow-Methods', 'GET,HEAD,POST,PATCH,DELETE,OPTIONS').header('Access-Control-Allow-Headers', 'Authorization,Content-Type,Range').code(204).send();
    }
    if (request.method === 'OPTIONS') return reply.code(403).send({ error: '不允许跨来源请求' });
  });
  app.route({ method: ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE'], url: '/api/*', handler: async (request, reply) => {
    const controller = new AbortController();
    const abort = () => { if (!reply.raw.writableFinished) controller.abort(); };
    request.raw.once('aborted', abort); reply.raw.once('close', abort);
    const headers = new Headers();
    for (const [key,value] of Object.entries(request.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
    const url = new URL(request.raw.url || '/', `${request.protocol}://${request.headers.host}`);
    const method = request.method === 'HEAD' ? 'GET' : request.method;
    const init: RequestInit & { duplex?: 'half' } = { method, headers, signal: controller.signal };
    if (!['GET','HEAD'].includes(method)) { init.body = Readable.toWeb(request.body instanceof Readable ? request.body : request.raw) as ReadableStream<Uint8Array>; init.duplex = 'half'; }
    try {
      const response = await handleApi(new Request(url, init), url.pathname.slice(5).split('/').map(decodeURIComponent));
      reply.code(response.status); response.headers.forEach((value,key) => reply.header(key,value));
      return reply.send(request.method === 'HEAD' || !response.body ? undefined : Readable.fromWeb(response.body as any));
    } finally { request.raw.removeListener('aborted', abort); }
  } });
  app.setErrorHandler((error, _request, reply) => {
    const status = (error as { statusCode?: number }).statusCode;
    reply.code(status === 413 ? 413 : 400).send({ error: status === 413 ? '请求体超过大小限制' : '请求格式无效或处理失败' });
  });
  app.setNotFoundHandler((_request,reply) => reply.code(404).send({ error: '接口不存在' }));
  return app;
}
