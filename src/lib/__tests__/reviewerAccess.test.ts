import {
  isReviewerAccessEmail,
  normalizeReviewerAccessEmail,
} from '@/src/lib/reviewerAccess';

describe('reviewerAccess', () => {
  it('normalizes reviewer emails before matching', () => {
    expect(normalizeReviewerAccessEmail('  Play-Review@FolioLens.in ')).toBe(
      'play-review@foliolens.in',
    );
  });

  it.each([
    'play-review@foliolens.in',
    'PLAY-REVIEW@FOLIOLENS.IN',
    ' play-review-delete@foliolens.in ',
  ])('allows the configured reviewer email %s', (email) => {
    expect(isReviewerAccessEmail(email)).toBe(true);
  });

  it.each([
    '',
    'review@foliolens.in',
    'play-review+test@foliolens.in',
    'play-review@foliolens.com',
    'user@example.com',
  ])('rejects non-reviewer email %s', (email) => {
    expect(isReviewerAccessEmail(email)).toBe(false);
  });
});
