jest.mock('@/src/lib/supabase', () => ({
  supabase: { rpc: jest.fn() },
}));

// eslint-disable-next-line import/first
import { navHistoryRepo } from '@/src/lib/data/navHistory';
// eslint-disable-next-line import/first
import { supabase } from '@/src/lib/supabase';

describe('navHistoryRepo.monthEndNav', () => {
  it('normalizes the deployed newest-first RPC rows to ascending NavPoint values', async () => {
    (supabase.rpc as jest.Mock).mockResolvedValue({
      data: [
        { nav_date: '2026-07-03', nav: '242.7430' },
        { nav_date: '2026-06-30', nav: 239.5 },
        { nav_date: '2026-05-29', nav: '230.125' },
      ],
      error: null,
    });

    await expect(navHistoryRepo.monthEndNav(119212)).resolves.toEqual([
      { date: '2026-05-29', value: 230.125 },
      { date: '2026-06-30', value: 239.5 },
      { date: '2026-07-03', value: 242.743 },
    ]);
  });

  it('drops malformed provider rows rather than poisoning financial calculations', async () => {
    (supabase.rpc as jest.Mock).mockResolvedValue({
      data: [
        { nav_date: '', nav: 100 },
        { nav_date: '2026-06-30', nav: 'not-a-number' },
        { nav_date: '2026-05-29', nav: 230.125 },
      ],
      error: null,
    });

    await expect(navHistoryRepo.monthEndNav(119212)).resolves.toEqual([
      { date: '2026-05-29', value: 230.125 },
    ]);
  });
});
