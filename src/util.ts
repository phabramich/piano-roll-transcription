export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

// First index in [0, count) where lessThan(index) is false — count if all pass.
export function lowerBoundBy(
  count: number,
  lessThan: (index: number) => boolean,
): number {
  let low = 0;
  let high = count;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (lessThan(middle)) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

export function formatTime(seconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  return `${Math.floor(safeSeconds / 60)}:${String(safeSeconds % 60).padStart(2, '0')}`;
}
