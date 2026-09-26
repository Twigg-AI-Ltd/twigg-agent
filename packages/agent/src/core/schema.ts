// A small schema builder: each schema validates a value and carries the JSON Schema that
// describes it, so a tool's input is declared once for both the model and the harness.

export interface Issue {
  /** Dotted path of the offending value; "" is the root. */
  path: string;
  message: string;
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; issues: Issue[] };

type Json = Record<string, unknown>;

/** Returns the validated value, or adds to `issues` (the return value is then ignored). */
type Check<T> = (value: unknown, path: string, issues: Issue[]) => T;

export class Schema<T> {
  constructor(
    readonly json: Json,
    readonly check: Check<T>,
  ) {}

  /** Also accepts undefined; an object leaves the key out of `required`. */
  optional(): Schema<T | undefined> {
    const schema = new Schema<T | undefined>(this.json, (v, path, issues) =>
      v === undefined ? undefined : this.check(v, path, issues),
    );
    return Object.assign(schema, { isOptional: true });
  }

  describe(description: string): this {
    const copy = new Schema({ ...this.json, description }, this.check);
    return Object.assign(copy, { isOptional: isOptional(this) }) as unknown as this;
  }

  parse(value: unknown): ParseResult<T> {
    const issues: Issue[] = [];
    const parsed = this.check(value, "", issues);
    return issues.length === 0 ? { ok: true, value: parsed } : { ok: false, issues };
  }
}

export type Infer<S> = S extends Schema<infer T> ? T : never;

type Shape = Record<string, Schema<unknown>>;
type OptionalKeys<P extends Shape> = {
  [K in keyof P]: undefined extends Infer<P[K]> ? K : never;
}[keyof P];
type Flatten<T> = { [K in keyof T]: T[K] };
type ObjectOf<P extends Shape> = Flatten<
  { [K in Exclude<keyof P, OptionalKeys<P>>]: Infer<P[K]> } & {
    [K in OptionalKeys<P>]?: Infer<P[K]>;
  }
>;

