export const REPLY_LABELS = ['interested','not_interested','out_of_office','unsubscribe'] as const;  // what the mock can send
export type ReplyLabel = typeof REPLY_LABELS[number];
export const LABELS = [...REPLY_LABELS, 'needs_review'] as const;   // what a classifier can return
export type Label = typeof LABELS[number];
