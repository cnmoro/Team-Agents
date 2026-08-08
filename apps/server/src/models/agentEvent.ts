import mongoose, { Schema, type InferSchemaType, type HydratedDocument } from 'mongoose';

/**
 * The complete, append-only trace of an agent session. Every harness event is
 * recorded — including ones we do not recognize, as `raw` — so the trace view
 * shows the truth rather than a lossy summary.
 */
const agentEventSchema = new Schema(
  {
    agentSessionId: { type: Schema.Types.ObjectId, ref: 'AgentSession', required: true },
    seq: { type: Number, required: true },
    type: {
      type: String,
      enum: [
        'status',
        'assistant_text',
        'reasoning',
        'tool_use',
        'tool_result',
        'question',
        'question_answered',
        'warning',
        'error',
        'turn_complete',
        'raw',
      ],
      required: true,
    },
    summary: { type: String, required: true },
    detail: { type: String, default: null },
    data: { type: Schema.Types.Mixed, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

agentEventSchema.index({ agentSessionId: 1, seq: 1 }, { unique: true });

export type AgentEventDoc = HydratedDocument<InferSchemaType<typeof agentEventSchema>>;

export const AgentEventModel = mongoose.model('AgentEvent', agentEventSchema);
