import express from 'express';
import path from 'node:path';
import routes from './routes.js';
import { config } from './config.js';
import {
  refuseCrossSiteWrites,
  createSecurityHeaders,
  createRequestLogger,
  apiNotFound,
  createErrorHandler,
} from './middleware.js';

// Kept apart from the process lifecycle in index.js so the whole stack can be
// exercised end to end without a listening socket or a real Plaid account.
function createApp() {
  const app = express();
  app.disable('x-powered-by');

  app.use(createSecurityHeaders(config.plaid.environment));
  app.use(express.static(path.join(import.meta.dirname, '../public')));

  // The CSRF check runs before the body is parsed; JSON parsing is scoped to
  // the API, since the static files above never carry a body.
  const apiMiddleware = [refuseCrossSiteWrites, express.json()];
  if (config.debug) apiMiddleware.push(createRequestLogger());
  app.use('/api', ...apiMiddleware, routes);

  app.use('/api', apiNotFound);
  app.use(createErrorHandler());

  return app;
}

export { createApp };
