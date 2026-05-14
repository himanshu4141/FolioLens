/**
 * Data-layer wrapper for the `scheme_master` table.
 * See `src/lib/data/README.md` for the convention.
 */
import { supabase } from '@/src/lib/supabase';

const TABLE = 'scheme_master' as const;

export const schemeMasterRepo = {
  from: () => supabase.from(TABLE),
};
