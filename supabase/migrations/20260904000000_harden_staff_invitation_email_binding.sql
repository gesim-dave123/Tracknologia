-- Migration: 20260904000000_harden_staff_invitation_email_binding.sql
-- Description: Harden Staff invitation email binding (issue #46 bug burn).
--
-- Forward-only replacement of accept_staff_invitation. Function body,
-- locking protocol, and permissions remain unchanged except the recipient
-- email binding check: an authenticated user whose auth email is missing
-- (NULL) or does not match the invitation recipient (case-insensitive) is
-- now rejected. Previously a NULL auth email skipped the check entirely
-- (fail-open); a missing email can never satisfy the binding, so it is
-- rejected rather than treated as "no check".
CREATE OR REPLACE FUNCTION public.accept_staff_invitation(
  p_token_hash TEXT,
  p_display_name TEXT,
  p_contact_phone TEXT DEFAULT NULL
)
RETURNS TABLE (
  provider_id UUID,
  membership_id UUID,
  role public.membership_role
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_user_id UUID;
  v_invitation_id UUID;
  v_provider_id UUID;
  v_membership_id UUID;
  v_invite_role public.membership_role;
  v_invite_email TEXT;
  v_provider_type public.provider_type;
  v_staff_name TEXT;
  v_user_email TEXT;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF p_display_name IS NULL OR trim(p_display_name) = '' THEN
    RAISE EXCEPTION 'Staff display name cannot be blank';
  END IF;
  v_staff_name := NULLIF(trim(p_display_name), '');

  -- Light-read the invitation (token_hash is UNIQUE) to learn the recipient
  -- email that must be serialized before eligibility can be decided; an
  -- invalid, expired, or revoked token is rejected before any lock is taken.
  SELECT pi.email
  INTO v_invite_email
  FROM public.provider_invitations pi
  WHERE pi.token_hash = p_token_hash
    AND pi.accepted_at IS NULL
    AND pi.revoked_at IS NULL
    AND pi.expires_at > now()
  LIMIT 1;

  IF v_invite_email IS NULL THEN
    RAISE EXCEPTION 'Invalid, expired, or revoked invitation';
  END IF;

  -- Phase 3: Transactionally serialize all membership-establishing operations.
  -- The recipient-email lock is shared with create_staff_invitation, followed
  -- by the per-User lock. Order is consistent with create (never the provider
  -- lock), so no deadlock cycle exists.
  PERFORM pg_advisory_xact_lock(hashtext('staff-invitation-email:' || lower(trim(v_invite_email))));
  PERFORM pg_advisory_xact_lock(hashtext(v_user_id::text));

  -- Invariant: User cannot already have ANY active provider membership
  IF EXISTS (SELECT 1 FROM public.provider_memberships pm WHERE pm.user_id = v_user_id) THEN
    RAISE EXCEPTION 'User already has an active provider membership';
  END IF;

  -- Look up valid, active, non-expired, unconsumed invitation with row lock
  SELECT pi.id, pi.provider_id, pi.role, pi.email, p.provider_type
  INTO v_invitation_id, v_provider_id, v_invite_role, v_invite_email, v_provider_type
  FROM public.provider_invitations pi
  JOIN public.providers p ON p.id = pi.provider_id
  WHERE pi.token_hash = p_token_hash
    AND pi.accepted_at IS NULL
    AND pi.revoked_at IS NULL
    AND pi.expires_at > now()
  FOR UPDATE OF pi;

  IF v_invitation_id IS NULL THEN
    RAISE EXCEPTION 'Invalid, expired, or revoked invitation';
  END IF;

  -- Invariant: Staff invitations are valid ONLY for SHOP providers
  IF v_provider_type <> 'SHOP' THEN
    RAISE EXCEPTION 'Staff invitations are only valid for Repair Shops';
  END IF;

  SELECT u.email INTO v_user_email FROM auth.users u WHERE u.id = v_user_id;

  -- Email binding: the authenticated user's email must match the invitation
  -- recipient (case-insensitive). A missing user email can never satisfy the
  -- binding, so it is rejected rather than skipping the check.
  IF v_user_email IS NULL OR lower(trim(v_user_email)) <> lower(trim(v_invite_email)) THEN
    RAISE EXCEPTION 'Authenticated email does not match invitation recipient';
  END IF;

  -- 1. Atomically upsert person profile in provider_user_profiles
  INSERT INTO public.provider_user_profiles (
    user_id,
    display_name,
    contact_phone
  ) VALUES (
    v_user_id,
    v_staff_name,
    NULLIF(trim(p_contact_phone), '')
  )
  ON CONFLICT (user_id) DO UPDATE
  SET display_name = EXCLUDED.display_name,
      contact_phone = COALESCE(EXCLUDED.contact_phone, public.provider_user_profiles.contact_phone),
      updated_at = now();

  -- 2. Atomically insert STAFF membership (authorization link only)
  INSERT INTO public.provider_memberships (
    provider_id,
    user_id,
    role
  ) VALUES (
    v_provider_id,
    v_user_id,
    v_invite_role
  ) RETURNING public.provider_memberships.id INTO v_membership_id;

  -- 3. Mark invitation as accepted atomically
  UPDATE public.provider_invitations
  SET accepted_at = now(),
      accepted_by_user_id = v_user_id
  WHERE id = v_invitation_id;

  -- 4. Settlement: the one-membership-per-User rule is global, so once this
  -- recipient holds an active membership no other currently-active pending
  -- Staff invitation may remain for the normalized email at ANY Provider.
  -- Same-email invitations from other Shops were valid while the recipient was
  -- eligible, but accepting any one of them is now impossible; supersede every
  -- remaining active pending invitation so the links stop resolving. (The
  -- membership was established while holding the recipient-email advisory lock
  -- shared with create_staff_invitation, so a concurrent create that raced this
  -- accept has already committed or will observe the membership on recheck.)
  UPDATE public.provider_invitations AS sibling
  SET revoked_at = now()
  WHERE lower(sibling.email) = lower(trim(v_invite_email))
    AND sibling.id <> v_invitation_id
    AND sibling.accepted_at IS NULL
    AND sibling.revoked_at IS NULL
    AND sibling.expires_at > now();

  RETURN QUERY SELECT v_provider_id, v_membership_id, v_invite_role;
END;
$$;

REVOKE ALL
ON FUNCTION public.accept_staff_invitation(TEXT, TEXT, TEXT)
FROM PUBLIC;

GRANT EXECUTE
ON FUNCTION public.accept_staff_invitation(TEXT, TEXT, TEXT)
TO authenticated;
