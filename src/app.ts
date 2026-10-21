import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { corsOrigins } from './config/env.js';
import { errorHandler, notFound } from './middleware/error-handler.js';
import { adminRouter } from './routes/admin.js';
import { meRouter } from './routes/me.js';
import { publicRouter } from './routes/public.js';
import { redirectRouter } from './routes/redirect.js';
import { webhooksRouter } from './routes/webhooks.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1); // behind Render's proxy: real client IPs for rate limiting
  app.disable('x-powered-by');
  app.use(helmet());
  // Browsers: only the dashboard (and the app's web preview) may call the API. The native app
  // isn't a browser, so CORS doesn't apply to it.
  app.use(cors({ origin: corsOrigins, maxAge: 600 }));
  app.use(
    express.json({
      limit: '200kb',
      // Keep the exact bytes: webhook signatures are computed over the raw body.
      verify: (req, _res, buf) => {
        (req as express.Request).rawBody = buf;
      },
    }),
  );

  app.use(redirectRouter);
  app.use('/api/v1', publicRouter);
  app.use('/api/v1/me', meRouter);
  app.use('/api/v1/admin', adminRouter);
  app.use('/api/v1/webhooks', webhooksRouter);
  app.get('/', (_req, res) => res.json({ name: 'Core Asana Partners API', docs: 'See README.md', health: '/api/v1/health' }));

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
