import type { FastifyInstance } from 'fastify';
import { AgentSessionModel } from '../models/agentSession.js';
import { CredentialModel } from '../models/credential.js';
import { RepositoryModel } from '../models/repository.js';
import { requireAuth } from '../services/auth.js';
import { HttpError, badRequest, conflict, notFound } from '../services/errors.js';
import { encryptJson } from '../services/secretBox.js';
import { serializeCredential, serializeRepository } from '../services/serialize.js';
import { detectProtocol } from '../agents/gitProvisioner.js';
import { createCredentialSchema, createRepositorySchema } from './schemas.js';

/**
 * Git credentials and repositories.
 *
 * Credentials follow the Jenkins model: the secret goes in once, is encrypted
 * at rest, and is thereafter referenced only by name. No endpoint ever returns
 * the secret material.
 */
export async function repositoryRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.get('/api/credentials', async () => {
    const docs = await CredentialModel.find().sort({ name: 1 });
    return { items: docs.map(serializeCredential), nextCursor: null, hasMore: false };
  });

  app.post('/api/credentials', async (request, reply) => {
    const input = createCredentialSchema.parse(request.body);
    const existing = await CredentialModel.findOne({ name: input.name.trim() });
    if (existing) throw conflict('A credential with that name already exists');

    const secret =
      input.type === 'https_token'
        ? encryptJson({ token: input.token })
        : encryptJson({ privateKey: input.privateKey, passphrase: input.passphrase ?? undefined });

    const doc = await CredentialModel.create({
      name: input.name.trim(),
      type: input.type,
      username: input.type === 'https_token' ? (input.username?.trim() || 'git') : null,
      secret,
      createdBy: request.currentUser._id,
    });
    return reply.code(201).send(serializeCredential(doc));
  });

  app.delete('/api/credentials/:id', async (request) => {
    const { id } = request.params as { id: string };
    const inUse = await RepositoryModel.countDocuments({ credentialId: id });
    if (inUse > 0) {
      throw badRequest(`This credential is bound to ${inUse} repositor${inUse === 1 ? 'y' : 'ies'}`);
    }
    const deleted = await CredentialModel.findByIdAndDelete(id);
    if (!deleted) throw notFound('Credential not found');
    return { ok: true };
  });

  app.get('/api/repositories', async () => {
    const docs = await RepositoryModel.find().sort({ name: 1 });
    const credentials = await CredentialModel.find({
      _id: { $in: docs.map((d) => d.credentialId).filter(Boolean) },
    });
    const nameById = new Map(credentials.map((c) => [String(c._id), c.name]));
    return {
      items: docs.map((doc) =>
        serializeRepository(doc, doc.credentialId ? (nameById.get(String(doc.credentialId)) ?? null) : null),
      ),
      nextCursor: null,
      hasMore: false,
    };
  });

  app.post('/api/repositories', async (request, reply) => {
    const input = createRepositorySchema.parse(request.body);
    const existing = await RepositoryModel.findOne({ name: input.name.trim() });
    if (existing) throw conflict('A repository with that name already exists');

    if (input.credentialId) {
      const credential = await CredentialModel.findById(input.credentialId);
      if (!credential) throw badRequest('The selected credential does not exist');
      const protocol = detectProtocol(input.url);
      // A token cannot authenticate an SSH remote and a key cannot authenticate
      // an HTTPS one; catching it here beats a confusing clone failure later.
      if (protocol === 'ssh' && credential.type !== 'ssh_key') {
        throw badRequest('SSH remotes need an SSH key credential');
      }
      if (protocol === 'https' && credential.type !== 'https_token') {
        throw badRequest('HTTPS remotes need an access token credential');
      }
    }

    const doc = await RepositoryModel.create({
      name: input.name.trim(),
      url: input.url.trim(),
      protocol: detectProtocol(input.url),
      credentialId: input.credentialId ?? null,
      defaultBranch: input.defaultBranch?.trim() || null,
      createdBy: request.currentUser._id,
    });
    return reply.code(201).send(serializeRepository(doc));
  });

  /**
   * Deleting a repository that an open agent session still references is
   * refused by default, but `?force=1` overrides it. Sessions keep their own
   * copy of the name, URL, and sandbox path, so the running agent is unaffected
   * — it simply cannot be re-cloned from this entry afterwards. Without the
   * override a user could be stuck: the session holds the repository, and the
   * error alone does not say which session to close.
   */
  app.delete('/api/repositories/:id', async (request) => {
    const { id } = request.params as { id: string };
    const { force } = request.query as { force?: string };

    if (force !== '1' && force !== 'true') {
      const blocking = await AgentSessionModel.find({
        'repositories.repositoryId': id,
        status: { $ne: 'closed' },
      }).select('title');

      if (blocking.length > 0) {
        throw new HttpError(
          409,
          'repository_in_use',
          `Still used by ${blocking.length} open agent session${blocking.length === 1 ? '' : 's'}: ` +
            `${blocking.map((session) => `"${session.title}"`).join(', ')}. ` +
            'Close them from the Agents tab, or delete anyway.',
          { sessions: blocking.map((session) => ({ id: String(session._id), title: session.title })) },
        );
      }
    }

    const deleted = await RepositoryModel.findByIdAndDelete(id);
    if (!deleted) throw notFound('Repository not found');
    return { ok: true };
  });
}
