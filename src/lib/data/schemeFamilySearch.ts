/**
 * Data-layer wrapper for the `v_fund_family_search` view.
 * See `src/lib/data/README.md` for the convention.
 */
import { supabase } from '@/src/lib/supabase';

// Cast needed: generated types don't include the custom view yet.
const VIEW = 'v_fund_family_search' as any;

export const schemeFamilySearchRepo = {
  from: () => supabase.from(VIEW),
};
