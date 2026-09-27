import type { AppDeps } from '../deps.js';
import type { UserSecretInfo } from '../secrets/store.js';
import type { AirtableRecord, SessionUser } from '../types.js';
import { stripSecretFields } from './fields.js';
import type { StoredRecord } from './records.js';
import type { TableName } from './tables.js';

export interface PublicExtras {
  userSecrets?: Map<string, UserSecretInfo>;
  companiesWithMailchimp?: Set<string>;
}

export async function loadPublicExtras(deps: AppDeps, table: TableName, viewer: SessionUser): Promise<PublicExtras> {
  if (table === 'User' && viewer.isAdmin) return { userSecrets: await deps.secrets.allUserInfo() };
  if (table === 'Company') return { companiesWithMailchimp: await deps.secrets.companiesWithMailchimpKey() };
  return {};
}

/** The only way records leave the server: secrets removed, User restricted for non-admins, derived flags added. */
export function toPublicRecord(
  table: TableName,
  record: StoredRecord,
  viewer: SessionUser,
  extras: PublicExtras,
): AirtableRecord {
  let fields = stripSecretFields(record.fields);
  if (table === 'User') {
    if (!viewer.isAdmin) {
      fields = typeof fields.name === 'string' ? { name: fields.name } : {};
    } else {
      const info = extras.userSecrets?.get(record.id);
      fields = {
        ...fields,
        has_api_key: info?.hasApiKey ?? false,
        has_freshdesk_key: info?.hasFreshdeskKey ?? false,
        freshdesk_company_keys: info?.freshdeskCompanyKeys ?? [],
      };
    }
  }
  if (table === 'Company') {
    fields = { ...fields, has_mailchimp_key: extras.companiesWithMailchimp?.has(record.id) ?? false };
  }
  return { id: record.id, createdTime: record.createdTime, fields };
}
