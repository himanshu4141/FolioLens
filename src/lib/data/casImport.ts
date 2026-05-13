/**
 * Data-layer wrapper for the `cas_import` table.
 * See `src/lib/data/README.md` for the convention.
 */
import { supabase } from '@/src/lib/supabase';

const TABLE = 'cas_import' as const;

export const casImportRepo = {
  from: () => supabase.from(TABLE),
};
