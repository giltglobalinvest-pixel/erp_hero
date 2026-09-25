export interface FailedAttachment {
  table: string;
  recordId: string;
  field: string;
  filename: string;
}

export interface DuplicateNumber {
  type: string;
  companyId: string;
  number: string;
  recordIds: string[];
}

export interface ImportReport {
  startedAt: string;
  finishedAt: string;
  ok: boolean;
  tables: Record<string, { airtable: number; imported: number }>;
  countMismatches: string[];
  missingTables: string[];
  unknownTables: string[];
  computedFields: Record<string, string[]>;
  unregisteredAttachmentFields: string[];
  attachments: { downloaded: number; bytes: number; failed: FailedAttachment[] };
  danglingLinks: Record<string, { count: number; sample: string[] }>;
  duplicateNumbers: DuplicateNumber[];
  usersWithoutKey: string[];
  strippedSecretFields: string[];
  importedSettings: string[];
  skippedSettingKeys: string[];
  warnings: string[];
}

export function emptyReport(startedAt: string): ImportReport {
  return {
    startedAt,
    finishedAt: startedAt,
    ok: false,
    tables: {},
    countMismatches: [],
    missingTables: [],
    unknownTables: [],
    computedFields: {},
    unregisteredAttachmentFields: [],
    attachments: { downloaded: 0, bytes: 0, failed: [] },
    danglingLinks: {},
    duplicateNumbers: [],
    usersWithoutKey: [],
    strippedSecretFields: [],
    importedSettings: [],
    skippedSettingKeys: [],
    warnings: [],
  };
}

/** Short human-readable summary for the terminal; the full report is saved as JSON. */
export function formatReport(r: ImportReport): string {
  const lines = [`Import ${r.ok ? 'OK' : 'MIT PROBLEMEN'} (${r.startedAt} → ${r.finishedAt})`, '', 'Tabellen (Airtable → SQLite):'];
  for (const [table, c] of Object.entries(r.tables)) {
    lines.push(`  ${table.padEnd(20)} ${String(c.airtable).padStart(6)} → ${String(c.imported).padStart(6)}${c.airtable === c.imported ? '' : '  ✗'}`);
  }
  const section = (title: string, items: string[]) => {
    if (items.length > 0) lines.push('', `${title}:`, ...items.map((i) => `  - ${i}`));
  };
  section('Tabellen fehlen in Airtable', r.missingTables);
  section('Unbekannte Airtable-Tabellen (nicht importiert)', r.unknownTables);
  section(
    'Berechnete Felder (als feste Werte übernommen)',
    Object.entries(r.computedFields).map(([t, f]) => `${t}: ${f.join(', ')}`),
  );
  section('Anhangsfelder ohne Upload-Freigabe', r.unregisteredAttachmentFields);
  lines.push('', `Anhänge: ${r.attachments.downloaded} Dateien, ${(r.attachments.bytes / 1024 / 1024).toFixed(1)} MB`);
  section('Fehlgeschlagene Anhänge', r.attachments.failed.map((f) => `${f.table}.${f.field} ${f.recordId}: ${f.filename}`));
  section(
    'Verweise auf fehlende Datensätze',
    Object.entries(r.danglingLinks).map(([k, v]) => `${k}: ${v.count} (z.B. ${v.sample.join(', ')})`),
  );
  section(
    'Doppelte Belegnummern',
    r.duplicateNumbers.map((d) => `${d.type} ${d.number} (Firma ${d.companyId}): ${d.recordIds.join(', ')}`),
  );
  section('Benutzer ohne Login-Key', r.usersWithoutKey);
  section('Entfernte geheime Felder', r.strippedSecretFields);
  section('Übernommene Einstellungen', r.importedSettings);
  section('Nicht übernommene Keys (Secrets → Railway-Variablen bzw. entfallen)', r.skippedSettingKeys);
  section('Warnungen', r.warnings);
  return lines.join('\n');
}
