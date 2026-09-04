import {
  createClient,
  type SupabaseClient,
  type Session,
  type User,
} from "@supabase/supabase-js";
import { createHmac, randomUUID } from "node:crypto";

export const testUrl =
  process.env.SUPABASE_TEST_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
export const testAnonKey =
  process.env.SUPABASE_TEST_ANON_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
  "";
export const testServiceKey =
  process.env.SUPABASE_TEST_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  "";

export function requireDbConfig(): void {
  const missing = [
    ["SUPABASE_TEST_URL or NEXT_PUBLIC_SUPABASE_URL", testUrl],
    [
      "SUPABASE_TEST_ANON_KEY or NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
      testAnonKey,
    ],
    [
      "SUPABASE_TEST_SERVICE_ROLE_KEY or SUPABASE_SERVICE_ROLE_KEY",
      testServiceKey,
    ],
  ].filter(([, value]) => !value);

  if (missing.length > 0) {
    throw new Error(
      `Missing real DB integration configuration: ${missing.map(([name]) => name).join(", ")}`,
    );
  }
}

export function createAdminClient(): SupabaseClient {
  requireDbConfig();
  return createClient(testUrl, testServiceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export function createAnonClient(): SupabaseClient {
  requireDbConfig();
  return createClient(testUrl, testAnonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export function createAuthenticatedClient(session: Session): SupabaseClient {
  requireDbConfig();
  return createClient(testUrl, testAnonKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    global: {
      headers: {
        Authorization: `Bearer ${session.access_token}`,
      },
    },
  });
}

function base64UrlEncode(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}

function resolveJwtSecret(explicit?: string): string {
  const secret =
    explicit ||
    process.env.SUPABASE_TEST_JWT_SECRET ||
    process.env.SUPABASE_JWT_SECRET ||
    process.env.JWT_SECRET ||
    "";
  if (!secret) {
    throw new Error(
      "[DB fixture] JWT secret unavailable: set SUPABASE_JWT_SECRET (from `supabase status -o env`) or pass it explicitly. " +
        'In CI/rehearsal the value is exported by `supabase status -o env`; locally run `eval "$(npx supabase status -o env)"` before `pnpm test:db`.',
    );
  }
  return secret;
}

export function mintSupabaseJwt(
  sub: string,
  jwtSecret?: string,
  opts?: { role?: string; expiresInSeconds?: number },
): string {
  const secret = resolveJwtSecret(jwtSecret);
  const role = opts?.role ?? "authenticated";
  const expiresInSeconds = opts?.expiresInSeconds ?? 60;
  const now = Math.floor(Date.now() / 1000);

  const header = base64UrlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64UrlEncode(
    JSON.stringify({
      sub,
      role,
      aud: role,
      iss: "supabase-demo",
      iat: now,
      exp: now + expiresInSeconds,
    }),
  );
  const signingInput = `${header}.${payload}`;
  const signature = createHmac("sha256", secret)
    .update(signingInput)
    .digest("base64url");

  return `${signingInput}.${signature}`;
}

export function createAuthenticatedClientForUser(
  userId: string,
  jwtSecret?: string,
  role: string = "authenticated",
): SupabaseClient {
  const token = mintSupabaseJwt(userId, jwtSecret, { role });
  requireDbConfig();
  return createClient(testUrl, testAnonKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    global: {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  });
}

type SupabaseResult = { error: { message: string } | null };

export function assertSupabaseSuccess<T extends SupabaseResult>(
  result: T,
  operation: string,
): T {
  if (result.error) {
    throw new Error(
      `[DB fixture] ${operation} failed: ${result.error.message}`,
    );
  }

  return result;
}

export function assertSupabaseMutation<
  T extends SupabaseResult & { data: unknown[] | null },
>(result: T, operation: string): T {
  assertSupabaseSuccess(result, operation);

  if (!result.data || result.data.length === 0) {
    throw new Error(`[DB fixture] ${operation} affected no rows`);
  }

  return result;
}

export function uniqueEmail(prefix: string): string {
  return `${prefix}.${randomUUID()}@example.test`;
}

export function uniqueName(prefix: string): string {
  return `${prefix} ${randomUUID()}`;
}

export async function createTestUser(
  adminClient: SupabaseClient,
  email = uniqueEmail("user"),
  password = "TestPassword123!",
): Promise<{ user: User; email: string; password: string }> {
  const result = await adminClient.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  assertSupabaseSuccess(result, `create test user ${email}`);

  if (!result.data.user) {
    throw new Error(`[DB fixture] create test user ${email} returned no user`);
  }

  return { user: result.data.user, email, password };
}

export async function signInTestUser(
  email: string,
  password: string,
): Promise<{ session: Session; client: SupabaseClient }> {
  const signInClient = createAnonClient();
  const result = await signInClient.auth.signInWithPassword({
    email,
    password,
  });
  assertSupabaseSuccess(result, `sign in test user ${email}`);

  if (!result.data.session) {
    throw new Error(
      `[DB fixture] sign in test user ${email} returned no session`,
    );
  }

  return {
    session: result.data.session,
    client: createAuthenticatedClient(result.data.session),
  };
}

export async function cleanupFixture(
  adminClient: SupabaseClient,
  params: { userIds?: string[]; providerIds?: string[] },
): Promise<void> {
  if (params.providerIds && params.providerIds.length > 0) {
    const deletedProviders = await adminClient
      .from("providers")
      .delete()
      .in("id", params.providerIds);
    assertSupabaseSuccess(
      deletedProviders,
      `delete fixture Providers ${params.providerIds.join(", ")}`,
    );
  }

  if (params.userIds) {
    await Promise.all(
      params.userIds.map(async (userId) => {
        const deletedUser = await adminClient.auth.admin.deleteUser(userId);
        assertSupabaseSuccess(deletedUser, `delete fixture user ${userId}`);
      }),
    );
  }
}
