/** [method, path pattern]; "{id}" matches digits only, everything else must match literally. */
export type Rule = readonly [method: string, pattern: string];

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function compileRules(rules: readonly Rule[]): (method: string, path: string) => boolean {
  const compiled = rules.map(([method, pattern]) => ({
    method,
    re: new RegExp(`^${pattern.split('/').map((seg) => (seg === '{id}' ? '\\d+' : escapeRegex(seg))).join('/')}$`),
  }));
  return (method, path) => compiled.some((r) => r.method === method && r.re.test(path));
}
