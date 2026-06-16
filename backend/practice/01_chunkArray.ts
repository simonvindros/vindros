/// <reference types="node" />
/**
 * EXERCISE 1: chunkArray
 *
 * Problem:
 * Given an array and a chunk size, split the array into sub-arrays
 * of at most `size` elements each.
 *
 * Example:
 *   chunkArray([1, 2, 3, 4, 5], 2) → [[1, 2], [3, 4], [5]]
 *   chunkArray([1, 2, 3], 5) → [[1, 2, 3]]
 *   chunkArray([], 3) → []
 *
 * Constraints:
 *   - Must work with any type T (generic)
 *   - Do NOT mutate the original array
 *   - Think about: what is the time complexity? (answer at bottom)
 */

function chunkArray<T>(array: T[], size: number): T[][] {
  let chunk: T[][] = [];

  for (let i = 0; i < array.length; i += size) {
    chunk.push(array.slice(i, i + size));
  }

  return chunk;
}

// ─── Tests ───────────────────────────────────────────────────────────────────
function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`✗ FAILED: ${msg}`);
    process.exit(1);
  }
  console.log(`✓ ${msg}`);
}

const r1 = chunkArray([1, 2, 3, 4, 5], 2);
assert(r1.length === 3, "5 elements / chunk 2 = 3 chunks");
assert(
  r1[0].length === 2 && r1[0][0] === 1 && r1[0][1] === 2,
  "first chunk is [1, 2]",
);
assert(r1[2].length === 1 && r1[2][0] === 5, "last chunk is [5]");

const r2 = chunkArray([1, 2, 3], 5);
assert(r2.length === 1, "array smaller than chunk = 1 chunk");
assert(r2[0].length === 3, "single chunk has all elements");

const r3 = chunkArray([], 3);
assert(r3.length === 0, "empty array = no chunks");

const r4 = chunkArray(["a", "b", "c", "d"], 2);
assert(r4[0][0] === "a" && r4[1][1] === "d", "works with strings");

const original = [1, 2, 3, 4];
chunkArray(original, 2);
assert(original.length === 4, "does not mutate original array");

console.log("\n🎉 All tests passed!");
console.log("\n📝 Answer: What is the time complexity of your solution?");
console.log("   Think about how many elements get copied in total by slice().");
console.log("   Write your answer here: ___");

export {};
