import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
export const workspaceState = sqliteTable("workspace_state", {
  ownerId: text("owner_id").primaryKey(),
  data: text("data").notNull(),
  version: integer("version").notNull().default(0),
  updatedAt: text("updated_at").notNull(),
});
export const modelConfig = sqliteTable("model_config", {
  ownerId: text("owner_id").primaryKey(),
  ciphertext: text("ciphertext").notNull(),
  iv: text("iv").notNull(),
  updatedAt: text("updated_at").notNull(),
});
export const searchConfig = sqliteTable("search_config", {
  ownerId: text("owner_id").primaryKey(),
  ciphertext: text("ciphertext").notNull(),
  iv: text("iv").notNull(),
  updatedAt: text("updated_at").notNull(),
  lastVerification: text("last_verification"),
  verificationId: text("verification_id"),
  verificationStartedAt: text("verification_started_at"),
});
