import type { StoredRecord } from '../data/records.js';
import type { UserSecretInfo } from '../secrets/store.js';
import type { SessionUser } from '../types.js';

export const isActiveUser = (record: StoredRecord): boolean => record.fields.status === 'aktiv';

export function toSessionUser(record: StoredRecord): SessionUser {
  const f = record.fields;
  const companies = Array.isArray(f.allowed_companies) ? f.allowed_companies.filter((c) => typeof c === 'string') : [];
  return {
    id: record.id,
    name: typeof f.name === 'string' ? f.name : '',
    role: typeof f.role === 'string' ? f.role : '',
    isAdmin: f.is_admin === true,
    allowedCompanies: companies,
  };
}

/** Same shape as the old Val.town proxy's /auth and /me "user" object (minus the token). */
export function userPayload(user: SessionUser, info: UserSecretInfo) {
  return {
    id: user.id,
    name: user.name,
    role: user.role,
    is_admin: user.isAdmin,
    allowed_companies: user.allowedCompanies,
    has_freshdesk_key: info.hasFreshdeskKey,
    freshdesk_company_keys: info.freshdeskCompanyKeys,
  };
}
