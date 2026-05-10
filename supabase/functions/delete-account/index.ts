// deno-lint-ignore-file no-explicit-any
import { CORS, json } from '../_shared/cors.ts';
import { getUserFromRequest } from '../_shared/auth.ts';
import { createServiceClient } from '../_shared/supabase-client.ts';

const PREFIX = '[delete-account]';

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS });
  }
  if (req.method !== 'POST') {
    return json({ ok: false, error: 'Method not allowed' }, { status: 405 });
  }

  console.log(`${PREFIX} invoked`);

  const { user, error: authError } = await getUserFromRequest(req);
  if (authError || !user) {
    console.log(`${PREFIX} unauthorized: ${authError ?? 'no user'}`);
    return json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  console.log(`${PREFIX} authorized for user_id=${user.id}`);

  const admin = createServiceClient();

  // FK cascades on every user-scoped table (user_profile, cas_import,
  // cas_inbound_session, user_feedback, user_feedback_attachments) remove
  // dependent rows automatically when auth.users is deleted. Shared catalog
  // tables (fund_portfolio_composition, scheme_master, nav_history,
  // index_history) are not user-scoped and are intentionally untouched.
  const { error: deleteError } = await admin.auth.admin.deleteUser(user.id);
  if (deleteError) {
    console.log(`${PREFIX} delete failed for user_id=${user.id}: ${deleteError.message}`);
    return json(
      { ok: false, error: 'Could not delete account. Please try again.' },
      { status: 500 },
    );
  }

  console.log(`${PREFIX} deleted user_id=${user.id}`);
  return json({ ok: true });
});
