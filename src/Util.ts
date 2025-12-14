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
