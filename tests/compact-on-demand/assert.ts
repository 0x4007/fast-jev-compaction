/**
 * Minimal dependency-free assertion helpers for the M2 tests.
 *
 * `node:assert` was avoided deliberately: importing it makes Deno resolve
 * `@types/node` from `node_modules`, which is not installed in this worktree,
 * and installing packages is prohibited for M2.
 */

export function assert(condition: unknown, message = "assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function deepEqual(actual: unknown, expected: unknown): boolean {
  if (actual === expected) return true;
  if (typeof actual === "number" && typeof expected === "number") {
    return Number.isNaN(actual) && Number.isNaN(expected);
  }
  if (Array.isArray(actual) || Array.isArray(expected)) {
    if (!Array.isArray(actual) || !Array.isArray(expected)) return false;
    if (actual.length !== expected.length) return false;
    return actual.every((value, index) => deepEqual(value, expected[index]));
  }
  if (isPlainObject(actual) && isPlainObject(expected)) {
    const actualKeys = Object.keys(actual);
    const expectedKeys = Object.keys(expected);
    if (actualKeys.length !== expectedKeys.length) return false;
    return actualKeys.every(
      (key) => Object.hasOwn(expected, key) && deepEqual(actual[key], expected[key]),
    );
  }
  return false;
}

export function assertEquals(actual: unknown, expected: unknown, message?: string): void {
  if (deepEqual(actual, expected)) return;
  throw new Error(
    `${message ?? "values are not equal"}\n  actual:   ${stringify(actual)}\n  expected: ${stringify(expected)}`,
  );
}

export function assertThrows(
  fn: () => unknown,
  pattern?: RegExp,
  message = "expected the function to throw",
): void {
  let thrown: unknown;
  let threw = false;
  try {
    fn();
  } catch (error) {
    threw = true;
    thrown = error;
  }
  if (!threw) throw new Error(message);
  if (pattern !== undefined) {
    const text = thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : String(thrown);
    if (!pattern.test(text)) {
      throw new Error(`${message}\n  thrown: ${text}\n  pattern: ${pattern}`);
    }
  }
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
