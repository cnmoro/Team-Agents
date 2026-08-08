import mongoose, { Schema, type InferSchemaType, type HydratedDocument } from 'mongoose';

/**
 * Git credentials, Jenkins-style: created once, referenced by name thereafter,
 * and never readable through the API again. `secret` holds an AES-256-GCM
 * envelope produced by `services/secretBox.ts`.
 */
const credentialSchema = new Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
    type: { type: String, enum: ['https_token', 'ssh_key'], required: true },
    /** For https_token: the git username the token authenticates as. */
    username: { type: String, default: null },
    /** Encrypted JSON: `{ token }` or `{ privateKey, passphrase }`. */
    secret: { type: String, required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);

export type CredentialDoc = HydratedDocument<InferSchemaType<typeof credentialSchema>>;

export const CredentialModel = mongoose.model('Credential', credentialSchema);
