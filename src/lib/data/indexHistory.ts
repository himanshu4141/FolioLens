/**
 * Data-layer wrapper for the `index_history` table.
 * See `src/lib/data/README.md` for the convention.
 */
import { supabase } from '@/src/lib/supabase';

const TABLE = 'index_history' as const;

export const indexHistoryRepo = {
  from: () => supabase.from(TABLE),
};