function isOptional(schema: Schema<unknown>): boolean {
  return (schema as { isOptional?: boolean }).isOptional === true;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function typeName(v: unknown): string {
  return v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
}

function join(path: string, key: string | number): string {
  return path === "" ? String(key) : `${path}.${key}`;
}

/** Drops the keys whose value is undefined, so they don't appear in the JSON Schema. */
function defined(json: Json): Json {
  return Object.fromEntries(Object.entries(json).filter(([, v]) => v !== undefined));
}

export function string(
  opts: { min?: number; max?: number; pattern?: RegExp; message?: string } = {},
): Schema<string> {
  const { min, max, pattern } = opts;
  const json = defined({
    type: "string",
    minLength: min,
    maxLength: max,
    pattern: pattern?.source,
  });
  return new Schema(json, (v, path, issues) => {
    const bad = (message: string) => issues.push({ path, message });
    if (typeof v !== "string") bad(`expected a string, got ${typeName(v)}`);
    else if (min !== undefined && v.length < min)
      bad(min === 1 ? "must not be empty" : `must be at least ${min} characters`);
    else if (max !== undefined && v.length > max) bad(`must be at most ${max} characters`);
    else if (pattern && !pattern.test(v)) bad(opts.message ?? `must match ${pattern.source}`);
    return v as string;
  });
}

export function number(
  opts: { int?: boolean; min?: number; max?: number; gt?: number; lt?: number } = {},
): Schema<number> {
  const { int, min, max, gt, lt } = opts;
  const json = defined({
    type: int ? "integer" : "number",
    minimum: min,
    maximum: max,
    exclusiveMinimum: gt,
    exclusiveMaximum: lt,
  });
  return new Schema(json, (v, path, issues) => {
    const bad = (message: string) => issues.push({ path, message });
    if (typeof v !== "number" || !Number.isFinite(v)) bad(`expected a number, got ${typeName(v)}`);
    else if (int && !Number.isSafeInteger(v)) bad("must be a whole number");
    else if (min !== undefined && v < min) bad(`must be at least ${min}`);
    else if (max !== undefined && v > max) bad(`must be at most ${max}`);
    else if (gt !== undefined && v <= gt) bad(`must be greater than ${gt}`);
    else if (lt !== undefined && v >= lt) bad(`must be less than ${lt}`);
    return v as number;
  });
}

export function boolean(): Schema<boolean> {
  return new Schema({ type: "boolean" }, (v, path, issues) => {
    if (typeof v !== "boolean") {
      issues.push({ path, message: `expected true or false, got ${typeName(v)}` });
    }
    return v as boolean;
  });
}

/** One of the given strings. */
export function oneOf<const V extends readonly string[]>(values: V): Schema<V[number]> {
  return new Schema({ type: "string", enum: [...values] }, (v, path, issues) => {
    if (typeof v !== "string" || !values.includes(v)) {
      issues.push({ path, message: `must be one of ${values.join(", ")}` });
    }
    return v as V[number];
  });
}

export function array<T>(item: Schema<T>, opts: { min?: number } = {}): Schema<T[]> {
  const json = defined({ type: "array", minItems: opts.min, items: item.json });
  return new Schema(json, (v, path, issues) => {
    if (!Array.isArray(v)) {
      issues.push({ path, message: `expected an array, got ${typeName(v)}` });
      return [];
    }
    if (opts.min !== undefined && v.length < opts.min) {
      issues.push({ path, message: `must have at least ${opts.min} item(s)` });
    }
    return v.map((el, i) => item.check(el, join(path, i), issues));
  });
}

/** An object with string values under any keys. */
export function record<T>(value: Schema<T>): Schema<Record<string, T>> {
  const json = { type: "object", additionalProperties: value.json };
  return new Schema(json, (v, path, issues) => {
    if (!isPlainObject(v)) {
      issues.push({ path, message: `expected an object, got ${typeName(v)}` });
      return {};
    }
    return Object.fromEntries(
      Object.entries(v).map(([k, el]) => [k, value.check(el, join(path, k), issues)]),
    );
  });
}

/**
 * An object with the given properties. Unknown keys are dropped ("strip"), rejected ("strict") or
 * kept as they are ("keep").
 */
export function object<P extends Shape>(
  shape: P,
  unknownKeys: "strip" | "strict" | "keep" = "strip",
): Schema<ObjectOf<P>> {
  const keys = Object.keys(shape);
  const required = keys.filter((k) => !isOptional(shape[k] as Schema<unknown>));
  const json = defined({
    type: "object",
    properties: Object.fromEntries(keys.map((k) => [k, (shape[k] as Schema<unknown>).json])),
    required: required.length > 0 ? required : undefined,
    additionalProperties: unknownKeys === "keep" ? undefined : false,
  });
  return new Schema(json, (v, path, issues) => {
    if (!isPlainObject(v)) {
      issues.push({ path, message: `expected an object, got ${typeName(v)}` });
      return {} as ObjectOf<P>;
    }
    const out: Record<string, unknown> = unknownKeys === "keep" ? { ...v } : {};
    for (const k of keys) {
      const schema = shape[k] as Schema<unknown>;
      if (v[k] === undefined && !isOptional(schema)) {
        issues.push({ path: join(path, k), message: "is required" });
        continue;
      }
      const parsed = schema.check(v[k], join(path, k), issues);
      if (parsed !== undefined) out[k] = parsed;
    }
    const unknown = Object.keys(v).filter((k) => !keys.includes(k));
    if (unknownKeys === "strict" && unknown.length > 0) {
      issues.push({ path, message: `unknown key(s) ${unknown.join(", ")}` });
    }
    return out as ObjectOf<P>;
  });
}

/**
 * The first option that accepts the value. When none does, the issues are those of the last
 * option that got furthest (it accepted the value's own type), which name the offending field.
 */
export function union<S extends Schema<unknown>[]>(...options: S): Schema<Infer<S[number]>> {
  const json = { anyOf: options.map((o) => o.json) };
  return new Schema(json, (v, path, issues) => {
    let closest: Issue[] | undefined;
    for (const option of options) {
      const found: Issue[] = [];
      const parsed = option.check(v, path, found);
      if (found.length === 0) return parsed as Infer<S[number]>;
      if (!found.some((i) => i.path === path && i.message.startsWith("expected "))) closest = found;
    }
    issues.push(...(closest ?? [{ path, message: `invalid value of type ${typeName(v)}` }]));
    return v as Infer<S[number]>;
  });
}

/** A value checked (and possibly converted) by `convert`, which returns undefined to reject it. */
export function custom<T>(
  json: Json,
  convert: (value: unknown) => T | undefined,
  message: (value: unknown) => string,
): Schema<T> {
  return new Schema(json, (v, path, issues) => {
    const converted = convert(v);
    if (converted === undefined) issues.push({ path, message: message(v) });
    return converted as T;
  });
}

/** One line per issue, for error messages. */
export function formatIssues(issues: Issue[]): string {
  return issues.map((i) => `- ${i.path || "(root)"}: ${i.message}`).join("\n");
}
