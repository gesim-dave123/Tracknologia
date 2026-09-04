import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";

vi.mock("server-only", () => ({}));

import { hashInvitationToken } from "@/features/providers/persistence";
import {
  cleanupFixture,
  assertSupabaseMutation,
  assertSupabaseSuccess,
  createAdminClient,
  createAnonClient,
  createAuthenticatedClientForUser,
  createTestUser,
  signInTestUser,
  requireDbConfig,
  uniqueEmail,
  uniqueName,
} from "./helpers/supabase-test-context";
import {
  createProviderAs,
  directRepairInput,
} from "./helpers/shared-test-utils";

requireDbConfig();

const password = "TestPassword123!";

async function createInvitationAs(
  client: SupabaseClient,
  email = uniqueEmail("staff"),
): Promise<{
  invitationId: string;
  email: string;
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
  reused: boolean;
}> {
  const tokenHash = hashInvitationToken(`inv_${randomUUID()}_${randomUUID()}`);
  const { data, error } = await client.rpc("create_staff_invitation", {
    p_email: email,
    p_token_hash: tokenHash,
  });

  if (error) {
    throw new Error(`create_staff_invitation failed: ${error.message}`);
  }

  const row = Array.isArray(data) ? data[0] : data;
  if (!row) {
    throw new Error("[DB fixture] create_staff_invitation returned no row");
  }

  return {
    invitationId: row.invitation_id,
    email: row.email,
    tokenHash,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    reused: row.reused === true,
  };
}

async function acceptInvitationAs(
  client: SupabaseClient,
  tokenHash: string,
  displayName = uniqueName("Staff"),
) {
  return client.rpc("accept_staff_invitation", {
    p_token_hash: tokenHash,
    p_display_name: displayName,
    p_contact_phone: null,
  });
}

