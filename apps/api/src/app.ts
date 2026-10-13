import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { createChallengeFlagProvider } from './challenge-flags.js';
import { config } from './config.js';
import { registerSessionAuthentication, requireRole, requireUser } from './lib/authentication.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerBookingRoutes } from './routes/bookings.js';
import { registerCatalogRoutes } from './routes/catalog.js';
import type { RouteContext } from './routes/context.js';
import { registerPaymentRoutes } from './routes/payments.js';
import { registerProfileRoutes } from './routes/profile.js';
import { registerSupportRoutes } from './routes/support.js';
import { registerSystemRoutes } from './routes/system.js';

export type BuildOptions = {
  serveFrontend?: boolean;
  diagnosticsEnabled?: boolean;
};

/** Adds response headers that apply consistently to API and frontend traffic. */
function registerResponseHeaders(app: FastifyInstance, diagnosticsEnabled: boolean): void {
  app.addHook('onSend', async (request, reply, payload) => {
    reply.headers({
      'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
      'permissions-policy': 'camera=(), microphone=(), geolocation=()'
    });
    if (diagnosticsEnabled && request.authUser?.role === 'support') {
      reply.header('x-holbietrips-debug-desk', '/api/support/diagnostics');
    }
    return payload;
  });
}

/** Keeps transport-level failures consistent without leaking internal details. */
function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, _request, reply) => {
    app.log.error(error);
    const statusCode = Number((error as Error & { statusCode?: number }).statusCode);
    if (statusCode >= 400 && statusCode < 500) {
      return reply.code(statusCode).send({ error: 'Requête invalide' });
    }
    return reply.code(500).send({ error: 'Une erreur interne est survenue' });
  });
}

/** Serves the Vite production build and preserves JSON responses for unknown API routes. */
async function registerFrontend(app: FastifyInstance): Promise<void> {
  const webRoot = join(dirname(fileURLToPath(import.meta.url)), '../../web/dist');
  await app.register(fastifyStatic, { root: webRoot, wildcard: false });
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) {
      return reply.code(404).send({ error: 'Ressource introuvable' });
    }
    return reply.type('text/html').sendFile('index.html');
  });
}

/**
 * Composes the API from independent route modules. A pool can be injected so
 * tests exercise the same HTTP handlers without requiring PostgreSQL.
 */
export async function buildApp(
  pool = new Pool({ connectionString: config.databaseUrl }),
  options: BuildOptions = {}
) {
  const app = Fastify({ logger: true, bodyLimit: 256_000 });
  const diagnosticsEnabled = options.diagnosticsEnabled ?? config.supportDiagnosticsEnabled;
  const context: RouteContext = {
    pool,
    settings: config,
    flags: createChallengeFlagProvider(),
    requireUser,
    requireRole
  };

  app.decorate('db', pool);
  registerResponseHeaders(app, diagnosticsEnabled);
  registerSessionAuthentication(app, pool);

  registerSystemRoutes(app, context, diagnosticsEnabled);
  registerAuthRoutes(app, context);
  registerCatalogRoutes(app, context);
  registerProfileRoutes(app, context);
  registerBookingRoutes(app, context);
  registerPaymentRoutes(app, context);
  registerSupportRoutes(app, context);

  registerErrorHandler(app);
  if (options.serveFrontend !== false) await registerFrontend(app);

  app.addHook('onClose', async () => pool.end());
  return app;
}
