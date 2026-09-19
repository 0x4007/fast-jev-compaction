import { configDefaults, defineConfig } from "vitest/config";

/**
 * `tests/compact-on-demand/**` are Deno-native acceptance harnesses: they use
 * `Deno.test`, `Deno.Command`, and the pinned fork binary, and they are driven
 * by `deno test` (see docs/compact-on-demand/IMPLEMENTATION.md §4). They match
 * vitest's default `*.test.ts` glob, so they must be excluded here or plain
 * `npm test` would try to collect them and fail with `Deno is not defined`.
 */
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "tests/compact-on-demand/**"],
  },
});
