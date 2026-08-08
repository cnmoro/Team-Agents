import mongoose, { Schema, type InferSchemaType, type HydratedDocument } from 'mongoose';

/**
 * Blocks are stored loosely (`Schema.Types.Mixed`) because their shape varies by
 * type; they are validated with zod at the API boundary before they ever reach
 * the database, so the schema only needs to preserve them faithfully.
 */
const messageSchema = new Schema(
  {
    conversationId: { type: Schema.Types.ObjectId, ref: 'Conversation', required: true },
    kind: {
      type: String,
      enum: ['user', 'agent_session', 'agent_output', 'agent_question', 'system'],
      required: true,
      default: 'user',
    },
    authorKind: { type: String, enum: ['user', 'agent', 'system'], required: true },
    authorUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    blocks: { type: [Schema.Types.Mixed], required: true },
    mentions: { type: [Schema.Types.ObjectId], ref: 'User', default: [] },
    agentSessionId: { type: Schema.Types.ObjectId, ref: 'AgentSession', default: null },
    /** Populated only for `agent_question` messages. */
    question: { type: Schema.Types.Mixed, default: null },
    editedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// The message list pages backwards through history; this index serves both the
// initial "last 20" query and every scroll-up page.
messageSchema.index({ conversationId: 1, _id: -1 });
messageSchema.index({ agentSessionId: 1, _id: 1 });
// Drives the unread count: messages in a conversation newer than lastReadAt.
messageSchema.index({ conversationId: 1, createdAt: -1 });

export type MessageDoc = HydratedDocument<InferSchemaType<typeof messageSchema>>;

export const MessageModel = mongoose.model('Message', messageSchema);
