import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

export function createServiceClient() {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  );
}

export function createBearerClient(apiKey: string, authorization: string) {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    apiKey,
    {
      auth: { persistSession: false },
      global: { headers: { Authorization: authorization } },
    },
  );
}
