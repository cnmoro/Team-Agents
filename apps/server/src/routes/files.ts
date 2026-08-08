import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, open, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance } from 'fastify';
import { config, paths } from '../config.js';
import { FileModel } from '../models/file.js';
import { requireAuth } from '../services/auth.js';
import { getConversationForMember } from '../services/conversationService.js';
import { badRequest, notFound, payloadTooLarge } from '../services/errors.js';
import { readImageDimensions } from '../services/imageDimensions.js';
import { serializeFile } from '../services/serialize.js';
import { objectIdSchema } from './schemas.js';

const IMAGE_MIME = /^image\/(png|jpe?g|gif|webp|avif|bmp|svg\+xml)$/i;

/** Strips directory components and control characters from an upload's name. */
function sanitizeFilename(name: string): string {
  const base = path.basename(name).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return base.slice(0, 240) || 'file';
}

export async function fileRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  /**
   * Uploads one attachment, scoped to a conversation so download authorization
   * can be checked against membership later.
   */
  app.post('/api/files', async (request, reply) => {
    const uploaded = await request.file();
    if (!uploaded) throw badRequest('No file was provided');

    const conversationId = (uploaded.fields?.conversationId as { value?: string } | undefined)?.value;
    if (!conversationId) throw badRequest('conversationId is required');
    objectIdSchema.parse(conversationId);
    await getConversationForMember(conversationId, String(request.currentUser._id));

    const filename = sanitizeFilename(uploaded.filename ?? 'file');
    // Shard by date so a single directory never accumulates unbounded entries.
    const today = new Date().toISOString().slice(0, 10);
    const relativeDir = path.join(today);
    const storageName = `${randomUUID()}${path.extname(filename).slice(0, 12)}`;
    const relativePath = path.join(relativeDir, storageName);
    const absolutePath = path.join(paths.uploads, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });

    const hash = createHash('sha256');
    uploaded.file.on('data', (chunk: Buffer) => hash.update(chunk));

    try {
      await pipeline(uploaded.file, createWriteStream(absolutePath));
    } catch (error) {
      await unlink(absolutePath).catch(() => {});
      throw error;
    }

    // @fastify/multipart flags truncation rather than throwing, so the size cap
    // is enforced here after the stream drains.
    if (uploaded.file.truncated) {
      await unlink(absolutePath).catch(() => {});
      throw payloadTooLarge(
        `Files are limited to ${Math.floor(config.maxUploadBytes / (1024 * 1024))} MB`,
      );
    }

    const stats = await stat(absolutePath);
    const mimeType = uploaded.mimetype || 'application/octet-stream';
    const isImage = IMAGE_MIME.test(mimeType);

    let width: number | null = null;
    let height: number | null = null;
    if (isImage && !/svg/i.test(mimeType)) {
      try {
        // Only the leading bytes are needed, so a huge upload is never
        // buffered in memory just to learn its size.
        const handle = await open(absolutePath, 'r');
        try {
          const head = Buffer.alloc(Math.min(65_536, stats.size));
          await handle.read(head, 0, head.length, 0);
          const dimensions = readImageDimensions(head);
          width = dimensions?.width ?? null;
          height = dimensions?.height ?? null;
        } finally {
          await handle.close();
        }
      } catch {
        // Unreadable dimensions are not fatal; the image still renders.
      }
    }

    const doc = await FileModel.create({
      filename,
      mimeType,
      size: stats.size,
      sha256: hash.digest('hex'),
      storagePath: relativePath,
      uploadedBy: request.currentUser._id,
      conversationId,
      isImage,
      width,
      height,
    });

    return reply.code(201).send(serializeFile(doc));
  });

  /** Streams an attachment back, but only to members of its conversation. */
  app.get('/api/files/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { download } = request.query as { download?: string };
    const doc = await FileModel.findById(id);
    if (!doc) throw notFound('File not found');
    await getConversationForMember(String(doc.conversationId), String(request.currentUser._id));

    const absolutePath = path.join(paths.uploads, doc.storagePath);
    const disposition = download === '1' ? 'attachment' : 'inline';
    // SVGs can carry script; forcing a download avoids executing them on our origin.
    const safeInline = doc.isImage && !/svg/i.test(doc.mimeType);
    const finalDisposition = safeInline ? disposition : 'attachment';

    reply
      .header('Content-Type', doc.mimeType)
      .header('Content-Length', String(doc.size))
      .header(
        'Content-Disposition',
        `${finalDisposition}; filename*=UTF-8''${encodeURIComponent(doc.filename)}`,
      )
      .header('Cache-Control', 'private, max-age=31536000, immutable')
      .header('X-Content-Type-Options', 'nosniff');

    const { createReadStream } = await import('node:fs');
    return reply.send(createReadStream(absolutePath));
  });
}
