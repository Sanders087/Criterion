import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
export const documents = sqliteTable('documents', {
  id: text('id').primaryKey(), owner: text('owner').notNull(), title: text('title').notNull(), kind: text('kind').notNull(), stage: text('stage').notNull(), body: text('body').notNull(), revision: integer('revision').notNull().default(0), lockToken: text('lock_token'), lockUntil: integer('lock_until'), createdAt: text('created_at').notNull(), updatedAt: text('updated_at').notNull(),
  billingState: text('billing_state').notNull().default('legacy'), aiOperationsUsed: integer('ai_operations_used').notNull().default(0),
}, t => [index('documents_owner_updated').on(t.owner,t.updatedAt)]);
export const materials = sqliteTable('materials', {owner: text('owner').primaryKey(), body: text('body').notNull(), updatedAt: text('updated_at').notNull()});
export const accounts = sqliteTable('accounts', {id:text('id').primaryKey(), email:text('email').notNull().unique(), passwordHash:text('password_hash').notNull(), salt:text('salt').notNull(), recoveryHash:text('recovery_hash').notNull(), emailVerifiedAt:integer('email_verified_at'), createdAt:integer('created_at').notNull()});
export const sessions = sqliteTable('sessions', {tokenHash:text('token_hash').primaryKey(), accountId:text('account_id').notNull(), expiresAt:integer('expires_at').notNull()}, t=>[index('sessions_account').on(t.accountId)]);
export const authLimits = sqliteTable('auth_limits', {key:text('key').primaryKey(), count:integer('count').notNull(), expiresAt:integer('expires_at').notNull()});

export const emailTokens = sqliteTable('email_tokens', {tokenHash:text('token_hash').primaryKey(), accountId:text('account_id').notNull(), email:text('email').notNull(), purpose:text('purpose').notNull(), credentialHash:text('credential_hash').notNull(), expiresAt:integer('expires_at').notNull(), claim:text('claim')},t=>[index('email_tokens_account').on(t.accountId)]);

export const paymentOrders = sqliteTable('payment_orders', {
  id: text('id').primaryKey(), documentId: text('document_id').notNull(), owner: text('owner').notNull(),
  activeDocument: text('active_document'), amount: integer('amount').notNull(), terminalKey: text('terminal_key').notNull(),
  paymentId: text('payment_id'), paymentUrl: text('payment_url'), status: text('status').notNull(),
  statusRank: integer('status_rank').notNull().default(0), createdAt: integer('created_at').notNull(), updatedAt: integer('updated_at').notNull(),
  checkedAt: integer('checked_at').notNull().default(0),
}, t => [uniqueIndex('payment_orders_active_document').on(t.activeDocument), uniqueIndex('payment_orders_payment_id').on(t.paymentId), index('payment_orders_document').on(t.documentId)]);
export const paymentEvents = sqliteTable('payment_events', {
  id: text('id').primaryKey(), orderId: text('order_id').notNull(), status: text('status').notNull(), amount: integer('amount').notNull(), createdAt: integer('created_at').notNull(),
}, t => [uniqueIndex('payment_events_once').on(t.orderId,t.status,t.amount)]);
