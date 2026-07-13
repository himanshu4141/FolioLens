export const REVIEWER_ACCESS_EMAILS = [
  'play-review@foliolens.in',
  'play-review-delete@foliolens.in',
] as const;

export type ReviewerAccessEmail = (typeof REVIEWER_ACCESS_EMAILS)[number];

export function normalizeReviewerAccessEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isReviewerAccessEmail(email: string): email is ReviewerAccessEmail {
  const normalized = normalizeReviewerAccessEmail(email);
  return REVIEWER_ACCESS_EMAILS.includes(normalized as ReviewerAccessEmail);
}
