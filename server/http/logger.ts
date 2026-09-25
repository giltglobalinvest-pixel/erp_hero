export interface Logger {
  info(entry: Record<string, unknown>): void;
  error(entry: Record<string, unknown>): void;
}

/** One JSON object per line on stdout/stderr. Never pass bodies, cookies or keys. */
export const jsonLogger: Logger = {
  info: (entry) => console.log(JSON.stringify({ level: 'info', time: new Date().toISOString(), ...entry })),
  error: (entry) => console.error(JSON.stringify({ level: 'error', time: new Date().toISOString(), ...entry })),
};
