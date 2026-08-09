import { z } from 'zod';
import { CODE_LANGUAGES, HARNESSES } from '@teamagents/shared';

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id');

export const registerSchema = z.object({
  email: z.string().email().max(200),
  username: z
    .string()
    .min(2)
    .max(40)
    .regex(/^[a-zA-Z0-9._-]+$/, 'Use letters, numbers, dots, dashes or underscores'),
  firstName: z.string().min(1).max(60),
  lastName: z.string().min(1).max(60),
  password: z.string().min(8).max(200),
});

export const loginSchema = z.object({
  identifier: z.string().min(1).max(200),
  password: z.string().min(1).max(200),
});

// Blocks referencing an uploaded file carry the metadata the client already has,
// but the server re-reads the File document before persisting, so these fields
// are advisory only and cannot be used to fake a size or filename.
const textBlockSchema = z.object({ type: z.literal('text'), text: z.string().max(50_000) });
const codeBlockSchema = z.object({
  type: z.literal('code'),
  language: z.enum(CODE_LANGUAGES as unknown as [string, ...string[]]).or(z.string().max(30)),
  code: z.string().max(200_000),
  filename: z.string().max(200).optional(),
});
const fileBlockSchema = z.object({
  type: z.literal('file'),
  fileId: objectId,
  filename: z.string().max(300),
  mimeType: z.string().max(200),
  size: z.number().int().nonnegative(),
});
const imageBlockSchema = z.object({
  type: z.literal('image'),
  fileId: objectId,
  filename: z.string().max(300),
  mimeType: z.string().max(200),
  size: z.number().int().nonnegative(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
});

export const messageBlockSchema = z.discriminatedUnion('type', [
  textBlockSchema,
  codeBlockSchema,
  fileBlockSchema,
  imageBlockSchema,
]);

export const sendMessageSchema = z.object({
  blocks: z.array(messageBlockSchema).min(1).max(30),
  mentions: z.array(objectId).max(100).optional(),
  agentSessionId: objectId.nullable().optional(),
  contextMessageIds: z.array(objectId).max(500).optional(),
});

export const createConversationSchema = z
  .object({
    type: z.enum(['dm', 'group']),
    memberIds: z.array(objectId).min(1).max(200),
    name: z.string().min(1).max(120).optional(),
  })
  .refine((v) => v.type !== 'dm' || v.memberIds.length === 1, {
    message: 'A direct message takes exactly one other member',
    path: ['memberIds'],
  })
  .refine((v) => v.type !== 'group' || Boolean(v.name?.trim()), {
    message: 'Group chats need a name',
    path: ['name'],
  });

export const updateConversationSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  addMemberIds: z.array(objectId).max(100).optional(),
  removeMemberIds: z.array(objectId).max(100).optional(),
});

export const paginationSchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const directorySchema = paginationSchema.extend({
  query: z.string().max(120).optional(),
  /** Restricts results to members of a conversation (for the @mention menu). */
  conversationId: objectId.optional(),
});

export const createCredentialSchema = z
  .object({
    name: z.string().min(1).max(80),
    type: z.enum(['https_token', 'ssh_key']),
    username: z.string().max(120).optional(),
    token: z.string().max(4000).optional(),
    privateKey: z.string().max(20_000).optional(),
    passphrase: z.string().max(400).optional(),
  })
  .refine((v) => v.type !== 'https_token' || Boolean(v.token), {
    message: 'An access token is required',
    path: ['token'],
  })
  .refine((v) => v.type !== 'ssh_key' || Boolean(v.privateKey), {
    message: 'A private key is required',
    path: ['privateKey'],
  });

export const createRepositorySchema = z.object({
  name: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-zA-Z0-9._-]+$/, 'Use letters, numbers, dots, dashes or underscores'),
  url: z.string().min(4).max(500),
  credentialId: objectId.nullable().optional(),
  defaultBranch: z.string().max(200).nullable().optional(),
});

export const startAgentSchema = z.object({
  conversationId: objectId,
  harness: z.enum(HARNESSES as unknown as [string, ...string[]]),
  repositoryIds: z.array(objectId).max(20),
  prompt: z.string().min(1).max(100_000),
  contextMessageIds: z.array(objectId).max(500).optional(),
  title: z.string().max(120).optional(),
});

export const promptAgentSchema = z.object({
  prompt: z.string().min(1).max(100_000),
  contextMessageIds: z.array(objectId).max(500).optional(),
});

export const answerQuestionSchema = z.object({
  questionId: z.string().min(1).max(200),
  optionId: z.string().max(200).nullable().optional(),
  text: z.string().max(10_000).nullable().optional(),
});

export const objectIdSchema = objectId;
