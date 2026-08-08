import mongoose, { Schema, type InferSchemaType, type HydratedDocument } from 'mongoose';

const repoRefSchema = new Schema(
  {
    repositoryId: { type: Schema.Types.ObjectId, ref: 'Repository', required: true },
    name: { type: String, required: true },
    url: { type: String, required: true },
    /** Path inside the sandbox, e.g. `/work/my-repo`. */
    sandboxPath: { type: String, required: true },
    cloned: { type: Boolean, default: false },
    cloneError: { type: String, default: null },
  },
  { _id: false },
);

const agentSessionSchema = new Schema(
  {
    conversationId: { type: Schema.Types.ObjectId, ref: 'Conversation', required: true, index: true },
    harness: { type: String, enum: ['claude-code', 'codex', 'opencode'], required: true },
    title: { type: String, required: true },
    status: {
      type: String,
      enum: ['provisioning', 'running', 'waiting_input', 'idle', 'error', 'closed'],
      required: true,
      default: 'provisioning',
    },
    repositories: { type: [repoRefSchema], default: [] },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    /**
     * Session identifier minted by the harness itself. Persisted so a follow-up
     * prompt resumes the agent's own conversation rather than starting over,
     * and so continuity survives a server restart.
     */
    harnessSessionId: { type: String, default: null },
    /** Absolute host path of the persistent sandbox. Null once closed. */
    sandboxPath: { type: String, default: null },
    lastError: { type: String, default: null },
    turnCount: { type: Number, default: 0 },
    /** Monotonic counter backing `AgentEvent.seq`. */
    eventSeq: { type: Number, default: 0 },
    closedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

export type AgentSessionDoc = HydratedDocument<InferSchemaType<typeof agentSessionSchema>>;

export const AgentSessionModel = mongoose.model('AgentSession', agentSessionSchema);
