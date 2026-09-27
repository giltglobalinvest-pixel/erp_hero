/** A record in Airtable's API shape. */
export interface AirtableRecord {
  id: string;
  createdTime: string;
  fields: Record<string, unknown>;
}

/** The logged-in user as seen by request handlers (read fresh on every request). */
export interface SessionUser {
  id: string;
  name: string;
  role: string;
  isAdmin: boolean;
  allowedCompanies: string[];
}

export type AppEnv = {
  Variables: {
    requestId: string;
    user: SessionUser;
    sessionTokenHash: string;
  };
};
