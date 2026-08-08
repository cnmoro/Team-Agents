import mongoose, { Schema, type InferSchemaType, type HydratedDocument } from 'mongoose';

const conversationSchema = new Schema(
  {
    type: { type: String, enum: ['dm', 'group'], required: true },
    name: { type: String, default: null },
    memberIds: { type: [Schema.Types.ObjectId], ref: 'User', required: true, index: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    lastMessageAt: { type: Date, default: null },
    /** Short text preview of the latest message, kept for the sidebar. */
    lastMessagePreview: { type: String, default: null },
    /**
     * userId -> timestamp of the last message that user has seen. Unread state
     * is derived by counting messages newer than this, which keeps read state
     * correct even if a client misses socket events.
     */
    lastReadAt: { type: Map, of: Date, default: () => new Map<string, Date>() },
    /**
     * For DMs: a sorted, joined pair of member ids. Uniquely indexed so two
     * people can never end up with duplicate 1:1 conversations.
     */
    dmKey: { type: String, default: null },
  },
  { timestamps: true },
);

conversationSchema.index({ memberIds: 1, lastMessageAt: -1 });
conversationSchema.index(
  { dmKey: 1 },
  { unique: true, partialFilterExpression: { dmKey: { $type: 'string' } } },
);

export type ConversationDoc = HydratedDocument<InferSchemaType<typeof conversationSchema>>;

export const ConversationModel = mongoose.model('Conversation', conversationSchema);

/** Stable key for a 1:1 conversation, independent of who started it. */
export function makeDmKey(a: string, b: string): string {
  return [a, b].sort().join(':');
}
