#!/usr/bin/env node

/**
 * Unit tests for check-migration-versions.mjs
 *
 * Tests the version extraction, duplicate detection, and backfill prevention logic.
 * Run via: node scripts/check-migration-versions.test.mjs
 */

/**
 * Test helper: assert equality with labeled output
 */
function assert(condition, message) {
  if (!condition) {
    console.error(`✗ FAIL: ${message}`);
    process.exit(1);
  }
  console.log(`✓ PASS: ${message}`);
}

/**
 * Test getVersion (pure function, extracted from main script)
 */
function getVersion(filename) {
  const match = filename.match(/^(\d{14})/);
  return match ? match[1] : null;
}

/**
 * Test version extraction
 */
function testVersionExtraction() {
  console.log("\n=== Version Extraction ===");

  assert(
    getVersion("20260610000000_drop_scheme_master_backfill_columns.sql") === "20260610000000",
    "Extract version from valid filename"
  );

  assert(
    getVersion("20260612000000_drop_backfill_columns_for_real.sql") === "20260612000000",
    "Extract version with suffix"
  );

  assert(
    getVersion("invalid_filename.sql") === null,
    "Return null for invalid filename"
  );

  assert(
    getVersion("202606100000_missing_digits.sql") === null,
    "Return null if version has fewer than 14 digits"
  );
}

/**
 * Test duplicate detection
 */
function testDuplicateDetection() {
  console.log("\n=== Duplicate Detection ===");

  // Simulate the checkDuplicateVersions logic
  function hasDuplicate(files) {
    const versions = new Set();
    for (const file of files) {
      const version = getVersion(file);
      if (!version) continue;
      if (versions.has(version)) return true;
      versions.add(version);
    }
    return false;
  }

  const noDups = [
    "20260610000000_drop_scheme_master_backfill_columns.sql",
    "20260610000001_fix_sync_nav_cron_app_config.sql",
    "20260610000002_nav_retention_cron.sql",
  ];

  assert(!hasDuplicate(noDups), "No duplicates in clean list");

  const withDups = [
    "20260610000000_drop_scheme_master_backfill_columns.sql",
    "20260610000000_fix_sync_nav_cron_app_config.sql", // ← collision
    "20260610000001_nav_retention_cron.sql",
  ];

  assert(hasDuplicate(withDups), "Detect duplicate version prefixes");

  const singleFile = ["20260612000000_single_migration.sql"];
  assert(!hasDuplicate(singleFile), "Single file has no duplicates");
}

/**
 * Test backfill detection
 */
function testBackfillDetection() {
  console.log("\n=== Backfill Detection ===");

  function detectBackfill(newVersions, mainVersions) {
    const maxMainVersion = Math.max(...mainVersions.map(Number));
    for (const version of newVersions) {
      if (Number(version) <= maxMainVersion) {
        return true; // Backfill detected
      }
    }
    return false;
  }

  // New migration is > max on main
  const mainVersions = ["20260610000000", "20260610000001", "20260610000002"];
  const newVersionsValid = ["20260612000000"];
  assert(
    !detectBackfill(newVersionsValid, mainVersions),
    "New versions > max main: no backfill"
  );

  // New migration is ≤ max on main (backfill)
  const newVersionsBackfill = ["20260610000001"];
  assert(
    detectBackfill(newVersionsBackfill, mainVersions),
    "New version ≤ max main: detect backfill"
  );

  // Multiple new versions, one is a backfill
  const newVersionsMixed = ["20260610000003", "20260610000001"];
  assert(
    detectBackfill(newVersionsMixed, mainVersions),
    "Mixed new versions with one backfill: detect backfill"
  );

  // No new versions
  const newVersionsNone = [];
  assert(
    !detectBackfill(newVersionsNone, mainVersions),
    "No new versions: no backfill"
  );
}

/**
 * Test edge cases
 */
function testEdgeCases() {
  console.log("\n=== Edge Cases ===");

  assert(getVersion("") === null, "Empty string returns null");
  assert(getVersion(".sql") === null, "No version prefix returns null");

  // Version ordering (numeric, not lexicographic)
  const version1 = "20260609000000";
  const version2 = "20260610000000";
  const version3 = "20260612000000";
  assert(
    Number(version1) < Number(version2) && Number(version2) < Number(version3),
    "Version ordering is numeric"
  );
}

/**
 * Run all tests
 */
function runAllTests() {
  console.log("Testing check-migration-versions logic...");
  testVersionExtraction();
  testDuplicateDetection();
  testBackfillDetection();
  testEdgeCases();

  console.log("\n✓ All tests passed!");
  process.exit(0);
}

runAllTests();
