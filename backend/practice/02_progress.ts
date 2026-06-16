/**
 * EXERCISE 2: Resumable Progress Tracker
 *
 * Problem:
 * Build a progress system that tracks which items have been processed.
 * If the script crashes and restarts, it should skip already-done items.
 *
 * Requirements:
 *   - loadProgress(filePath): Read a JSON file, return a Set<string> of completed IDs
 *   - saveProgress(filePath, completed): Write the Set to a JSON file
 *   - If the file doesn't exist, loadProgress returns an empty Set
 *   - The JSON format is a simple array: ["1", "2", "3"]
 *
 * Why strings?
 *   IDs from APIs can be numbers or strings. Storing as strings in a Set
 *   avoids type coercion bugs (e.g., Set.has(1) vs Set.has("1")).
 *
 * Think about:
 *   - Why save progress AFTER a successful operation, not before?
 *   - What happens if the process crashes mid-write to the JSON file?
 */

import * as fs from "node:fs";
import * as path from "node:path";

const TEST_FILE = path.join(__dirname, "_test_progress.json");

function loadProgress(filePath: string): Set<string> {
  if (fs.existsSync(filePath)) {
    const content = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(content);
    return new Set(parsed);
  } else return new Set();
}

function saveProgress(filePath: string, completed: Set<string>): void {
  return fs.writeFileSync(filePath, JSON.stringify([...completed]), "utf-8");
}

// ─── Tests ───────────────────────────────────────────────────────────────────
function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`✗ FAILED: ${msg}`);
    cleanup();
    process.exit(1);
  }
  console.log(`✓ ${msg}`);
}

function cleanup() {
  if (fs.existsSync(TEST_FILE)) fs.unlinkSync(TEST_FILE);
}

// Start clean
cleanup();

// Test 1: Loading non-existent file returns empty set
const empty = loadProgress(TEST_FILE);
assert(empty.size === 0, "non-existent file → empty Set");

// Test 2: Save and reload
const progress = new Set(["101", "202", "303"]);
saveProgress(TEST_FILE, progress);
const loaded = loadProgress(TEST_FILE);
assert(loaded.size === 3, "loaded set has 3 items");
assert(loaded.has("101"), "contains '101'");
assert(loaded.has("202"), "contains '202'");
assert(loaded.has("303"), "contains '303'");

// Test 3: Append and reload
loaded.add("404");
saveProgress(TEST_FILE, loaded);
const reloaded = loadProgress(TEST_FILE);
assert(reloaded.size === 4, "after adding one, has 4 items");
assert(reloaded.has("404"), "contains the new item '404'");

// Test 4: Verify JSON format
const raw = JSON.parse(fs.readFileSync(TEST_FILE, "utf-8"));
assert(Array.isArray(raw), "file contains a JSON array");
assert(raw.includes("101"), "array contains '101'");

cleanup();
console.log("\n🎉 All tests passed!");

export {};
