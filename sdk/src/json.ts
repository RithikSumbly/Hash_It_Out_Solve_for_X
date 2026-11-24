/** JSON that round-trips bigint as "123n" strings — the relay wire format. */
export function stringify(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? `${x.toString()}n` : x));
}

const BIG = /^-?\d+n$/;

export function parse<T = unknown>(s: string): T {
  return JSON.parse(s, (_k, x) => (typeof x === "string" && BIG.test(x) ? BigInt(x.slice(0, -1)) : x)) as T;
}
