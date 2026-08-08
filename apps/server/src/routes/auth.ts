import type { FastifyInstance } from 'fastify';
import {
  UserModel,
  buildSearchKey,
  pickAvatarColor,
  toUserPublic,
} from '../models/user.js';
import {
  clearAuthCookie,
  hashPassword,
  requireAuth,
  setAuthCookie,
  signToken,
  verifyPassword,
} from '../services/auth.js';
import { conflict, unauthorized } from '../services/errors.js';
import { loginSchema, registerSchema } from './schemas.js';

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/auth/register', async (request, reply) => {
    const input = registerSchema.parse(request.body);
    const email = input.email.toLowerCase().trim();
    const username = input.username.trim();

    const existing = await UserModel.findOne({ $or: [{ email }, { username }] });
    if (existing) {
      throw conflict(
        existing.email === email
          ? 'An account with that email already exists'
          : 'That username is taken',
      );
    }

    const user = await UserModel.create({
      email,
      username,
      firstName: input.firstName.trim(),
      lastName: input.lastName.trim(),
      passwordHash: await hashPassword(input.password),
      searchKey: buildSearchKey({ ...input, email, username }),
      avatarColor: pickAvatarColor(username),
    });

    const token = signToken(user);
    setAuthCookie(reply, token);
    return reply.code(201).send({ user: toUserPublic(user), token });
  });

  app.post('/api/auth/login', async (request, reply) => {
    const input = loginSchema.parse(request.body);
    const identifier = input.identifier.toLowerCase().trim();
    const user = await UserModel.findOne({
      $or: [{ email: identifier }, { username: input.identifier.trim() }],
    });
    // Same message either way so the endpoint does not reveal which accounts exist.
    if (!user || !(await verifyPassword(input.password, user.passwordHash))) {
      throw unauthorized('Incorrect credentials');
    }
    const token = signToken(user);
    setAuthCookie(reply, token);
    return { user: toUserPublic(user), token };
  });

  app.post('/api/auth/logout', async (_request, reply) => {
    clearAuthCookie(reply);
    return { ok: true };
  });

  app.get('/api/auth/me', { preHandler: requireAuth }, async (request) => ({
    user: toUserPublic(request.currentUser),
  }));
}
