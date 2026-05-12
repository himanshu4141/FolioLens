-- Create the `static-snapshots` public storage bucket.
--
-- Holds daily-regenerated JSON projections of slow-moving reference
-- data (benchmark index history today; top-fund NAV snapshots tomorrow).
-- Public bucket → no RLS, served via Supabase's CDN. The contents are
-- fully derivable from the source tables, so there's nothing sensitive
-- in here; if a file is ever wrong it gets overwritten on the next
-- daily cron run.
--
-- Phase 9 M5 — Layer 1 of "CDN snapshots for benchmark index history".

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'static-snapshots',
  'static-snapshots',
  true,
  10 * 1024 * 1024, -- 10 MB ceiling per file; index history is ~60 KB
  ARRAY['application/json']
)
ON CONFLICT (id) DO UPDATE
SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Permissive read for everyone, write only via the service role
-- (the `regenerate-index-snapshots` edge function authenticates with
-- service role on upload). Anonymous reads make the bucket function
-- as a CDN-fronted static asset host.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename = 'objects'
      AND policyname = 'static_snapshots_public_read'
  ) THEN
    EXECUTE $POLICY$
      CREATE POLICY static_snapshots_public_read
      ON storage.objects
      FOR SELECT
      TO public
      USING (bucket_id = 'static-snapshots')
    $POLICY$;
  END IF;
END;
$$;
