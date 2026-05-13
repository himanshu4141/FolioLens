/**
 * Data-layer wrapper for the `nav_history` table.
 * See `src/lib/data/README.md` for the convention.
 */
import { supabase } from '@/src/lib/supabase';

const TABLE = 'nav_history' as const;

export const navHistoryRepo = {
  from: () => supabase.from(TABLE),
};
