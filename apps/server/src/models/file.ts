import mongoose, { Schema, type InferSchemaType, type HydratedDocument } from 'mongoose';

const fileSchema = new Schema(
  {
    filename: { type: String, required: true },
    mimeType: { type: String, required: true },
    size: { type: Number, required: true },
    sha256: { type: String, required: true, index: true },
    /** Path on disk, relative to the uploads directory. */
    storagePath: { type: String, required: true },
    uploadedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    /**
     * Scopes access: only members of this conversation may download the file.
     * Set at upload time from the conversation the composer is attached to.
     */
    conversationId: { type: Schema.Types.ObjectId, ref: 'Conversation', required: true, index: true },
    isImage: { type: Boolean, default: false },
    width: { type: Number, default: null },
    height: { type: Number, default: null },
  },
  { timestamps: true },
);

export type FileDoc = HydratedDocument<InferSchemaType<typeof fileSchema>>;

export const FileModel = mongoose.model('File', fileSchema);
