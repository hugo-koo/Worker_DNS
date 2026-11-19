/**
 * @file handler.ts
 * @description HTTP/HTTPS request dispatch handler adapting Node.js requests to Web Fetch standard.
 */

import http from 'node:http';
import { Buffer } from 'node:buffer';
import worker from '../../app';
import { Env, ExecutionContext } from '../../types';
import { extractClientIp, isTrustedProxySocket, sanitizeClientIp } from './clientIp';
import { ACCESS_KEY_REGEX } from '../../utils/validator';

/**
 * Creates a shared request dispatch handler for Node.js http and https servers.
 *
 * @param env - Application Env bindings.
 * @param defaultProto - Default protocol ('http' or 'https').
 * @param host - Bound host address.
 * @param port - Bound port number.
 * @param httpsRedirect - Optional redirect settings to upgrade plain HTTP to HTTPS.
 * @returns Request handler callback for http/https.createServer.
 */
export function createHttpRequestHandler(
  env: Env,
  defaultProto: 'http' | 'https',
  host: string,
  port: number,
  httpsRedirect?: { enabled: boolean; httpsPort: number }
): (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void> {
  const isValidHostHeader = (raw: string): boolean => {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.length > 255) return false;
    return /^(?:[a-zA-Z0-9.-]+|\[[0-9a-fA-F:]+\])(?::\d{1,5})?$/.test(trimmed);
  };

  const MAX_DOH_BODY_BYTES = 64 * 1024;
  const MAX_API_BODY_BYTES = 2 * 1024 * 1024;

  return async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    try {
      const fromTrustedProxy = isTrustedProxySocket(req.socket.remoteAddress, env.TRUSTED_PROXIES);
      const forwardedProto = fromTrustedProxy
        ? (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim().toLowerCase()
        : undefined;
      const proto = (forwardedProto === 'http' || forwardedProto === 'https') ? forwardedProto : defaultProto;

      const fallbackHost = `${host.includes(':') ? `[${host}]` : host}:${port}`;
      const rawHostHeader = (req.headers[':authority'] as string) || req.headers.host || '';
      const safeHostHeader = isValidHostHeader(rawHostHeader) ? rawHostHeader.trim() : fallbackHost;

      // When TLS certificates are configured and HTTPS is active, automatically redirect plain HTTP requests to HTTPS
      if (defaultProto === 'http' && httpsRedirect?.enabled && forwardedProto !== 'https') {
        const hostname = safeHostHeader.replace(/:\d+$/, '');
        const targetPort = (httpsRedirect.httpsPort === 443 || httpsRedirect.httpsPort === 0) ? '' : `:${httpsRedirect.httpsPort}`;
        const safePath = (req.url || '/').startsWith('/') ? (req.url || '/') : '/';
        const targetUrl = `https://${hostname}${targetPort}${safePath}`;

        res.statusCode = (req.method === 'GET' || req.method === 'HEAD') ? 301 : 307;
        res.setHeader('Location', targetUrl);
        res.setHeader('Connection', 'close');
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end(`Redirecting to ${targetUrl}`);
        return;
      }

      const fullUrl = new URL(req.url || '/', `${proto}://${safeHostHeader}`);

      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        // Skip HTTP/2 pseudo-headers (:path, :authority, :method, :scheme) which are invalid in Web Fetch Headers
        if (!v || k.startsWith(':')) continue;
        if (Array.isArray(v)) {
          v.forEach((val) => headers.append(k, val));
        } else {
          headers.set(k, String(v));
        }
      }
      // Preserve trusted reverse-proxy client protocol (e.g. Caddy `header_up X-Http-Version {http.request.proto}`)
      // so RFC 8484 §5.2 evaluates the client-to-proxy protocol rather than the proxy-to-origin HTTP/1.1 hop.
      const rawTrustedProtoHeader = fromTrustedProxy ? req.headers['x-http-version'] : undefined;
      const trustedHttpVersion =
        typeof rawTrustedProtoHeader === 'string' &&
        /^(?:HTTP\/)?\d+(?:\.\d+)?$/i.test(rawTrustedProtoHeader.trim())
          ? rawTrustedProtoHeader.trim()
          : undefined;
      headers.set('X-Http-Version', trustedHttpVersion || req.httpVersion);

      // Populate remote client IP (supports direct connections, Cloudflare, Caddy, Nginx)
      const incomingCfIp = sanitizeClientIp(headers.get('CF-Connecting-IP'));
      const clientIp = extractClientIp(headers, req.socket.remoteAddress, env.TRUSTED_PROXIES);
      headers.set('CF-Connecting-IP', clientIp);

      // Strip Cloudflare geolocation headers when the socket is untrusted or the resolved client IP
      // does not match incoming CF-Connecting-IP, preventing stale/spoofed geo mismatches.
      if (!fromTrustedProxy || !incomingCfIp || incomingCfIp !== clientIp) {
        const cfGeoHeaders = [
          'CF-IPCountry',
          'CF-Region',
          'CF-IPCity',
          'CF-Timezone',
          'CF-ASN',
          'CF-AS-Org',
          'CF-IPLatitude',
          'CF-IPLongitude',
        ];
        for (const h of cfGeoHeaders) {
          headers.delete(h);
        }
      }

      // Populate fallback geolocation coordinates for serverfull environments without Cloudflare edge proxy
      const currentLatHeader = headers.get('CF-IPLatitude');
      if (!currentLatHeader || currentLatHeader.trim() === '') {
        headers.set('CF-IPLatitude', '0.0');
      }
      const currentLonHeader = headers.get('CF-IPLongitude');
      if (!currentLonHeader || currentLonHeader.trim() === '') {
        headers.set('CF-IPLongitude', '0.0');
      }

      let body: any = null;
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        const isDnsQuery = !fullUrl.pathname.startsWith('/api/') && ACCESS_KEY_REGEX.test(fullUrl.pathname.slice(1));
        const maxBodyBytes = isDnsQuery ? MAX_DOH_BODY_BYTES : MAX_API_BODY_BYTES;
        const declaredLength = Number(req.headers['content-length']);
        if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
          res.statusCode = 413;
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.end('Payload Too Large');
          req.destroy();
          return;
        }
        const chunks: Buffer[] = [];
        let totalBytes = 0;
        for await (const chunk of req) {
          const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
          totalBytes += buf.length;
          if (totalBytes > maxBodyBytes) {
            res.statusCode = 413;
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.end('Payload Too Large');
            req.destroy();
            return;
          }
          chunks.push(buf);
        }
        body = Buffer.concat(chunks);
      }

      const request = new Request(fullUrl.toString(), {
        method: req.method,
        headers,
        body,
        // @ts-ignore
        duplex: 'half'
      });

      const ctx: ExecutionContext = {
        waitUntil(promise: Promise<any>) {
          promise.catch((err) => console.error(`[${defaultProto.toUpperCase()} Background Task Error]:`, err));
        },
        passThroughOnException() {}
      } as any;

      const response = await worker.fetch(request, env, ctx);

      res.statusCode = response.status;
      if (req.httpVersion !== '2.0') {
        res.statusMessage = response.statusText;
      }

      // Extract all Set-Cookie headers properly without Node.js res.setHeader overwriting
      let rawCookies: string[] = typeof (response.headers as any).getSetCookie === 'function'
        ? (response.headers as any).getSetCookie()
        : [];

      if (rawCookies.length === 0 && response.headers.has('set-cookie')) {
        const singleCookie = response.headers.get('set-cookie');
        if (singleCookie) {
          rawCookies = [singleCookie];
        }
      }

      response.headers.forEach((val, key) => {
        const lowerKey = key.toLowerCase();
        if (lowerKey === 'set-cookie') {
          // Handled separately below to support multiple Set-Cookie headers
          return;
        }
        if (defaultProto === 'https' && lowerKey === 'alt-svc') {
          res.setHeader('Alt-Svc', `h3=":${port}"; ma=86400, h3-29=":${port}"; ma=86400`);
        } else {
          res.setHeader(key, val);
        }
      });

      if (rawCookies.length > 0) {
        // Over plain HTTP (non-TLS), browsers reject cookies marked with 'Secure' (RFC 6265bis).
        // Adapt outgoing cookies by stripping '; Secure' when accessed over plain http.
        const isPlainHttp = proto === 'http';
        const adaptedCookies = isPlainHttp
          ? rawCookies.map((c) => c.replace(/;\s*Secure\b/gi, ''))
          : rawCookies;
        res.setHeader('Set-Cookie', adaptedCookies);
      }

      if (defaultProto === 'https' && !res.hasHeader('Alt-Svc')) {
        res.setHeader('Alt-Svc', `h3=":${port}"; ma=86400, h3-29=":${port}"; ma=86400`);
      }

      if (response.body) {
        const reader = response.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
      }
      res.end();
    } catch (err: any) {
      console.error(`[${defaultProto.toUpperCase()} Server] Request processing failed:`, err);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Internal Server Error' }));
      }
    }
  };
}
