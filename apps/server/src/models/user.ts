import mongoose, { Schema, type InferSchemaType, type HydratedDocument } from 'mongoose';
import type { UserPublic } from '@teamagents/shared';

const userSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    username: { type: String, required: true, unique: true, trim: true },
    firstName: { type: String, required: true, trim: true },
    lastName: { type: String, required: true, trim: true },
    passwordHash: { type: String, required: true },
    /** Lowercased `firstName lastName email username`, indexed for directory search. */
    searchKey: { type: String, required: true, index: true },
    avatarColor: { type: String, required: true },
  },
  { timestamps: true },
);

// Directory search matches a prefix on any token, so a plain index on the
// concatenated key plus a case-insensitive regex is enough at this scale.
userSchema.index({ searchKey: 1, _id: 1 });

export type UserDoc = HydratedDocument<InferSchemaType<typeof userSchema>>;

export const UserModel = mongoose.model('User', userSchema);

/** Builds the value stored in `searchKey`. */
export function buildSearchKey(u: {
  firstName: string;
  lastName: string;
  email: string;
  username: string;
}): string {
  return `${u.firstName} ${u.lastName} ${u.email} ${u.username}`.toLowerCase();
}

const AVATAR_COLORS = [
  '#E0616B', '#E08A3C', '#D9A404', '#68A63C', '#2FA37C',
  '#3492C4', '#5B6EE0', '#8B5CD6', '#C2549E', '#7A6A5F',
];

/** Deterministic colour so a user looks the same everywhere without storing an image. */
export function pickAvatarColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length]!;
}

export function toUserPublic(doc: UserDoc): UserPublic {
  return {
    id: String(doc._id),
    email: doc.email,
    username: doc.username,
    firstName: doc.firstName,
    lastName: doc.lastName,
    displayName: `${doc.firstName} ${doc.lastName}`.trim(),
    avatarColor: doc.avatarColor,
    createdAt: (doc as unknown as { createdAt: Date }).createdAt.toISOString(),
  };
}
