/** Partition an array into two arrays based on a predicate */
export function partition<T>(
  arr: T[],
  predicate: (item: T) => boolean,
): [T[], T[]] {
  const pass: T[] = [];
  const fail: T[] = [];
  for (const item of arr) {
    if (predicate(item)) pass.push(item);
    else fail.push(item);
  }
  return [pass, fail];
}

/** Filter an array, returning the truthy results of the filter function */
export function filterMap<T, U>(arr: T[], fn: (t: T) => U | undefined): U[] {
  const out: U[] = [];
  for (const t of arr) {
    const u = fn(t);
    if (u) out.push(u);
  }
  return out;
}
