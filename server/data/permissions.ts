import type { SessionUser } from '../types.js';
import { ApiError } from '../util/errors.js';
import type { TableName } from './tables.js';

export type WriteOperation = 'create' | 'update' | 'delete';

const forbidden = () => new ApiError('FORBIDDEN', 'Nur für Admins');

/** Business tables are open to every logged-in user (company separation is a UI working context). */
export function assertCanRead(table: TableName, user: SessionUser): void {
  if (table === 'AiUsageLog' && !user.isAdmin) throw forbidden();
}

export function assertCanWrite(table: TableName, user: SessionUser, op: WriteOperation): void {
  if (user.isAdmin) return;
  if (table === 'Company' || table === 'User') throw forbidden();
  if (table === 'AiUsageLog' && op !== 'create') throw forbidden();
}