describe("Staff Invitations & Acceptance", () => {
  it("SHOP Owner can create Staff invitation; INDEPENDENT Owner cannot", async () => {
    const adminClient = createAdminClient();
    const anonClient = createAnonClient();
    const shopOwner = await createTestUser(
      adminClient,
      uniqueEmail("shop-owner"),
      password,
    );
    const independentOwner = await createTestUser(
      adminClient,
      uniqueEmail("independent-owner"),
      password,
    );
    const shopAuth = await signInTestUser(shopOwner.email, password);
    const independentAuth = await signInTestUser(
      independentOwner.email,
      password,
    );
    const createdProviderIds: string[] = [];

    try {
      const shop = await createProviderAs(shopAuth.client, {
        providerType: "SHOP",
      });
      const independent = await createProviderAs(independentAuth.client, {
        providerType: "INDEPENDENT",
      });
      createdProviderIds.push(shop.providerId, independent.providerId);

      const invite = await createInvitationAs(shopAuth.client);
      expect(invite.createdAt).toEqual(expect.any(String));
      expect(invite.expiresAt).toEqual(expect.any(String));
      expect(Number.isNaN(Date.parse(invite.createdAt))).toBe(false);
      expect(Number.isNaN(Date.parse(invite.expiresAt))).toBe(false);

      const row = assertSupabaseSuccess(
        await adminClient
          .from("provider_invitations")
          .select(
            "provider_id, email, role, token_hash, created_at, expires_at",
          )
          .eq("id", invite.invitationId)
          .single(),
        "read created invitation fixture",
      );
      expect(row.data).toMatchObject({
        provider_id: shop.providerId,
        email: invite.email,
        role: "STAFF",
        token_hash: invite.tokenHash,
        created_at: invite.createdAt,
        expires_at: invite.expiresAt,
      });
      expect(row.data?.token_hash).toMatch(/^[a-f0-9]{64}$/);

      const invitationDetails = assertSupabaseSuccess(
        await anonClient.rpc("get_invitation_details", {
          p_token_hash: invite.tokenHash,
        }),
        "read anonymous invitation projection",
      );
      const invitationDetail = Array.isArray(invitationDetails.data)
        ? invitationDetails.data[0]
        : invitationDetails.data;
      expect(invitationDetail).toMatchObject({
        provider_id: shop.providerId,
        email: invite.email,
      });
      expect(invitationDetail).not.toHaveProperty("contact_email");
      expect(invitationDetail).not.toHaveProperty("contact_phone");

      const deniedTokenHash = hashInvitationToken(
        `inv_${randomUUID()}_${randomUUID()}`,
      );
      const denied = await independentAuth.client.rpc(
        "create_staff_invitation",
        {
          p_email: uniqueEmail("denied-staff"),
          p_token_hash: deniedTokenHash,
        },
      );
      expect(denied.error).not.toBeNull();

      const deniedRows = assertSupabaseSuccess(
        await adminClient
          .from("provider_invitations")
          .select("id")
          .eq("token_hash", deniedTokenHash),
        "read denied invitation fixture",
      );
      expect(deniedRows.data).toEqual([]);
    } finally {
      await cleanupFixture(adminClient, {
        providerIds: createdProviderIds,
        userIds: [shopOwner.user.id, independentOwner.user.id],
      });
    }
  });

  it("Owner cannot direct-update invitation lifecycle fields, while narrow revoke succeeds", async () => {
    const adminClient = createAdminClient();
    const owner = await createTestUser(
      adminClient,
      uniqueEmail("owner"),
      password,
    );
    const auth = await signInTestUser(owner.email, password);
    const createdProviderIds: string[] = [];

    try {
      const provider = await createProviderAs(auth.client);
      createdProviderIds.push(provider.providerId);
      const invite = await createInvitationAs(auth.client);

      const before = assertSupabaseSuccess(
        await adminClient
          .from("provider_invitations")
          .select("*")
          .eq("id", invite.invitationId)
          .single(),
        "read invitation before direct lifecycle update",
      );

      const direct = await auth.client
        .from("provider_invitations")
        .update({
          accepted_at: new Date().toISOString(),
          accepted_by_user_id: owner.user.id,
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          token_hash: hashInvitationToken(`inv_${randomUUID()}`),
          provider_id: provider.providerId,
          revoked_at: new Date().toISOString(),
        })
        .eq("id", invite.invitationId)
        .select("id");
      expect(direct.error).not.toBeNull();

      const afterDirect = assertSupabaseSuccess(
        await adminClient
          .from("provider_invitations")
          .select("*")
          .eq("id", invite.invitationId)
          .single(),
        "read invitation after direct lifecycle denial",
      );
      expect(afterDirect.data).toMatchObject({
        accepted_at: before.data?.accepted_at,
        accepted_by_user_id: before.data?.accepted_by_user_id,
        expires_at: before.data?.expires_at,
        token_hash: before.data?.token_hash,
        provider_id: before.data?.provider_id,
        revoked_at: before.data?.revoked_at,
      });

      const revoked = await auth.client.rpc("revoke_staff_invitation", {
        p_invitation_id: invite.invitationId,
      });
      expect(revoked.error).toBeNull();
      expect(revoked.data).toBe(true);
    } finally {
      await cleanupFixture(adminClient, {
        providerIds: createdProviderIds,
        userIds: [owner.user.id],
      });
    }
  });

  it("reuses the existing active pending invitation for the same Shop and email", async () => {
    const adminClient = createAdminClient();
    const anonClient = createAnonClient();
    const owner = await createTestUser(
      adminClient,
      uniqueEmail("owner"),
      password,
    );
    const auth = await signInTestUser(owner.email, password);
    const createdProviderIds: string[] = [];

    try {
      const provider = await createProviderAs(auth.client);
      createdProviderIds.push(provider.providerId);

      const email = uniqueEmail("reuse");
      const first = await createInvitationAs(auth.client, email);
      const second = await createInvitationAs(auth.client, email);

      expect(first.reused).toBe(false);
      expect(second.reused).toBe(true);
      expect(second.invitationId).toBe(first.invitationId);

      const rows = assertSupabaseSuccess(
        await adminClient
          .from("provider_invitations")
          .select("id, token_hash, accepted_at, revoked_at, expires_at")
          .eq("provider_id", provider.providerId)
          .eq("email", email),
        "read invitation rows under reuse policy",
      );
      expect(rows.data).toHaveLength(1);
      expect(rows.data?.[0]?.token_hash).toBe(first.tokenHash);

      const details = assertSupabaseSuccess(
        await anonClient.rpc("get_invitation_details", {
          p_token_hash: first.tokenHash,
        }),
        "read original invitation projection after reuse",
      );
      const detail = Array.isArray(details.data)
        ? details.data[0]
        : details.data;
      expect(detail).toMatchObject({ email });
    } finally {
      await cleanupFixture(adminClient, {
        providerIds: createdProviderIds,
        userIds: [owner.user.id],
      });
    }
  });

  it("parallel duplicate invites for the same Shop and email yield exactly one active invitation", async () => {
    const adminClient = createAdminClient();
    const owner = await createTestUser(
      adminClient,
      uniqueEmail("owner"),
      password,
    );
    const auth = await signInTestUser(owner.email, password);
    const createdProviderIds: string[] = [];

    try {
      const provider = await createProviderAs(auth.client);
      createdProviderIds.push(provider.providerId);

      const email = uniqueEmail("parallel");
      const [first, second] = await Promise.all([
        createInvitationAs(auth.client, email),
        createInvitationAs(auth.client, email),
      ]);

      expect(first.reused).not.toBe(second.reused);

      const active = assertSupabaseSuccess(
        await adminClient
          .from("provider_invitations")
          .select("id")
          .eq("provider_id", provider.providerId)
          .eq("email", email)
          .is("accepted_at", null)
          .is("revoked_at", null)
          .gt("expires_at", new Date().toISOString()),
        "read active invitation rows after parallel create",
      );
      expect(active.data).toHaveLength(1);
    } finally {
      await cleanupFixture(adminClient, {
        providerIds: createdProviderIds,
        userIds: [owner.user.id],
      });
    }
  });

  it("keeps same-email invitations independent across different Shops", async () => {
    const adminClient = createAdminClient();
    const ownerA = await createTestUser(
      adminClient,
      uniqueEmail("owner-a"),
      password,
    );
    const ownerB = await createTestUser(
      adminClient,
      uniqueEmail("owner-b"),
      password,
    );
    const authA = await signInTestUser(ownerA.email, password);
    const authB = await signInTestUser(ownerB.email, password);
    const createdProviderIds: string[] = [];

    try {
      const providerA = await createProviderAs(authA.client);
      const providerB = await createProviderAs(authB.client);
      createdProviderIds.push(providerA.providerId, providerB.providerId);

      const email = uniqueEmail("cross-shop");
      const inviteA = await createInvitationAs(authA.client, email);
      const inviteB = await createInvitationAs(authB.client, email);

      expect(inviteA.reused).toBe(false);
      expect(inviteB.reused).toBe(false);

      for (const providerId of [providerA.providerId, providerB.providerId]) {
        const active = assertSupabaseSuccess(
          await adminClient
            .from("provider_invitations")
            .select("id")
            .eq("provider_id", providerId)
            .eq("email", email)
            .is("accepted_at", null)
            .is("revoked_at", null)
            .gt("expires_at", new Date().toISOString()),
          "read active invitation per Shop",
        );
        expect(active.data).toHaveLength(1);
      }
    } finally {
      await cleanupFixture(adminClient, {
        providerIds: createdProviderIds,
        userIds: [ownerA.user.id, ownerB.user.id],
      });
    }
  });

  it("allows a fresh invitation once a previous one is expired, revoked, or accepted", async () => {
    const adminClient = createAdminClient();
    const owner = await createTestUser(
      adminClient,
      uniqueEmail("owner"),
      password,
    );
    const staff = await createTestUser(
      adminClient,
      uniqueEmail("staff"),
      password,
    );
    const auth = await signInTestUser(owner.email, password);
    const staffAuth = await signInTestUser(staff.email, password);
    const createdProviderIds: string[] = [];
    const createdUserIds = [owner.user.id, staff.user.id];

    try {
      const provider = await createProviderAs(auth.client);
      createdProviderIds.push(provider.providerId);

      const expired = await createInvitationAs(auth.client);
      assertSupabaseMutation(
        await adminClient
          .from("provider_invitations")
          .update({ expires_at: new Date(Date.now() - 60_000).toISOString() })
          .eq("id", expired.invitationId)
          .select("id"),
        "expire invitation fixture",
      );
      const afterExpired = await createInvitationAs(auth.client, expired.email);
      expect(afterExpired.reused).toBe(false);
      expect(afterExpired.invitationId).not.toBe(expired.invitationId);

      const revoked = await createInvitationAs(auth.client);
      assertSupabaseSuccess(
        await auth.client.rpc("revoke_staff_invitation", {
          p_invitation_id: revoked.invitationId,
        }),
        "revoke invitation fixture",
      );
      const afterRevoked = await createInvitationAs(auth.client, revoked.email);
      expect(afterRevoked.reused).toBe(false);
      expect(afterRevoked.invitationId).not.toBe(revoked.invitationId);

      const accepted = await createInvitationAs(auth.client, staff.email);
      const accept = await acceptInvitationAs(
        staffAuth.client,
        accepted.tokenHash,
      );
      expect(accept.error).toBeNull();

      // An active Staff member is not eligible for a fresh invitation: the
      // create call must refuse instead of minting an unusable invitation.
      const memberReinvite = await auth.client.rpc("create_staff_invitation", {
        p_email: staff.email,
        p_token_hash: hashInvitationToken(
          `inv_${randomUUID()}_${randomUUID()}`,
        ),
      });
      expect(memberReinvite.error).not.toBeNull();
      expect(memberReinvite.error?.code).toBe("P0001");
      expect(memberReinvite.error?.details).toBe("RECIPIENT_INELIGIBLE");

      // After legitimate offboarding the same email becomes eligible again and
      // a new (non-reused) invitation can be created.
      const acceptedRow = Array.isArray(accept.data)
        ? accept.data[0]
        : accept.data;
      assertSupabaseSuccess(
        await auth.client.rpc("remove_staff_member", {
          p_membership_id: acceptedRow.membership_id,
        }),
        "offboard staff after acceptance",
      );
      const afterOffboarding = await createInvitationAs(
        auth.client,
        staff.email,
      );
      expect(afterOffboarding.reused).toBe(false);
      expect(afterOffboarding.invitationId).not.toBe(accepted.invitationId);
    } finally {
      await cleanupFixture(adminClient, {
        providerIds: createdProviderIds,
        userIds: createdUserIds,
      });
    }
  });

  it("invitation acceptance rejects revoked, expired, consumed, wrong-email, and existing-member cases without partial state", async () => {
    const adminClient = createAdminClient();
    const owner = await createTestUser(
      adminClient,
      uniqueEmail("owner"),
      password,
    );
    const staff = await createTestUser(
      adminClient,
      uniqueEmail("staff"),
      password,
    );
    const wrongEmailUser = await createTestUser(
      adminClient,
      uniqueEmail("wrong"),
      password,
    );
    const existingMember = await createTestUser(
      adminClient,
      uniqueEmail("existing"),
      password,
    );
    const ownerAuth = await signInTestUser(owner.email, password);
    const staffAuth = await signInTestUser(staff.email, password);
    const wrongAuth = await signInTestUser(wrongEmailUser.email, password);
    const existingAuth = await signInTestUser(existingMember.email, password);
    const createdProviderIds: string[] = [];
    const createdUserIds = [
      owner.user.id,
      staff.user.id,
      wrongEmailUser.user.id,
      existingMember.user.id,
    ];

    try {
      const provider = await createProviderAs(ownerAuth.client, {
        displayName: uniqueName("Invite Shop"),
      });
      const existingProvider = await createProviderAs(existingAuth.client, {
        displayName: uniqueName("Existing Shop"),
      });
      createdProviderIds.push(provider.providerId, existingProvider.providerId);

      const revoked = await createInvitationAs(ownerAuth.client, staff.email);
      assertSupabaseSuccess(
        await ownerAuth.client.rpc("revoke_staff_invitation", {
          p_invitation_id: revoked.invitationId,
        }),
        "revoke invitation fixture",
      );
      const revokedAccept = await acceptInvitationAs(
        staffAuth.client,
        revoked.tokenHash,
      );
      expect(revokedAccept.error).not.toBeNull();

      const expired = await createInvitationAs(ownerAuth.client, staff.email);
      assertSupabaseMutation(
        await adminClient
          .from("provider_invitations")
          .update({ expires_at: new Date(Date.now() - 60_000).toISOString() })
          .eq("id", expired.invitationId)
          .select("id"),
        "expire invitation fixture",
      );
      const expiredAccept = await acceptInvitationAs(
        staffAuth.client,
        expired.tokenHash,
      );
      expect(expiredAccept.error).not.toBeNull();

      const wrongEmail = await createInvitationAs(
        ownerAuth.client,
        staff.email,
      );
      const wrongEmailAccept = await acceptInvitationAs(
        wrongAuth.client,
        wrongEmail.tokenHash,
      );
      expect(wrongEmailAccept.error).not.toBeNull();

      assertSupabaseSuccess(
        await ownerAuth.client.rpc("revoke_staff_invitation", {
          p_invitation_id: wrongEmail.invitationId,
        }),
        "revoke wrong-email invitation fixture",
      );

      // Creating an invitation for an email that already belongs to an active
      // member is refused outright (the invite would be unusable), and a
      // legacy pending row for such a recipient is still rejected on accept.
      const memberCreate = await ownerAuth.client.rpc(
        "create_staff_invitation",
        {
          p_email: existingMember.email,
          p_token_hash: hashInvitationToken(
            `inv_${randomUUID()}_${randomUUID()}`,
          ),
        },
      );
      expect(memberCreate.error).not.toBeNull();
      expect(memberCreate.error?.code).toBe("P0001");
      expect(memberCreate.error?.details).toBe("RECIPIENT_INELIGIBLE");

      const existingInviteToken = hashInvitationToken(
        `inv_${randomUUID()}_${randomUUID()}`,
      );
      assertSupabaseMutation(
        await adminClient
          .from("provider_invitations")
          .insert({
            provider_id: provider.providerId,
            email: existingMember.email,
            role: "STAFF",
            token_hash: existingInviteToken,
            invited_by_user_id: owner.user.id,
          })
          .select("id"),
        "seed legacy pending invitation for existing member",
      );
      const existingRow = assertSupabaseSuccess(
        await adminClient
          .from("provider_invitations")
          .select("id")
          .eq("token_hash", existingInviteToken)
          .single(),
        "read seeded existing-member invitation",
      );
      const existing = { invitationId: existingRow.data!.id };
      const existingAccept = await acceptInvitationAs(
        existingAuth.client,
        existingInviteToken,
      );
      expect(existingAccept.error).not.toBeNull();
      expect(existingAccept.error?.message).toMatch(
        /active provider membership/,
      );

      const consumed = await createInvitationAs(ownerAuth.client, staff.email);
      const firstAccept = await acceptInvitationAs(
        staffAuth.client,
        consumed.tokenHash,
      );
      expect(firstAccept.error).toBeNull();
      const secondUser = await createTestUser(
        adminClient,
        uniqueEmail("second-staff"),
        password,
      );
      createdUserIds.push(secondUser.user.id);
      const secondAuth = await signInTestUser(secondUser.email, password);
      assertSupabaseMutation(
        await adminClient
          .from("provider_invitations")
          .update({ email: secondUser.email })
          .eq("id", consumed.invitationId)
          .select("id"),
        "change consumed invitation email fixture",
      );
      const secondAccept = await acceptInvitationAs(
        secondAuth.client,
        consumed.tokenHash,
      );
      expect(secondAccept.error).not.toBeNull();

      const rows = assertSupabaseSuccess(
        await adminClient
          .from("provider_memberships")
          .select("id, user_id")
          .eq("provider_id", provider.providerId),
        "read invitation acceptance memberships",
      );
      expect(
        rows.data?.filter((row) => row.user_id === staff.user.id),
      ).toHaveLength(1);
      expect(
        rows.data?.filter((row) => row.user_id === wrongEmailUser.user.id),
      ).toHaveLength(0);
      expect(
        rows.data?.filter((row) => row.user_id === existingMember.user.id),
      ).toHaveLength(0);
      expect(
        rows.data?.filter((row) => row.user_id === secondUser.user.id),
      ).toHaveLength(0);

      const states = assertSupabaseSuccess(
        await adminClient
          .from("provider_invitations")
          .select("id, accepted_at, accepted_by_user_id")
          .in("id", [
            revoked.invitationId,
            expired.invitationId,
            wrongEmail.invitationId,
            existing.invitationId,
          ]),
        "read invitation lifecycle states",
      );
      expect(
        states.data?.every(
          (row) => row.accepted_at === null && row.accepted_by_user_id === null,
        ),
      ).toBe(true);
    } finally {
      await cleanupFixture(adminClient, {
        providerIds: createdProviderIds,
        userIds: createdUserIds,
      });
    }
  });

  it("invitation acceptance succeeds when invite and user emails differ only by case", async () => {
    const adminClient = createAdminClient();
    const owner = await createTestUser(
      adminClient,
      uniqueEmail("owner"),
      password,
    );
    const staff = await createTestUser(
      adminClient,
      uniqueEmail("staff"),
      password,
    );
    const ownerAuth = await signInTestUser(owner.email, password);
    const staffAuth = await signInTestUser(staff.email, password);
    const createdProviderIds: string[] = [];

    try {
      const provider = await createProviderAs(ownerAuth.client);
      createdProviderIds.push(provider.providerId);

      // The invite is stored normalized, so inviting the upper-cased address
      // must still bind to the lower-cased authenticated user email.
      const invite = await createInvitationAs(
        ownerAuth.client,
        staff.email.toUpperCase(),
      );
      expect(invite.email).toBe(staff.email.toLowerCase());

      const accept = await acceptInvitationAs(
        staffAuth.client,
        invite.tokenHash,
      );
      expect(accept.error).toBeNull();
    } finally {
      await cleanupFixture(adminClient, {
        providerIds: createdProviderIds,
        userIds: [owner.user.id, staff.user.id],
      });
    }
  });

  it("rejects a NULL-email authenticated user without creating membership or accepting invitation", async () => {
    const adminClient = createAdminClient();
    const owner = await createTestUser(
      adminClient,
      uniqueEmail("owner"),
      password,
    );
    const ownerAuth = await signInTestUser(owner.email, password);
    const createdProviderIds: string[] = [];
    const createdUserIds: string[] = [owner.user.id];

    try {
      const provider = await createProviderAs(ownerAuth.client, {
        providerType: "SHOP",
      });
      createdProviderIds.push(provider.providerId);

      // Valid SHOP invitation addressed to a normal email.
      const invite = await createInvitationAs(ownerAuth.client);

      // Phone-only Auth user: auth.users.email IS NULL (verified by
      // direct Postgres spike). No session is issued by the Admin API; we
      // mint a short-lived bearer JWT for this UUID via the local stack's
      // JWT_SECRET (exposed by `supabase status -o env`).
      const phoneNumber = `+1${Date.now().toString().slice(-10)}${Math.floor(Math.random() * 90 + 10)}`;
      const phoneResult = await adminClient.auth.admin.createUser({
        phone: phoneNumber.slice(0, 15),
        password,
        phone_confirm: true,
      });
      assertSupabaseSuccess(phoneResult, "create phone-only Auth user");
      const phoneUser = phoneResult.data.user;
      if (!phoneUser) {
        throw new Error("[DB fixture] create phone-only user returned no user");
      }
      createdUserIds.push(phoneUser.id);

      const nullEmailClient = createAuthenticatedClientForUser(phoneUser.id);

      const result = await acceptInvitationAs(
        nullEmailClient,
        invite.tokenHash,
      );

      // Must be denied at the recipient-binding guard.
      expect(result.error).not.toBeNull();
      expect(result.data).toBeNull();
      expect(result.error?.message).toMatch(
        /Authenticated email does not match invitation recipient/,
      );

      // No membership created for the NULL-email user.
      const memberships = assertSupabaseSuccess(
        await adminClient
          .from("provider_memberships")
          .select("id")
          .eq("user_id", phoneUser.id)
          .eq("provider_id", provider.providerId),
        "read NULL-email membership fixture",
      );
      expect(memberships.data).toEqual([]);

      // Invitation remains unaccepted and unsettled.
      const invitation = assertSupabaseSuccess(
        await adminClient
          .from("provider_invitations")
          .select("accepted_at, accepted_by_user_id")
          .eq("id", invite.invitationId)
          .single(),
        "read NULL-email invitation lifecycle fixture",
      );
      expect(invitation.data).toMatchObject({
        accepted_at: null,
        accepted_by_user_id: null,
      });
    } finally {
      await cleanupFixture(adminClient, {
        providerIds: createdProviderIds,
        userIds: createdUserIds,
      });
    }
  });

  it("accepting one invitation supersedes sibling active pending invitations for the same Shop and email", async () => {
    const adminClient = createAdminClient();
    const anonClient = createAnonClient();
    const owner = await createTestUser(
      adminClient,
      uniqueEmail("owner"),
      password,
    );
    const staff = await createTestUser(
      adminClient,
      uniqueEmail("staff"),
      password,
    );
    const ownerAuth = await signInTestUser(owner.email, password);
    const staffAuth = await signInTestUser(staff.email, password);
    const createdProviderIds: string[] = [];

    try {
      const provider = await createProviderAs(ownerAuth.client);
      createdProviderIds.push(provider.providerId);

      // Simulate legacy duplicate state: two active pending invitations for
      // the same Shop + email (direct inserts bypass the create RPC).
      const firstToken = hashInvitationToken(
        `inv_${randomUUID()}_${randomUUID()}`,
      );
      const siblingToken = hashInvitationToken(
        `inv_${randomUUID()}_${randomUUID()}`,
      );
      const seeds = [
        {
          id: randomUUID(),
          provider_id: provider.providerId,
          email: staff.email,
          role: "STAFF",
          token_hash: firstToken,
          invited_by_user_id: owner.user.id,
        },
        {
          id: randomUUID(),
          provider_id: provider.providerId,
          email: staff.email,
          role: "STAFF",
          token_hash: siblingToken,
          invited_by_user_id: owner.user.id,
        },
      ];
      assertSupabaseMutation(
        await adminClient
          .from("provider_invitations")
          .insert(seeds)
          .select("id"),
        "seed sibling pending invitations",
      );

      assertSupabaseSuccess(
        await acceptInvitationAs(staffAuth.client, firstToken),
        "staff accepts first sibling invitation",
      );

      const rows = assertSupabaseSuccess(
        await adminClient
          .from("provider_invitations")
          .select("id, accepted_at, revoked_at")
          .in(
            "id",
            seeds.map((seed) => seed.id),
          ),
        "read invitation states after settlement",
      );
      const byId = new Map(rows.data?.map((row) => [row.id, row]));
      expect(byId.get(seeds[0].id)?.accepted_at).not.toBeNull();
      expect(byId.get(seeds[0].id)?.revoked_at).toBeNull();
      expect(byId.get(seeds[1].id)?.accepted_at).toBeNull();
      expect(byId.get(seeds[1].id)?.revoked_at).not.toBeNull();

      // The superseded sibling link no longer resolves.
      const superseded = await anonClient.rpc("get_invitation_details", {
        p_token_hash: siblingToken,
      });
      expect(superseded.error ?? null).toBeNull();
      expect(Array.isArray(superseded.data) ? superseded.data.length : 0).toBe(
        0,
      );
    } finally {
      await cleanupFixture(adminClient, {
        providerIds: createdProviderIds,
        userIds: [owner.user.id, staff.user.id],
      });
    }
  });

  it("accepting Shop A settles the other Provider's active invitation for the same email", async () => {
    const adminClient = createAdminClient();
    const anonClient = createAnonClient();
    const ownerA = await createTestUser(
      adminClient,
      uniqueEmail("owner-a"),
      password,
    );
    const ownerB = await createTestUser(
      adminClient,
      uniqueEmail("owner-b"),
      password,
    );
    const staff = await createTestUser(
      adminClient,
      uniqueEmail("staff"),
      password,
    );
    const ownerAAuth = await signInTestUser(ownerA.email, password);
    const ownerBAuth = await signInTestUser(ownerB.email, password);
    const staffAuth = await signInTestUser(staff.email, password);
    const createdProviderIds: string[] = [];

    try {
      const providerA = await createProviderAs(ownerAAuth.client);
      const providerB = await createProviderAs(ownerBAuth.client);
      createdProviderIds.push(providerA.providerId, providerB.providerId);

      // The same still-eligible recipient email holds an active invitation at
      // both Shops before membership (cross-Provider independence).
      const inviteA = await createInvitationAs(ownerAAuth.client, staff.email);
      const inviteB = await createInvitationAs(ownerBAuth.client, staff.email);
      expect(inviteA.reused).toBe(false);
      expect(inviteB.reused).toBe(false);
      for (const [providerId, invite] of [
        [providerA.providerId, inviteA],
        [providerB.providerId, inviteB],
      ] as const) {
        const active = assertSupabaseSuccess(
          await adminClient
            .from("provider_invitations")
            .select("id")
            .eq("provider_id", providerId)
            .eq("email", staff.email)
            .is("accepted_at", null)
            .is("revoked_at", null)
            .gt("expires_at", new Date().toISOString()),
          "read active invitation per Shop before membership",
        );
        expect(active.data?.map((row) => row.id)).toContain(
          invite.invitationId,
        );
      }

      // Accept Shop A only.
      assertSupabaseSuccess(
        await acceptInvitationAs(staffAuth.client, inviteA.tokenHash),
        "recipient accepts Shop A invitation",
      );

      // Exactly one membership exists (the global one-membership rule).
      const memberships = assertSupabaseSuccess(
        await adminClient
          .from("provider_memberships")
          .select("id, provider_id")
          .eq("user_id", staff.user.id),
        "read memberships after Shop A acceptance",
      );
      expect(memberships.data).toHaveLength(1);
      expect(memberships.data?.[0]?.provider_id).toBe(providerA.providerId);

      // Shop A invitation accepted; Shop B invitation revoked (membership
      // establishment is a recipient-wide invalidation boundary).
      const rows = assertSupabaseSuccess(
        await adminClient
          .from("provider_invitations")
          .select("id, accepted_at, revoked_at")
          .in("id", [inviteA.invitationId, inviteB.invitationId]),
        "read invitation states after global settlement",
      );
      const byId = new Map(rows.data?.map((row) => [row.id, row]));
      expect(byId.get(inviteA.invitationId)?.accepted_at).not.toBeNull();
      expect(byId.get(inviteA.invitationId)?.revoked_at).toBeNull();
      expect(byId.get(inviteB.invitationId)?.accepted_at).toBeNull();
      expect(byId.get(inviteB.invitationId)?.revoked_at).not.toBeNull();

      // Shop B's link is non-resolving.
      const superseded = await anonClient.rpc("get_invitation_details", {
        p_token_hash: inviteB.tokenHash,
      });
      expect(superseded.error ?? null).toBeNull();
      expect(Array.isArray(superseded.data) ? superseded.data.length : 0).toBe(
        0,
      );

      // No active pending invitation remains for the email across Providers.
      const pending = assertSupabaseSuccess(
        await adminClient
          .from("provider_invitations")
          .select("id")
          .eq("email", staff.email)
          .is("accepted_at", null)
          .is("revoked_at", null)
          .gt("expires_at", new Date().toISOString()),
        "read active pending invitations after global settlement",
      );
      expect(pending.data).toHaveLength(0);
    } finally {
      await cleanupFixture(adminClient, {
        providerIds: createdProviderIds,
        userIds: [ownerA.user.id, ownerB.user.id, staff.user.id],
      });
    }
  });

  it("reconciles legacy duplicate active invitations to a single valid link per Shop and email", async () => {
    const adminClient = createAdminClient();
    const anonClient = createAnonClient();
    const owner = await createTestUser(
      adminClient,
      uniqueEmail("owner"),
      password,
    );
    const controlOwner = await createTestUser(
      adminClient,
      uniqueEmail("control-owner"),
      password,
    );
    const ownerAuth = await signInTestUser(owner.email, password);
    const controlAuth = await signInTestUser(controlOwner.email, password);
    const createdProviderIds: string[] = [];

    try {
      const provider = await createProviderAs(ownerAuth.client, {
        displayName: uniqueName("Legacy Shop"),
      });
      const otherProvider = await createProviderAs(controlAuth.client, {
        displayName: uniqueName("Control Shop"),
      });
      createdProviderIds.push(provider.providerId, otherProvider.providerId);

      const groupEmail = uniqueEmail("legacy-dup");
      const controlEmail = uniqueEmail("legacy-control");

      // Legacy duplicates: three simultaneously valid invitations for one
      // Shop + email (only the earliest must survive), plus a lone control
      // invitation on a different Shop that must be left untouched. created_at
      // is staged explicitly so the kept (earliest) row is deterministic.
      const earliest = new Date(Date.now() - 120_000).toISOString();
      const middle = new Date(Date.now() - 60_000).toISOString();
      const latest = new Date().toISOString();
      const seeds = [
        ...Array.from({ length: 3 }, (_, i) => ({
          id: randomUUID(),
          provider_id: provider.providerId,
          email: groupEmail,
          role: "STAFF",
          token_hash: hashInvitationToken(
            `inv_${randomUUID()}_${randomUUID()}`,
          ),
          invited_by_user_id: owner.user.id,
          created_at: i === 0 ? earliest : i === 1 ? middle : latest,
        })),
        {
          id: randomUUID(),
          provider_id: otherProvider.providerId,
          email: controlEmail,
          role: "STAFF",
          token_hash: hashInvitationToken(
            `inv_${randomUUID()}_${randomUUID()}`,
          ),
          invited_by_user_id: owner.user.id,
          created_at: middle,
        },
      ];
      assertSupabaseMutation(
        await adminClient
          .from("provider_invitations")
          .insert(seeds)
          .select("id"),
        "seed legacy invitation duplicates",
      );

      const keptToken = seeds[0].token_hash;
      const supersededTokens = [seeds[1].token_hash, seeds[2].token_hash];

      const reconcile = assertSupabaseSuccess(
        await adminClient.rpc("reconcile_staff_invitation_duplicates"),
        "run legacy duplicate reconciliation",
      );
      expect(reconcile.data).toBe(2);

      const rows = assertSupabaseSuccess(
        await adminClient
          .from("provider_invitations")
          .select("id, token_hash, accepted_at, revoked_at")
          .in(
            "id",
            seeds.map((seed) => seed.id),
          ),
        "read invitation states after reconciliation",
      );
      const active = rows.data?.filter(
        (row) => row.accepted_at === null && row.revoked_at === null,
      );
      expect(active).toHaveLength(2);
      expect(active?.map((row) => row.token_hash)).toEqual(
        expect.arrayContaining([keptToken, seeds[3].token_hash]),
      );

      // The kept (earliest) link still resolves after reconciliation.
      const kept = assertSupabaseSuccess(
        await anonClient.rpc("get_invitation_details", {
          p_token_hash: keptToken,
        }),
        "resolve the kept invitation link",
      );
      expect(Array.isArray(kept.data) ? kept.data.length : 0).toBeGreaterThan(
        0,
      );

      // Superseded duplicates no longer resolve.
      for (const token of supersededTokens) {
        const details = await anonClient.rpc("get_invitation_details", {
          p_token_hash: token,
        });
        expect(details.error ?? null).toBeNull();
        expect(Array.isArray(details.data) ? details.data.length : 0).toBe(0);
      }
    } finally {
      await cleanupFixture(adminClient, {
        providerIds: createdProviderIds,
        userIds: [owner.user.id, controlOwner.user.id],
      });
    }
  });

  it("reconcile keeps the earliest currently-valid invitation and leaves expired duplicates untouched", async () => {
    const adminClient = createAdminClient();
    const anonClient = createAnonClient();
    const owner = await createTestUser(
      adminClient,
      uniqueEmail("owner"),
      password,
    );
    const controlOwner = await createTestUser(
      adminClient,
      uniqueEmail("control-owner"),
      password,
    );
    const ownerAuth = await signInTestUser(owner.email, password);
    const controlAuth = await signInTestUser(controlOwner.email, password);
    const createdProviderIds: string[] = [];

    try {
      const provider = await createProviderAs(ownerAuth.client, {
        displayName: uniqueName("Expiry Shop"),
      });
      const otherProvider = await createProviderAs(controlAuth.client, {
        displayName: uniqueName("Expiry Control"),
      });
      createdProviderIds.push(provider.providerId, otherProvider.providerId);

      const groupEmail = uniqueEmail("expiry-dup");
      const controlEmail = uniqueEmail("expiry-control");

      const dayMs = 24 * 3600_000;
      const expiredCreatedAt = new Date(Date.now() - 10 * dayMs).toISOString();
      const expiredExpiresAt = new Date(Date.now() - 3 * dayMs).toISOString();
      const earlierCreatedAt = new Date(Date.now() - 2 * dayMs).toISOString();
      const laterCreatedAt = new Date(Date.now() - 1 * dayMs).toISOString();
      const futureExpiresAt = new Date(Date.now() + 5 * dayMs).toISOString();
      const futureExpiresAtLate = new Date(
        Date.now() + 6 * dayMs,
      ).toISOString();

      // One expired duplicate (created early) plus two currently-valid
      // duplicates for the same Shop + email, and a lone control invitation on
      // a different Shop. Reconcile must keep the EARLIEST currently-valid row
      // (not the expired early row), supersede only the later currently-valid
      // duplicate, and leave the expired row and the control untouched.
      const seeds = [
        {
          id: randomUUID(),
          provider_id: provider.providerId,
          email: groupEmail,
          role: "STAFF",
          token_hash: hashInvitationToken(
            `inv_${randomUUID()}_${randomUUID()}`,
          ),
          invited_by_user_id: owner.user.id,
          created_at: expiredCreatedAt,
          expires_at: expiredExpiresAt,
        },
        {
          id: randomUUID(),
          provider_id: provider.providerId,
          email: groupEmail,
          role: "STAFF",
          token_hash: hashInvitationToken(
            `inv_${randomUUID()}_${randomUUID()}`,
          ),
          invited_by_user_id: owner.user.id,
          created_at: earlierCreatedAt,
          expires_at: futureExpiresAt,
        },
        {
          id: randomUUID(),
          provider_id: provider.providerId,
          email: groupEmail,
          role: "STAFF",
          token_hash: hashInvitationToken(
            `inv_${randomUUID()}_${randomUUID()}`,
          ),
          invited_by_user_id: owner.user.id,
          created_at: laterCreatedAt,
          expires_at: futureExpiresAtLate,
        },
        {
          id: randomUUID(),
          provider_id: otherProvider.providerId,
          email: controlEmail,
          role: "STAFF",
          token_hash: hashInvitationToken(
            `inv_${randomUUID()}_${randomUUID()}`,
          ),
          invited_by_user_id: owner.user.id,
          created_at: earlierCreatedAt,
          expires_at: futureExpiresAt,
        },
      ];
      assertSupabaseMutation(
        await adminClient
          .from("provider_invitations")
          .insert(seeds)
          .select("id"),
        "seed mixed-expiry invitation duplicates",
      );

      const keptToken = seeds[1].token_hash;
      const supersededToken = seeds[2].token_hash;

      const reconcile = assertSupabaseSuccess(
        await adminClient.rpc("reconcile_staff_invitation_duplicates"),
        "run mixed-expiry legacy reconciliation",
      );
      expect(reconcile.data).toBe(1);

      const rows = assertSupabaseSuccess(
        await adminClient
          .from("provider_invitations")
          .select("id, token_hash, accepted_at, revoked_at")
          .in(
            "id",
            seeds.map((seed) => seed.id),
          ),
        "read invitation states after mixed-expiry reconciliation",
      );
      const byToken = new Map(rows.data?.map((row) => [row.token_hash, row]));

      // The earliest currently-valid invitation survives.
      expect(byToken.get(keptToken)?.accepted_at).toBeNull();
      expect(byToken.get(keptToken)?.revoked_at).toBeNull();
      // The later currently-valid duplicate is superseded.
      expect(byToken.get(supersededToken)?.revoked_at).not.toBeNull();
      // The expired duplicate is left untouched (it never resolves anyway).
      expect(byToken.get(seeds[0].token_hash)?.accepted_at).toBeNull();
      expect(byToken.get(seeds[0].token_hash)?.revoked_at).toBeNull();
      // The control invitation is untouched.
      expect(byToken.get(seeds[3].token_hash)?.revoked_at).toBeNull();

      // The survived link resolves.
      const kept = assertSupabaseSuccess(
        await anonClient.rpc("get_invitation_details", {
          p_token_hash: keptToken,
        }),
        "resolve the kept currently-valid invitation link",
      );
      expect(Array.isArray(kept.data) ? kept.data.length : 0).toBeGreaterThan(
        0,
      );

      // The superseded duplicate and the expired (untouched) link do not.
      for (const token of [supersededToken, seeds[0].token_hash]) {
        const details = await anonClient.rpc("get_invitation_details", {
          p_token_hash: token,
        });
        expect(details.error ?? null).toBeNull();
        expect(Array.isArray(details.data) ? details.data.length : 0).toBe(0);
      }
    } finally {
      await cleanupFixture(adminClient, {
        providerIds: createdProviderIds,
        userIds: [owner.user.id, controlOwner.user.id],
      });
    }
  });

  it("create vs register-and-accept race leaves exactly one membership and no unusable active invitation", async () => {
    const adminClient = createAdminClient();
    const owner = await createTestUser(
      adminClient,
      uniqueEmail("owner"),
      password,
    );
    const ownerAuth = await signInTestUser(owner.email, password);
    const createdProviderIds: string[] = [];
    const createdUserIds = [owner.user.id];

    try {
      const provider = await createProviderAs(ownerAuth.client, {
        displayName: uniqueName("Race Shop"),
      });
      createdProviderIds.push(provider.providerId);

      // Each iteration starts from an eligible recipient (no membership): a
      // seeded active invitation already exists for the Shop+email, then an
      // Owner create races the recipient's own account registration + accept
      // of that same email (the "Auth User appears mid-create" scenario).
      // Whichever order commits inside the shared recipient-email lock, the
      // invariant must hold: exactly one membership AND zero active pending
      // invitations left for the Shop+email.
      const iterations = 6;
      for (let i = 0; i < iterations; i += 1) {
        const recipientEmail = uniqueEmail(`race-r${i}`);
        const seed = await createInvitationAs(ownerAuth.client, recipientEmail);

        const [createResult, account] = await Promise.all([
          ownerAuth.client.rpc("create_staff_invitation", {
            p_email: recipientEmail,
            p_token_hash: hashInvitationToken(
              `inv_${randomUUID()}_${randomUUID()}`,
            ),
          }),
          (async () => {
            const registered = await createTestUser(
              adminClient,
              recipientEmail,
              password,
            );
            createdUserIds.push(registered.user.id);
            const signedIn = await signInTestUser(recipientEmail, password);
            const accept = await acceptInvitationAs(
              signedIn.client,
              seed.tokenHash,
            );
            expect(accept.error).toBeNull();
            return registered;
          })(),
        ]);

        // create either reused the seeded invitation, minted a fresh one (the
        // acceptance settlement then supersedes it), or was refused because the
        // recipient had already become a member. Its own error is acceptable;
        // the resulting state is what has to be proven.
        const createRow = Array.isArray(createResult.data)
          ? createResult.data[0]
          : createResult.data;
        if (createResult.error === null && createRow) {
          if (createRow.reused === true) {
            expect(createRow.invitation_id).toBe(seed.invitationId);
          } else {
            const fresh = assertSupabaseSuccess(
              await adminClient
                .from("provider_invitations")
                .select("accepted_at, revoked_at")
                .eq("id", createRow.invitation_id)
                .single(),
              "read freshly created race invitation state",
            );
            expect(fresh.data?.revoked_at).not.toBeNull();
          }
        }

        const memberships = assertSupabaseSuccess(
          await adminClient
            .from("provider_memberships")
            .select("id")
            .eq("user_id", account.user.id),
          "read race membership count",
        );
        expect(memberships.data).toHaveLength(1);

        const pending = assertSupabaseSuccess(
          await adminClient
            .from("provider_invitations")
            .select("id")
            .eq("provider_id", provider.providerId)
            .eq("email", recipientEmail)
            .is("accepted_at", null)
            .is("revoked_at", null)
            .gt("expires_at", new Date().toISOString()),
          "read active pending invitations after race iteration",
        );
        expect(pending.data).toHaveLength(0);
      }
    } finally {
      await cleanupFixture(adminClient, {
        providerIds: createdProviderIds,
        userIds: createdUserIds,
      });
    }
  });

  it("cross-Shop create vs accept race leaves exactly one membership and no unusable active invitation", async () => {
    const adminClient = createAdminClient();
    const ownerA = await createTestUser(
      adminClient,
      uniqueEmail("owner-a"),
      password,
    );
    const ownerB = await createTestUser(
      adminClient,
      uniqueEmail("owner-b"),
      password,
    );
    const ownerAAuth = await signInTestUser(ownerA.email, password);
    const ownerBAuth = await signInTestUser(ownerB.email, password);
    const createdProviderIds: string[] = [];
    const createdUserIds = [ownerA.user.id, ownerB.user.id];

    try {
      const providerA = await createProviderAs(ownerAAuth.client);
      const providerB = await createProviderAs(ownerBAuth.client);
      createdProviderIds.push(providerA.providerId, providerB.providerId);

      // Each iteration seeds a Shop A invitation for a fresh eligible
      // recipient, then races a Shop B create for the same email against the
      // recipient's account registration + acceptance of the Shop A invite.
      // Whichever side wins the shared recipient-email lock, the durable state
      // must be exactly one membership AND zero active pending invitations for
      // the email across both Shops.
      const iterations = 6;
      for (let i = 0; i < iterations; i += 1) {
        const recipientEmail = uniqueEmail(`cross-shop-r${i}`);
        const seed = await createInvitationAs(
          ownerAAuth.client,
          recipientEmail,
        );

        const [createResult, registered] = await Promise.all([
          ownerBAuth.client.rpc("create_staff_invitation", {
            p_email: recipientEmail,
            p_token_hash: hashInvitationToken(
              `inv_${randomUUID()}_${randomUUID()}`,
            ),
          }),
          (async () => {
            const account = await createTestUser(
              adminClient,
              recipientEmail,
              password,
            );
            createdUserIds.push(account.user.id);
            const signedIn = await signInTestUser(recipientEmail, password);
            const accept = await acceptInvitationAs(
              signedIn.client,
              seed.tokenHash,
            );
            expect(accept.error).toBeNull();
            return account;
          })(),
        ]);

        // If the Shop B create won the lock before Shop A acceptance, it
        // minted a fresh Shop B invitation that the global settlement must
        // revoke once the membership exists. If it lost, its eligibility
        // recheck refused it. Its own error is acceptable; the resulting
        // state is what has to be proven.
        const createRow = Array.isArray(createResult.data)
          ? createResult.data[0]
          : createResult.data;
        if (createResult.error === null && createRow) {
          const outcome = assertSupabaseSuccess(
            await adminClient
              .from("provider_invitations")
              .select("accepted_at, revoked_at")
              .eq("id", createRow.invitation_id)
              .single(),
            "read cross-shop race invitation state",
          );
          expect(outcome.data?.accepted_at).toBeNull();
          expect(outcome.data?.revoked_at).not.toBeNull();
        }

        const memberships = assertSupabaseSuccess(
          await adminClient
            .from("provider_memberships")
            .select("id")
            .eq("user_id", registered.user.id),
          "read cross-shop race membership count",
        );
        expect(memberships.data).toHaveLength(1);

        const pending = assertSupabaseSuccess(
          await adminClient
            .from("provider_invitations")
            .select("id")
            .eq("email", recipientEmail)
            .is("accepted_at", null)
            .is("revoked_at", null)
            .gt("expires_at", new Date().toISOString()),
          "read active pending invitations after cross-shop race iteration",
        );
        expect(pending.data).toHaveLength(0);
      }
    } finally {
      await cleanupFixture(adminClient, {
        providerIds: createdProviderIds,
        userIds: createdUserIds,
      });
    }
  });

  it("Owner onboarding racing a Staff-invite create leaves exactly one membership and no unusable active invitation", async () => {
    const adminClient = createAdminClient();
    const owner = await createTestUser(
      adminClient,
      uniqueEmail("owner"),
      password,
    );
    const ownerAuth = await signInTestUser(owner.email, password);
    const createdProviderIds: string[] = [];
    const createdUserIds = [owner.user.id];

    try {
      const provider = await createProviderAs(ownerAuth.client, {
        displayName: uniqueName("Onboard Shop"),
      });
      createdProviderIds.push(provider.providerId);

      // Each iteration starts from an eligible recipient (no membership): a
      // Staff-invite create races the recipient's own account registration +
      // Provider onboarding for that same email (the "Auth User appears
      // mid-create" scenario). Whichever order commits inside the shared
      // recipient-email lock, the invariant must hold: exactly one membership
      // AND zero active pending invitations left for the recipient email.
      const iterations = 6;
      for (let i = 0; i < iterations; i += 1) {
        const recipientEmail = uniqueEmail(`onboard-race-r${i}`);

        const [createResult, registered] = await Promise.all([
          ownerAuth.client.rpc("create_staff_invitation", {
            p_email: recipientEmail,
            p_token_hash: hashInvitationToken(
              `inv_${randomUUID()}_${randomUUID()}`,
            ),
          }),
          (async () => {
            const account = await createTestUser(
              adminClient,
              recipientEmail,
              password,
            );
            createdUserIds.push(account.user.id);
            const signedIn = await signInTestUser(recipientEmail, password);
            const onboarded = await createProviderAs(signedIn.client, {
              displayName: uniqueName("Onboard"),
            });
            createdProviderIds.push(onboarded.providerId);
            return account;
          })(),
        ]);

        // create either minted a fresh invitation before onboarding committed
        // (onboarding's settlement must then supersede it) or was refused on
        // its eligibility recheck because onboarding had already established a
        // membership. Its own error is acceptable; the resulting state is what
        // has to be proven.
        const createRow = Array.isArray(createResult.data)
          ? createResult.data[0]
          : createResult.data;
        if (createResult.error === null && createRow) {
          const outcome = assertSupabaseSuccess(
            await adminClient
              .from("provider_invitations")
              .select("accepted_at, revoked_at")
              .eq("id", createRow.invitation_id)
              .single(),
            "read onboarding-race invitation state",
          );
          expect(outcome.data?.accepted_at).toBeNull();
          expect(outcome.data?.revoked_at).not.toBeNull();
        }

        const memberships = assertSupabaseSuccess(
          await adminClient
            .from("provider_memberships")
            .select("id")
            .eq("user_id", registered.user.id),
          "read onboarding-race membership count",
        );
        expect(memberships.data).toHaveLength(1);

        const pending = assertSupabaseSuccess(
          await adminClient
            .from("provider_invitations")
            .select("id")
            .eq("email", recipientEmail)
            .is("accepted_at", null)
            .is("revoked_at", null)
            .gt("expires_at", new Date().toISOString()),
          "read active pending invitations after onboarding-race iteration",
        );
        expect(pending.data).toHaveLength(0);
      }
    } finally {
      await cleanupFixture(adminClient, {
        providerIds: createdProviderIds,
        userIds: createdUserIds,
      });
    }
  });

  it("two concurrent Staff invite accepts for one User create exactly one membership and consume one invitation", async () => {
    const adminClient = createAdminClient();
    const ownerA = await createTestUser(
      adminClient,
      uniqueEmail("owner-a"),
      password,
    );
    const ownerB = await createTestUser(
      adminClient,
      uniqueEmail("owner-b"),
      password,
    );
    const staff = await createTestUser(
      adminClient,
      uniqueEmail("race-staff"),
      password,
    );
    const ownerAAuth = await signInTestUser(ownerA.email, password);
    const ownerBAuth = await signInTestUser(ownerB.email, password);
    const staffAuth = await signInTestUser(staff.email, password);
    const createdProviderIds: string[] = [];

    try {
      const providerA = await createProviderAs(ownerAAuth.client, {
        displayName: uniqueName("Race A"),
      });
      const providerB = await createProviderAs(ownerBAuth.client, {
        displayName: uniqueName("Race B"),
      });
      createdProviderIds.push(providerA.providerId, providerB.providerId);
      const inviteA = await createInvitationAs(ownerAAuth.client, staff.email);
      const inviteB = await createInvitationAs(ownerBAuth.client, staff.email);

      const results = await Promise.allSettled([
        acceptInvitationAs(staffAuth.client, inviteA.tokenHash),
        acceptInvitationAs(staffAuth.client, inviteB.tokenHash),
      ]);
      const fulfilled = results.filter(
        (result) => result.status === "fulfilled" && !result.value.error,
      );
      const rejected = results.filter(
        (result) =>
          result.status === "rejected" ||
          (result.status === "fulfilled" && result.value.error),
      );
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      const memberships = assertSupabaseSuccess(
        await adminClient
          .from("provider_memberships")
          .select("id")
          .eq("user_id", staff.user.id),
        "read concurrent acceptance memberships",
      );
      expect(memberships.data).toHaveLength(1);

      const invitations = assertSupabaseSuccess(
        await adminClient
          .from("provider_invitations")
          .select("id, accepted_at")
          .in("id", [inviteA.invitationId, inviteB.invitationId]),
        "read concurrent acceptance invitations",
      );
      expect(
        invitations.data?.filter((row) => row.accepted_at !== null),
      ).toHaveLength(1);
      expect(
        invitations.data?.filter((row) => row.accepted_at === null),
      ).toHaveLength(1);
    } finally {
      await cleanupFixture(adminClient, {
        providerIds: createdProviderIds,
        userIds: [ownerA.user.id, ownerB.user.id, staff.user.id],
      });
    }
  });

  it("Provider-create vs Staff-accept race creates exactly one membership and no orphan losing state", async () => {
    const adminClient = createAdminClient();
    const owner = await createTestUser(
      adminClient,
      uniqueEmail("owner"),
      password,
    );
    const candidate = await createTestUser(
      adminClient,
      uniqueEmail("candidate"),
      password,
    );
    const ownerAuth = await signInTestUser(owner.email, password);
    const candidateAuth = await signInTestUser(candidate.email, password);
    const createdProviderIds: string[] = [];
    const candidateProviderName = uniqueName("Candidate Provider");

    try {
      const shop = await createProviderAs(ownerAuth.client, {
        displayName: uniqueName("Race Invite Shop"),
      });
      createdProviderIds.push(shop.providerId);
      const invite = await createInvitationAs(
        ownerAuth.client,
        candidate.email,
      );

      const results = await Promise.allSettled([
        createProviderAs(candidateAuth.client, {
          displayName: candidateProviderName,
          providerType: "INDEPENDENT",
          ownerDisplayName: uniqueName("Candidate Owner"),
        }),
        acceptInvitationAs(candidateAuth.client, invite.tokenHash),
      ]);
      const successes = results.filter(
        (result) =>
          result.status === "fulfilled" &&
          !("error" in result.value && result.value.error),
      );
      const failures = results.filter(
        (result) =>
          result.status === "rejected" ||
          (result.status === "fulfilled" &&
            "error" in result.value &&
            result.value.error),
      );
      expect(successes).toHaveLength(1);
      expect(failures).toHaveLength(1);

      const memberships = assertSupabaseSuccess(
        await adminClient
          .from("provider_memberships")
          .select("provider_id")
          .eq("user_id", candidate.user.id),
        "read race outcome membership",
      );
      expect(memberships.data).toHaveLength(1);

      const candidateProviders = assertSupabaseSuccess(
        await adminClient
          .from("providers")
          .select("id")
          .eq("display_name", candidateProviderName),
        "read race outcome Provider",
      );
      if (
        memberships.data?.[0]?.provider_id !== candidateProviders.data?.[0]?.id
      ) {
        expect(candidateProviders.data).toEqual([]);
      }

      const invitation = assertSupabaseSuccess(
        await adminClient
          .from("provider_invitations")
          .select("accepted_at")
          .eq("id", invite.invitationId)
          .single(),
        "read race outcome invitation",
      );
      const membershipProviderId = memberships.data?.[0]?.provider_id;
      if (membershipProviderId === shop.providerId) {
        expect(invitation.data?.accepted_at).not.toBeNull();
      } else {
        expect(invitation.data?.accepted_at).toBeNull();
        if (membershipProviderId) {
          createdProviderIds.push(membershipProviderId);
        }
      }
    } finally {
      await cleanupFixture(adminClient, {
        providerIds: createdProviderIds,
        userIds: [owner.user.id, candidate.user.id],
      });
    }
  });

  it("Provider onboarding failures leave no Provider, profile, or OWNER membership", async () => {
    const adminClient = createAdminClient();
    const user = await createTestUser(
      adminClient,
      uniqueEmail("atomic-owner"),
      password,
    );
    const auth = await signInTestUser(user.email, password);
    const displayName = uniqueName("Atomic Failure Provider");

    try {
      const failed = await auth.client.rpc("create_provider_with_owner", {
        p_display_name: displayName,
        p_provider_type: null,
        p_owner_display_name: uniqueName("Atomic Owner"),
        p_owner_contact_phone: null,
        p_contact_email: null,
        p_contact_phone: null,
        p_public_address: null,
        p_service_area: null,
        p_supported_devices: [],
      });
      expect(failed.error).not.toBeNull();

      const providers = assertSupabaseSuccess(
        await adminClient
          .from("providers")
          .select("id")
          .eq("display_name", displayName),
        "read failed onboarding Provider fixture",
      );
      const profiles = assertSupabaseSuccess(
        await adminClient
          .from("provider_user_profiles")
          .select("user_id")
          .eq("user_id", user.user.id),
        "read failed onboarding profile fixture",
      );
      const memberships = assertSupabaseSuccess(
        await adminClient
          .from("provider_memberships")
          .select("id")
          .eq("user_id", user.user.id),
        "read failed onboarding membership fixture",
      );
      expect(providers.data).toEqual([]);
      expect(profiles.data).toEqual([]);
      expect(memberships.data).toEqual([]);
    } finally {
      await cleanupFixture(adminClient, { userIds: [user.user.id] });
    }
  });

  it("Staff acceptance failure leaves no Staff membership, profile mutation, or consumed invitation", async () => {
    const adminClient = createAdminClient();
    const owner = await createTestUser(
      adminClient,
      uniqueEmail("owner"),
      password,
    );
    const staff = await createTestUser(
      adminClient,
      uniqueEmail("atomic-staff"),
      password,
    );
    const ownerAuth = await signInTestUser(owner.email, password);
    const staffAuth = await signInTestUser(staff.email, password);
    const createdProviderIds: string[] = [];

    try {
      const shop = await createProviderAs(ownerAuth.client, {
        providerType: "SHOP",
      });
      createdProviderIds.push(shop.providerId);
      const invite = await createInvitationAs(ownerAuth.client, staff.email);
      assertSupabaseMutation(
        await adminClient
          .from("providers")
          .update({ provider_type: "INDEPENDENT" })
          .eq("id", shop.providerId)
          .select("id"),
        "change Provider type fixture",
      );

      const failed = await acceptInvitationAs(
        staffAuth.client,
        invite.tokenHash,
      );
      expect(failed.error).not.toBeNull();

      const memberships = assertSupabaseSuccess(
        await adminClient
          .from("provider_memberships")
          .select("id")
          .eq("user_id", staff.user.id),
        "read failed acceptance membership fixture",
      );
      const profiles = assertSupabaseSuccess(
        await adminClient
          .from("provider_user_profiles")
          .select("user_id")
          .eq("user_id", staff.user.id),
        "read failed acceptance profile fixture",
      );
      const invitation = assertSupabaseSuccess(
        await adminClient
          .from("provider_invitations")
          .select("accepted_at, accepted_by_user_id")
          .eq("id", invite.invitationId)
          .single(),
        "read failed acceptance invitation fixture",
      );
      expect(memberships.data).toEqual([]);
      expect(profiles.data).toEqual([]);
      expect(invitation.data).toMatchObject({
        accepted_at: null,
        accepted_by_user_id: null,
      });
    } finally {
      await cleanupFixture(adminClient, {
        providerIds: createdProviderIds,
        userIds: [owner.user.id, staff.user.id],
      });
    }
  });
});

