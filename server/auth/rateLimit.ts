export interface RateLimitOptions {
  perIp: number;
  global: number;
  windowMs: number;
}

const DEFAULTS: RateLimitOptions = { perIp: 5, global: 30, windowMs: 15 * 60 * 1000 };

/** Counts failed logins in memory (single server instance). */
export class LoginRateLimiter {
  private readonly byIp = new Map<string, number[]>();
  private all: number[] = [];
  private readonly opts: RateLimitOptions;

  constructor(
    opts: Partial<RateLimitOptions> = {},
    private readonly now: () => number = Date.now,
  ) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  private recent(times: number[]): number[] {
    const cutoff = this.now() - this.opts.windowMs;
    return times.filter((t) => t > cutoff);
  }

  isBlocked(ip: string): boolean {
    this.all = this.recent(this.all);
    const mine = this.recent(this.byIp.get(ip) ?? []);
    if (mine.length === 0) this.byIp.delete(ip);
    else this.byIp.set(ip, mine);
    return mine.length >= this.opts.perIp || this.all.length >= this.opts.global;
  }

  recordFailure(ip: string): void {
    const t = this.now();
    this.all.push(t);
    this.byIp.set(ip, [...(this.byIp.get(ip) ?? []), t]);
  }
}
