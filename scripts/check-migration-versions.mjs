#!/usr/bin/env node

/**
 * Check migration version integrity.
 *
 * Fails if:
 *   1. Two migration files in supabase/migrations share a version prefix
 *      (e.g., 20260610000000_foo.sql and 20260610000000_bar.sql)
 *   2. A PR adds a migration with version ≤ the max version already on origin/main
 *      (prevents backfilling old migrations that should live on a feature branch)
 *
 * Rationale: migration 20260610000000_drop_scheme_master_backfill_columns.sql had its
 * ledger entry mis-named and never executed; we later discovered it as drift. This guard
 * prevents both accidental version collisions and unintended squashing of old migrations.
 *
 * Usage:
 *   node scripts/check-migration-versions.mjs [--check-branch]
 *
 * --check-branch: Compare against origin/main; fails if new migration versions
 *                 are ≤ the max version on main (intended for CI against PRs).
 */

import fs from "fs";
import path from "path";
import { execSync } from "child_process";

const MIGRATIONS_DIR = "supabase/migrations";

/**
 * Extract version from migration filename.
 * Assumes format: 20260610000000_description.sql
 */
function getVersion(filename) {
  const match = filename.match(/^(\d{14})/);
  return match ? match[1] : null;
}

/**
 * Get all migration files on disk.
 */
function getMigrationsOnDisk() {
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    console.log(`Migrations directory ${MIGRATIONS_DIR} not found.`);
    return [];
  }

  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

/**
 * Get migration files that exist on origin/main.
 */
function getMigrationsOnMain() {
  try {
    const output = execSync(
      "git ls-tree -r origin/main -- supabase/migrations/ | awk '{print $NF}'",
      { encoding: "utf-8" }
    );
    return output
      .split("\n")
      .filter((f) => f.endsWith(".sql") && f.length > 0)
      .map((f) => path.basename(f))
      .sort();
  } catch (err) {
    console.error("Failed to list migrations on origin/main:", err.message);
    process.exit(1);
  }
}

/**
 * Check for duplicate version prefixes within a list of migrations.
 */
function checkDuplicateVersions(migrations) {
  const versions = new Map();

  for (const file of migrations) {
    const version = getVersion(file);
    if (!version) {
      console.error(`Skipping file with invalid version format: ${file}`);
      continue;
    }

    if (versions.has(version)) {
      const existing = versions.get(version);
      console.error(
        `Version collision: "${file}" and "${existing}" both use version ${version}`
      );
      process.exit(1);
    }

    versions.set(version, file);
  }

  console.log(`✓ No duplicate version prefixes (checked ${migrations.length} files)`);
  return versions;
}

/**
 * Check that new migrations don't backfill versions older than origin/main.
 */
function checkNoBackfill(onDisk, onMain) {
  const diskVersions = new Map();
  const mainVersions = new Map();

  for (const file of onDisk) {
    const version = getVersion(file);
    if (version) diskVersions.set(version, file);
  }

  for (const file of onMain) {
    const version = getVersion(file);
    if (version) mainVersions.set(version, file);
  }

  // Max version on main.
  const maxMainVersion = Math.max(...Array.from(mainVersions.keys()).map(Number));

  // Find new migrations (on disk but not on main).
  const newMigrations = Array.from(diskVersions.entries()).filter(
    ([version]) => !mainVersions.has(version)
  );

  if (newMigrations.length === 0) {
    console.log("✓ No new migrations detected.");
    return;
  }

  let hasBackfill = false;
  for (const [version, file] of newMigrations) {
    if (Number(version) <= maxMainVersion) {
      console.error(
        `Backfill detected: "${file}" (version ${version}) ≤ max main version ${maxMainVersion}`
      );
      hasBackfill = true;
    }
  }

  if (hasBackfill) {
    console.error(
      "Backfilling old migration versions is not allowed. Create new migrations with newer timestamps."
    );
    process.exit(1);
  }

  console.log(
    `✓ New migrations (${newMigrations.length}) all have versions > max main (${maxMainVersion})`
  );
}

// Main.
async function main() {
  const checkBranch = process.argv.includes("--check-branch");

  console.log("Checking migration versions...\n");

  const onDisk = getMigrationsOnDisk();
  console.log(`Migrations on disk: ${onDisk.length}`);

  // Always check for duplicates.
  checkDuplicateVersions(onDisk);

  // If --check-branch, also verify no backfill and check main for collisions.
  if (checkBranch) {
    const onMain = getMigrationsOnMain();
    console.log(`Migrations on origin/main: ${onMain.length}`);
    // Check for duplicates on main too (important for catching existing issues).
    checkDuplicateVersions(onMain);
    checkNoBackfill(onDisk, onMain);
  }

  console.log("\n✓ All checks passed.");
}

main();
