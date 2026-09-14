export function transpose(matrix: readonly (readonly number[])[]): number[][] {
  if (matrix.length === 0) return [];
  const columns = matrix[0]!.length;
  const result: number[][] = Array.from({ length: columns }, () => []);
  for (const row of matrix) {
    for (let column = 0; column < columns; column += 1) {
      result[column]!.push(row[column]!);
    }
  }
  return result;
}

export function invertMatrix(matrix: readonly (readonly number[])[]): number[][] | null {
  const n = matrix.length;
  if (n === 0 || matrix.some((row) => row.length !== n)) return null;
  const augmented = matrix.map((row, index) => {
    const identity = Array.from({ length: n }, (_, column) => (column === index ? 1 : 0));
    return [...row, ...identity];
  });
  for (let pivot = 0; pivot < n; pivot += 1) {
    let best = pivot;
    for (let row = pivot + 1; row < n; row += 1) {
      if (Math.abs(augmented[row]![pivot]!) > Math.abs(augmented[best]![pivot]!)) best = row;
    }
    const swap = augmented[pivot]!;
    augmented[pivot] = augmented[best]!;
    augmented[best] = swap;
    const diagonal = augmented[pivot]![pivot]!;
    if (!Number.isFinite(diagonal) || Math.abs(diagonal) < 1e-12) return null;
    for (let column = 0; column < 2 * n; column += 1) {
      augmented[pivot]![column] = augmented[pivot]![column]! / diagonal;
    }
    for (let row = 0; row < n; row += 1) {
      if (row === pivot) continue;
      const factor = augmented[row]![pivot]!;
      for (let column = 0; column < 2 * n; column += 1) {
        augmented[row]![column] = augmented[row]![column]! - factor * augmented[pivot]![column]!;
      }
    }
  }
  return augmented.map((row) => row.slice(n));
}

export function mahalanobisDistance(
  left: readonly number[],
  right: readonly number[],
  inverseCovariance: readonly (readonly number[])[],
): number {
  const delta = left.map((value, index) => value - right[index]!);
  const intermediate = inverseCovariance.map((row) =>
    row.reduce((sum, value, column) => sum + value * delta[column]!, 0)
  );
  const quadratic = delta.reduce((sum, value, index) => sum + value * intermediate[index]!, 0);
  return Math.sqrt(Math.max(0, quadratic));
}

export function euclideanDistance(left: readonly number[], right: readonly number[], weights?: readonly number[]): number {
  let sum = 0;
  for (let index = 0; index < left.length; index += 1) {
    const weight = weights?.[index] ?? 1;
    const delta = left[index]! - right[index]!;
    sum += weight * delta * delta;
  }
  return Math.sqrt(sum);
}

export function sampleMean(rows: readonly (readonly number[])[]): number[] {
  const width = rows[0]?.length ?? 0;
  const mean = Array.from({ length: width }, () => 0);
  if (rows.length === 0) return mean;
  for (const row of rows) {
    for (let column = 0; column < width; column += 1) {
      mean[column] = mean[column]! + row[column]!;
    }
  }
  return mean.map((value) => value / rows.length);
}

export function sampleCovariance(rows: readonly (readonly number[])[], mean: readonly number[]): number[][] {
  const n = mean.length;
  const cov = Array.from({ length: n }, () => Array.from({ length: n }, () => 0));
  if (rows.length < 2) return cov;
  for (const row of rows) {
    for (let i = 0; i < n; i += 1) {
      for (let j = 0; j < n; j += 1) {
        cov[i]![j] = cov[i]![j]! + (row[i]! - mean[i]!) * (row[j]! - mean[j]!);
      }
    }
  }
  const denom = rows.length - 1;
  return cov.map((row) => row.map((value) => value / denom));
}
