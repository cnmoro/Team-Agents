import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { config, paths } from './config.js';
import { HttpError } from './services/errors.js';
import { authRoutes } from './routes/auth.js';
import { userRoutes } from './routes/users.js';
import { conversationRoutes } from './routes/conversations.js';
import { messageRoutes } from './routes/messages.js';
import { fileRoutes } from './routes/files.js';
import { agentRoutes } from './routes/agents.js';
import { repositoryRoutes } from './routes/repositories.js';
import { systemRoutes } from './routes/system.js';

export async function buildApp(): Promise<FastifyInstance> {
  await mkdir(paths.uploads, { recursive: true });
  await mkdir(paths.sandboxes, { recursive: true });

  const app = Fastify({
    logger: config.isTest
      ? false
      : {
          level: process.env.LOG_LEVEL ?? 'info',
          transport: config.isProduction
            ? undefined
            : { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } },
        },
    // Uploads are streamed by @fastify/multipart, so this only caps JSON bodies.
    bodyLimit: 8 * 1024 * 1024,
    trustProxy: true,
  });

  await app.register(cors, {
    origin: config.webOrigins,
    credentials: true,
  });
  await app.register(cookie);
  await app.register(multipart, {
    limits: {
      fileSize: config.maxUploadBytes,
      files: 1,
      fields: 10,
    },
  });

  // A single error shape for the whole API keeps client handling simple.
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(422).send({
        error: 'validation_failed',
        message: error.issues[0]?.message ?? 'The request was not valid',
        details: error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }
    if (error instanceof HttpError) {
      return reply.code(error.statusCode).send({
        error: error.code,
        message: error.message,
        details: error.details,
      });
    }
    if ((error as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') {
      return reply.code(413).send({
        error: 'payload_too_large',
        message: `Files are limited to ${Math.floor(config.maxUploadBytes / (1024 * 1024))} MB`,
      });
    }
    request.log.error({ err: error }, 'unhandled request error');
    return reply.code(500).send({
      error: 'internal_error',
      message: 'Something went wrong handling that request',
    });
  });

  /**
   * Serve the built web app when it is present.
   *
   * In development Vite serves the app and proxies `/api` here, so this does
   * nothing. In a container there is one process and one origin, which also
   * means the session cookie is first-party without any extra configuration.
   */
  const hasWebDist = existsSync(path.join(config.webDist, 'index.html'));
  if (hasWebDist) {
    await app.register(fastifyStatic, { root: config.webDist, wildcard: false });
    app.log.info({ root: config.webDist }, 'serving built web app');
  }

  app.setNotFoundHandler((request, reply) => {
    // Anything under /api that got this far really is missing. Everything else
    // is a client-side route, so the SPA shell answers it and the router takes
    // over — otherwise a refresh on /settings would 404.
    const isApi = request.url.startsWith('/api') || request.url.startsWith('/socket.io');
    if (hasWebDist && !isApi && request.method === 'GET') {
      return reply.sendFile('index.html');
    }
    return reply
      .code(404)
      .send({ error: 'not_found', message: `No route for ${request.method} ${request.url}` });
  });

  await app.register(systemRoutes);
  await app.register(authRoutes);
  await app.register(userRoutes);
  await app.register(conversationRoutes);
  await app.register(messageRoutes);
  await app.register(fileRoutes);
  await app.register(agentRoutes);
  await app.register(repositoryRoutes);

  return app;
}
