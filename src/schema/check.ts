// A tiny structural checker. Each problem is reported with the path to the
// offending field, e.g. "repo.base: expected a non-empty string".

export type Problems = string[];

export class Checker {
  readonly problems: Problems = [];

  constructor(private readonly prefix = '') {}

  private at(path: string): string {
    return this.prefix ? (path ? `${this.prefix}.${path}` : this.prefix) : path || '(root)';
  }

  fail(path: string, message: string): void {
    this.problems.push(`${this.at(path)}: ${message}`);
  }

  object(value: unknown, path: string): value is Record<string, unknown> {
    if (value && typeof value === 'object' && !Array.isArray(value)) return true;
    this.fail(path, 'expected an object');
    return false;
  }

  string(value: unknown, path: string, opts: { optional?: boolean; pattern?: RegExp } = {}): boolean {
    if (value === undefined && opts.optional) return true;
    if (typeof value !== 'string' || value.trim() === '') {
      this.fail(path, 'expected a non-empty string');
      return false;
    }
    if (opts.pattern && !opts.pattern.test(value)) {
      this.fail(path, `does not match ${opts.pattern}`);
      return false;
    }
    return true;
  }

  number(value: unknown, path: string, opts: { optional?: boolean; min?: number } = {}): boolean {
    if (value === undefined && opts.optional) return true;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      this.fail(path, 'expected a number');
      return false;
    }
    if (opts.min !== undefined && value < opts.min) {
      this.fail(path, `expected at least ${opts.min}`);
      return false;
    }
    return true;
  }

  oneOf<T extends string>(value: unknown, path: string, allowed: readonly T[], optional = false): value is T {
    if (value === undefined && optional) return true;
    if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) return true;
    this.fail(path, `expected one of ${allowed.join(', ')}`);
    return false;
  }

  array(value: unknown, path: string, optional = false): value is unknown[] {
    if (value === undefined && optional) return true;
    if (Array.isArray(value)) return true;
    this.fail(path, 'expected an array');
    return false;
  }

  strings(value: unknown, path: string, optional = false): void {
    if (!this.array(value, path, optional) || value === undefined) return;
    value.forEach((item, i) => this.string(item, `${path}[${i}]`));
  }

  get ok(): boolean {
    return this.problems.length === 0;
  }
}
