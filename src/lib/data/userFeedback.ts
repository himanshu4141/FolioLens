/**
 * Data-layer wrapper for the `user_feedback` table.
 * See `src/lib/data/README.md` for the convention.
 */
import { supabase } from '@/src/lib/supabase';
import type { Database } from '@/src/types/database.types';

const TABLE = 'user_feedback' as const;

type UserFeedbackInsert = Database['public']['Tables']['user_feedback']['Insert'];

export const userFeedbackRepo = {
  from: () => supabase.from(TABLE),

  /** Insert a feedback row. Returns the same shape as supabase-js. */
  insert: (row: UserFeedbackInsert) => supabase.from(TABLE).insert(row),
};
