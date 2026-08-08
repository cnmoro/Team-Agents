import mongoose, { Schema, type InferSchemaType, type HydratedDocument } from 'mongoose';

const repositorySchema = new Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
    url: { type: String, required: true, trim: true },
    protocol: { type: String, enum: ['https', 'ssh'], required: true },
    credentialId: { type: Schema.Types.ObjectId, ref: 'Credential', default: null },
    defaultBranch: { type: String, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);

export type RepositoryDoc = HydratedDocument<InferSchemaType<typeof repositorySchema>>;

export const RepositoryModel = mongoose.model('Repository', repositorySchema);