describe("OWNER-controlled Staff offboarding (Plan 03)", () => {
  it("removes exactly one same-Provider STAFF membership and revokes access", async () => {
    const adminClient = createAdminClient();
    const owner = await createTestUser(adminClient);
    const staff = await createTestUser(adminClient);

    const ownerSignIn = await signInTestUser(owner.email!, password);
    const provider = await createProviderAs(ownerSignIn.client);

    try {
      const invitation = await createInvitationAs(
        ownerSignIn.client,
        staff.email!,
      );
      const staffSignIn = await signInTestUser(staff.email!, password);
      const accepted = assertSupabaseSuccess(
        await acceptInvitationAs(staffSignIn.client, invitation.tokenHash),
        "staff accepts invitation",
      );
      const staffMembershipId = (
        Array.isArray(accepted.data) ? accepted.data[0] : accepted.data
      ).membership_id;

      // Staff can read Provider-private rows while active.
      const beforeRemoval = assertSupabaseSuccess(
        await staffSignIn.client
          .from("provider_memberships")
          .select("id")
          .eq("provider_id", provider.providerId),
        "active Staff reads Provider memberships",
      );
      expect(beforeRemoval.data!.length).toBe(2);

      // A STAFF caller cannot perform offboarding.
      const staffAttempt = await staffSignIn.client.rpc("remove_staff_member", {
        p_membership_id: staffMembershipId,
      });
      expect(staffAttempt.error).toMatchObject({
        message: /Only Provider Owners/,
      });

      // Active Staff can mutate Provider Repairs.
      assertSupabaseSuccess(
        await ownerSignIn.client.rpc("set_provider_service_modes", {
          p_service_modes: [{ mode: "DROP_OFF" }],
        }),
        "configure offboarding Service Modes",
      );
      assertSupabaseSuccess(
        await staffSignIn.client.rpc(
          "create_provider_repair",
          directRepairInput({ p_customer_name: "Offboard Staff Customer" }),
        ),
        "active Staff creates a direct Repair",
      );

      const removal = assertSupabaseSuccess(
        await ownerSignIn.client.rpc("remove_staff_member", {
          p_membership_id: staffMembershipId,
        }),
        "Owner removes Staff",
      );
      const removalRow = Array.isArray(removal.data)
        ? removal.data[0]
        : removal.data;
      expect(removalRow).toBe(true);

      // The membership row is durably gone.
      const afterRemoval = assertSupabaseSuccess(
        await adminClient
          .from("provider_memberships")
          .select("id, role")
          .eq("provider_id", provider.providerId),
        "read memberships after removal",
      );
      expect(afterRemoval.data).toEqual([
        { id: expect.any(String), role: "OWNER" },
      ]);

      // Removed Staff immediately loses ProviderContext-backed access.
      const deniedRead = await staffSignIn.client
        .from("providers")
        .select("id")
        .eq("id", provider.providerId);
      expect(deniedRead.data).toEqual([]);

      // The same Repair mutation active Staff could perform is now denied.
      const deniedRepairMutation = await staffSignIn.client.rpc(
        "create_provider_repair",
        directRepairInput({ p_customer_name: "Removed Staff Customer" }),
      );
      expect(deniedRepairMutation.error).toMatchObject({
        message: /PROVIDER_CONTEXT_REQUIRED/,
      });

      // Removing an OWNER through this operation is refused.
      const ownerSelfAttempt = await ownerSignIn.client.rpc(
        "remove_staff_member",
        { p_membership_id: provider.membershipId },
      );
      assertSupabaseSuccess(ownerSelfAttempt, "attempt to remove OWNER");
      const ownerRow = Array.isArray(ownerSelfAttempt.data)
        ? ownerSelfAttempt.data[0]
        : ownerSelfAttempt.data;
      expect(ownerRow).toBe(false);
    } finally {
      await cleanupFixture(adminClient, {
        providerIds: [provider.providerId],
        userIds: [owner.user.id, staff.user.id],
      });
    }
  });

  it("denies cross-Provider removal without revealing membership existence", async () => {
    const adminClient = createAdminClient();
    const ownerA = await createTestUser(adminClient);
    const ownerB = await createTestUser(adminClient);
    const staff = await createTestUser(adminClient);

    try {
      const signInA = await signInTestUser(ownerA.email!, password);
      const signInB = await signInTestUser(ownerB.email!, password);
      await createProviderAs(signInA.client);
      await createProviderAs(signInB.client);

      const invitation = await createInvitationAs(signInA.client, staff.email!);
      const staffSignIn = await signInTestUser(staff.email!, password);
      const accepted = assertSupabaseSuccess(
        await acceptInvitationAs(staffSignIn.client, invitation.tokenHash),
        "staff accepts invitation",
      );
      const staffMembershipId = (
        Array.isArray(accepted.data) ? accepted.data[0] : accepted.data
      ).membership_id;

      const crossTenantAttempt = assertSupabaseSuccess(
        await signInB.client.rpc("remove_staff_member", {
          p_membership_id: staffMembershipId,
        }),
        "cross-Provider Owner attempts removal",
      );
      const crossRow = Array.isArray(crossTenantAttempt.data)
        ? crossTenantAttempt.data[0]
        : crossTenantAttempt.data;
      expect(crossRow).toBe(false);

      // The targeted membership still exists.
      const stillPresent = assertSupabaseSuccess(
        await adminClient
          .from("provider_memberships")
          .select("id")
          .eq("id", staffMembershipId),
        "verify cross-Provider membership survived",
      );
      expect(stillPresent.data).toHaveLength(1);
    } finally {
      await cleanupFixture(adminClient, {
        userIds: [ownerA.user.id, ownerB.user.id, staff.user.id],
      });
    }
  });
});
