/**
 * Data-layer wrapper for the `user_profile` table.
 * See `src/lib/data/README.md` for the convention.
 */
import { supabase } from '@/src/lib/supabase';

const TABLE = 'user_profile' as const;

export const userProfileRepo = {
  from: () => supabase.from(TABLE),
};
