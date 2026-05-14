/**
 * Data-layer wrapper for the `transaction` table.
 * See `src/lib/data/README.md` for the convention.
 */
import { supabase } from '@/src/lib/supabase';

const TABLE = 'transaction' as const;

export const transactionRepo = {
  from: () => supabase.from(TABLE),
};
