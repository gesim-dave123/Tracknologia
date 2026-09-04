import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Issue #46 (PR #62) — Staff invitation recipient-binding guard.
 *
 * The `accept_staff_invitation` RPC must reject acceptance when the
 * authenticated user's `auth.users.email` is missing (NULL) instead of
 * skipping the recipient check (fail-open). Migrations are forward-only, so
 * the effective definition is the latest migration file (by timestamped name)
 * containing the binding guard; earlier definitions are superseded history.
 *
 * Why a static guard test: a NULL-email *interactive* session cannot be
 * provisioned on the default Supabase stacks used locally and in CI —
 * `phone_provider_disabled` blocks phone signup/sign-in, anonymous sign-ins
 * are disabled, and the Admin API issues no session. The behavioral
 * mismatch branch of this same statement is covered by the wrong-email case
 * in `tests/integration/invitations.db.test.ts`; this test locks the exact
 * changed guard lines so the NULL fail-open cannot silently return.
 */
const FAIL_OPEN_PATTERN =
  /IF\s+v_user_email\s+IS\s+NOT\s+NULL\s+AND\s+lower\s*\(\s*trim\s*\(\s*v_user_email\s*\)/;
const FAIL_CLOSED_PATTERN =
  /IF\s+v_user_email\s+IS\s+NULL\s+OR\s+lower\s*\(\s*trim\s*\(\s*v_user_email\s*\)/;

function readLatestAcceptGuard(): { file: string; sql: string } {
  const dir = join(process.cwd(), "supabase", "migrations");
  const candidates = readdirSync(dir)
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .map((file) => ({
      file,
      sql: readFileSync(join(dir, file), "utf8"),
    }))
    .filter(({ sql }) => sql.includes("v_user_email"));

  expect(candidates.length).toBeGreaterThan(0);
  return candidates[candidates.length - 1];
}

describe("Staff invitation email binding guard", () => {
  it("rejects a missing authenticated email instead of skipping the check", () => {
    const latest = readLatestAcceptGuard();
    expect(latest.sql).not.toMatch(FAIL_OPEN_PATTERN);
  });

  it("denies on NULL email or case-insensitive mismatch", () => {
    const latest = readLatestAcceptGuard();
    expect(latest.sql).toMatch(FAIL_CLOSED_PATTERN);
  });
});
