import type {
  FeedbackCount,
  FeedbackCreate,
  FeedbackCreated,
  FeedbackGithubSettings,
  FeedbackHubSettings,
  FeedbackHubPreview,
  FeedbackGithubUpdate,
  FeedbackIssuePreview,
  FeedbackIssueSend,
  FeedbackItem,
  FeedbackKind,
  FeedbackPage,
  FeedbackStatus,
  SentFeedbackList,
  SessionInfo,
} from '@riosoma/contracts';
import { api } from '../../api';

/** Feedback: sending it, what the person sent, and the admins' inbox. */

const one = (feedbackId: string) => `/api/admin/feedback/${encodeURIComponent(feedbackId)}`;

export const sentFeedbackKey = ['feedback', 'mine'] as const;
export const feedbackInboxKey = (filters: { kind: FeedbackKind | null; status: FeedbackStatus | null }) =>
  ['admin', 'feedback', 'inbox', filters] as const;
export const feedbackCountKey = ['admin', 'feedback', 'count'] as const;
export const feedbackGithubKey = ['admin', 'feedback', 'github'] as const;
export const feedbackHubKey = ['admin', 'feedback', 'hub'] as const;
export const readHubSettings = (signal?: AbortSignal) =>
  api<FeedbackHubSettings>('/api/admin/feedback/hub', signal ? { signal } : {});
export const saveHubSettings = (enabled: boolean) =>
  api<FeedbackHubSettings>('/api/admin/feedback/hub', { method: 'PUT', body: { enabled } });
export const previewHubReport = (id: string) =>
  api<FeedbackHubPreview>(`${one(id)}/hub/preview`, { body: {} });
export const sendHubReport = (id: string) =>
  api<FeedbackItem>(`${one(id)}/hub`, { body: { softwareBug: true } });

export const sendFeedback = (body: FeedbackCreate) => api<FeedbackCreated>('/api/feedback', { body });

export const listSentFeedback = (signal?: AbortSignal) =>
  api<SentFeedbackList>('/api/feedback/mine', signal ? { signal } : {});

export function listFeedback(
  filters: { kind: FeedbackKind | null; status: FeedbackStatus | null; before?: string },
  signal?: AbortSignal,
) {
  const search = new URLSearchParams();
  if (filters.kind) search.set('kind', filters.kind);
  if (filters.status) search.set('status', filters.status);
  if (filters.before) search.set('before', filters.before);
  const query = search.toString();
  return api<FeedbackPage>(`/api/admin/feedback${query ? `?${query}` : ''}`, signal ? { signal } : {});
}

export const countFeedback = (signal?: AbortSignal) =>
  api<FeedbackCount>('/api/admin/feedback/count', signal ? { signal } : {});

export const screenshotUrl = (feedbackId: string) => `${one(feedbackId)}/screenshot`;

export const setFeedbackStatus = (feedbackId: string, status: FeedbackStatus) =>
  api<FeedbackItem>(`${one(feedbackId)}/status`, { method: 'PUT', body: { status } });

export const replyToFeedback = (feedbackId: string, body: string) =>
  api<FeedbackItem>(`${one(feedbackId)}/replies`, { body: { body } });

export const deleteFeedback = (feedbackId: string) => api<void>(one(feedbackId), { method: 'DELETE' });

export const readGithubSettings = (signal?: AbortSignal) =>
  api<FeedbackGithubSettings>('/api/admin/feedback/github', signal ? { signal } : {});

export const saveGithubSettings = (body: FeedbackGithubUpdate) =>
  api<FeedbackGithubSettings>('/api/admin/feedback/github', { method: 'PUT', body });

export const previewIssue = (feedbackId: string, includeScreenshot: boolean) =>
  api<FeedbackIssuePreview>(`${one(feedbackId)}/github/preview`, { body: { includeScreenshot } });

export const sendIssue = (feedbackId: string, body: FeedbackIssueSend) =>
  api<FeedbackItem>(`${one(feedbackId)}/github`, { body });

/** The inbox is for an organization's owners and the members it gives the feedback role to. */
export function canReadFeedback(session: SessionInfo | null): boolean {
  return session?.membership.kind === 'owner' || Boolean(session?.membership.adminRoles.includes('feedback'));
}
