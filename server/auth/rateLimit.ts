export interface RateLimitOptions {
  perIp: number;
  global: number;
  windowMs: number;
}

const DEFAULTS: RateLimitOptions = { perIp: 5, global: 30, windowMs: 15 * 60 * 1000 };

/** Counts failed logins in memory (single server instance), plus the attempts still being verified. */
export class LoginRateLimiter {
  private readonly byIp = new Map<string, number[]>();
  private all: number[] = [];
  private readonly inFlightByIp = new Map<string, number>();
  private inFlight = 0;
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

  /** Recent failures plus attempts in flight, so a burst cannot get more tries than the limit allows. */
  isBlocked(ip: string): boolean {
    this.all = this.recent(this.all);
    const mine = this.recent(this.byIp.get(ip) ?? []);
    if (mine.length === 0) this.byIp.delete(ip);
    else this.byIp.set(ip, mine);
    return (
      mine.length + (this.inFlightByIp.get(ip) ?? 0) >= this.opts.perIp || this.all.length + this.inFlight >= this.opts.global
    );
  }

  /**
   * Reserves a slot for one attempt, or returns null when the IP or everyone is blocked.
   * The returned end() releases the slot; a failed attempt is recorded separately with recordFailure().
   */
  begin(ip: string): (() => void) | null {
    if (this.isBlocked(ip)) return null;
    this.inFlight++;
    this.inFlightByIp.set(ip, (this.inFlightByIp.get(ip) ?? 0) + 1);
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      this.inFlight--;
      const remaining = (this.inFlightByIp.get(ip) ?? 1) - 1;
      if (remaining <= 0) this.inFlightByIp.delete(ip);
      else this.inFlightByIp.set(ip, remaining);
    };
  }

  recordFailure(ip: string): void {
    const t = this.now();
    this.all.push(t);
    this.byIp.set(ip, [...(this.byIp.get(ip) ?? []), t]);
  }
}
