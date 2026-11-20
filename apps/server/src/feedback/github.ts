import { AppError, type FeedbackContext, type SimilarIssue } from '@riosoma/contracts';
import { callOut, OutboundError, systemResolve, type Resolve } from '../automations/outbound.js';
import { DEFAULT_GITHUB_API_URL, type RuntimeConfig } from '../config.js';
import { allowsPrivate } from '../webhooks/url.js';

/**
 * Bug reports on GitHub.  Everything goes through the guarded outbound client, so an address that
 * resolves to a private network is refused unless the operator allows it, and nothing follows a
 * redirect.  The token only ever travels in the `authorization` header of these calls: it's never
 * logged, never put in an error, and never sent back to the browser.
 *
 * What an issue says is built from the feedback's message and context alone, the same way every
 * time, so the preview an admin reads is exactly what's sent.  The sender's name never goes.
 */

export interface GithubTarget {
  repository: string;
  token: string;
}

type Config = Pick<RuntimeConfig, 'production' | 'automationsAllowPrivateHosts' | 'githubApiUrl'>;

/** Stands where the screenshot's link goes, in a preview made before the screenshot is added. */
export const SCREENSHOT_LINK_PLACEHOLDER = '(link to the screenshot)';

const TITLE_LENGTH = 80;
/** How much of a listing of open issues is read */
const LIST_LIMIT = 4 * 1024 * 1024;
/** A 2 MB screenshot is 2.7 MB as base64, and the call carries a little more around it. */
const UPLOAD_LIMIT = 3 * 1024 * 1024;

/** The issue's title: the message's first line, on one line and at most 80 characters. */
export function issueTitle(message: string): string {
  const first = message.split('\n').find((line) => line.trim()) ?? message;
  const line = first.replace(/\s+/g, ' ').trim();
  const characters = Array.from(line);
  return characters.length <= TITLE_LENGTH
    ? line
    : `${characters
        .slice(0, TITLE_LENGTH - 1)
        .join('')
        .trimEnd()}…`;
}

/** A fence longer than any run of backticks in the text, so nothing inside can close it. */
function fenced(text: string, language = 'text'): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}${language}\n${text}\n${fence}`;
}

/** An inline code span that holds the value whatever backticks it has, or `unknown` for nothing. */
function code(value: string): string {
  if (!value) return 'unknown';
  const longest = Math.max(0, ...[...value.matchAll(/`+/g)].map((match) => match[0].length));
  const ticks = '`'.repeat(longest + 1);
  return `${ticks} ${value} ${ticks}`;
}

/**
 * The issue's or comment's text: the message as a quote, then the context, then the screenshot's
 * link when it goes too, then which feedback it came from.
 */
export function issueBody(
  feedback: { id: string; message: string; context: FeedbackContext },
  screenshotUrl: string | null,
): string {
  const { context } = feedback;
  const quote = feedback.message
    .split('\n')
    .map((line) => (line.trim() ? `> ${line}` : '>'))
    .join('\n');
  const lines = [
    quote,
    '',
    '**Context**',
    '',
    `- Page: ${code(context.path)}`,
    `- Version: ${code(context.appVersion)}`,
    `- Browser: ${code(context.browser)}`,
    `- Platform: ${code(context.platform)}`,
    `- Theme: ${code(context.theme)}`,
    `- Language: ${code(context.language)}`,
  ];
  if (context.errors.length) {
    const errors = context.errors
      .map((error) => (error.stack ? `${error.message}\n${error.stack}` : error.message))
      .join('\n\n');
    lines.push(
      '',
      '<details>',
      `<summary>Recent errors in the browser (${context.errors.length})</summary>`,
      '',
      fenced(errors),
      '',
      '</details>',
    );
  }
  if (screenshotUrl) lines.push('', `![Screenshot](${screenshotUrl})`);
  lines.push('', `Sent from Riosoma feedback ${code(feedback.id)}`);
  return lines.join('\n');
}

/** Where a screenshot goes in the repository when an admin sends it too. */
export function screenshotPath(feedbackId: string, type: string): string {
  const extension = type === 'image/jpeg' ? 'jpg' : type === 'image/webp' ? 'webp' : 'png';
  return `.github/feedback-screenshots/${feedbackId}.${extension}`;
}

/** A title's words, in lowercase, without the punctuation between them. */
function words(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length > 1),
  );
}

/** How alike two titles are, from 0 to 1: how many words they share, and all of one in the other. */
export function titleLikeness(a: string, b: string): number {
  const left = words(a);
  const right = words(b);
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  const dice = (2 * shared) / (left.size + right.size);
  const contained = shared === Math.min(left.size, right.size) ? 0.75 : 0;
  return Math.max(dice, contained);
}

/** Open issues whose titles come close to this one, closest first, at most five. */
export function similarIssues(title: string, issues: SimilarIssue[]): SimilarIssue[] {
  return issues
    .map((issue) => ({ issue, likeness: titleLikeness(title, issue.title) }))
    .filter((entry) => entry.likeness >= 0.5)
    .sort((a, b) => b.likeness - a.likeness || b.issue.number - a.issue.number)
    .slice(0, 5)
    .map((entry) => entry.issue);
}

/** An address GitHub gave for a page of its own, kept only when it's a web address. */
function webUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2_000 || !URL.canParse(value)) return null;
  const { protocol } = new URL(value);
  return protocol === 'https:' || protocol === 'http:' ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** What GitHub's answer means for the admin, as a message key.  The answer itself is never kept. */
function refusal(status: number): AppError {
  if (status === 401) return new AppError('bad_request', 'feedback.github.unauthorized');
  if (status === 403) return new AppError('bad_request', 'feedback.github.forbidden');
  if (status === 404) return new AppError('bad_request', 'feedback.github.notFound');
  if (status === 410) return new AppError('bad_request', 'feedback.github.issuesOff');
  if (status === 422) return new AppError('bad_request', 'feedback.github.rejected');
  return new AppError('unavailable', 'feedback.github.failed', { params: { status } });
}

export class GithubClient {
  /** How GitHub's host is resolved.  Tests swap in their own. */
  resolve: Resolve = systemResolve;

  constructor(private readonly config: Config) {}

  private get base(): string {
    return (this.config.githubApiUrl ?? DEFAULT_GITHUB_API_URL).replace(/\/+$/, '');
  }

  private repoPath(repository: string): string {
    const [owner = '', name = ''] = repository.split('/');
    return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  }

  private async call(
    target: GithubTarget,
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    body: unknown,
    limits: { request?: number; response?: number } = {},
  ): Promise<{ status: number; json: unknown }> {
    const url = `${this.base}${path}`;
    let response;
    try {
      response = await callOut(
        {
          url,
          method,
          headers: {
            accept: 'application/vnd.github+json',
            authorization: `Bearer ${target.token}`,
            'user-agent': 'Riosoma-Feedback',
            'x-github-api-version': '2022-11-28',
          },
          body: body === undefined ? null : JSON.stringify(body),
        },
        {
          resolve: this.resolve,
          allowPrivate: allowsPrivate(url, this.config),
          ...(limits.request ? { requestLimit: limits.request } : {}),
          ...(limits.response ? { responseLimit: limits.response } : {}),
        },
      );
    } catch (error) {
      if (error instanceof OutboundError && error.messageKey === 'automations.webhook.blocked')
        throw new AppError('bad_request', 'feedback.github.blocked');
      throw new AppError('unavailable', 'feedback.github.unreachable');
    }
    let json: unknown = null;
    if (!response.truncated) {
      try {
        json = JSON.parse(response.body) as unknown;
      } catch {
        json = null;
      }
    }
    return { status: response.status, json };
  }

  /** The repository's open issues, the 100 most recently updated, without pull requests. */
  async openIssues(target: GithubTarget): Promise<SimilarIssue[]> {
    const answer = await this.call(
      target,
      'GET',
      `${this.repoPath(target.repository)}/issues?state=open&sort=updated&direction=desc&per_page=100`,
      undefined,
      { response: LIST_LIMIT },
    );
    if (answer.status !== 200) throw refusal(answer.status);
    if (!Array.isArray(answer.json)) return [];
    return answer.json.flatMap((entry: unknown) => {
      const issue = record(entry);
      if (!issue || issue.pull_request) return [];
      const { number, title } = issue;
      const url = webUrl(issue.html_url);
      return typeof number === 'number' && typeof title === 'string' && url ? [{ number, title, url }] : [];
    });
  }

  async createIssue(
    target: GithubTarget,
    title: string,
    body: string,
  ): Promise<{ number: number; url: string }> {
    const answer = await this.call(target, 'POST', `${this.repoPath(target.repository)}/issues`, {
      title,
      body,
    });
    if (answer.status !== 201) throw refusal(answer.status);
    const issue = record(answer.json);
    const url = webUrl(issue?.html_url);
    if (typeof issue?.number !== 'number' || !url)
      throw new AppError('unavailable', 'feedback.github.failed', { params: { status: answer.status } });
    return { number: issue.number, url };
  }

  async comment(target: GithubTarget, issueNumber: number, body: string): Promise<{ url: string }> {
    const answer = await this.call(
      target,
      'POST',
      `${this.repoPath(target.repository)}/issues/${issueNumber}/comments`,
      { body },
    );
    if (answer.status !== 201) throw refusal(answer.status);
    const url = webUrl(record(answer.json)?.html_url);
    if (!url)
      throw new AppError('unavailable', 'feedback.github.failed', { params: { status: answer.status } });
    return { url };
  }

  /**
   * Adds the screenshot to the repository and returns a link an issue can show it with.  One
   * already there from an earlier report on the same feedback is used again.
   */
  async addScreenshot(
    target: GithubTarget,
    path: string,
    bytes: Buffer,
    feedbackId: string,
  ): Promise<string> {
    const at = `${this.repoPath(target.repository)}/contents/${path.split('/').map(encodeURIComponent).join('/')}`;
    const answer = await this.call(
      target,
      'PUT',
      at,
      { message: `Add a screenshot for feedback ${feedbackId}`, content: bytes.toString('base64') },
      { request: UPLOAD_LIMIT },
    );
    let content = record(record(answer.json)?.content);
    if (answer.status === 422) {
      const existing = await this.call(target, 'GET', at, undefined, { response: LIST_LIMIT });
      if (existing.status !== 200) throw refusal(existing.status);
      content = record(existing.json);
    } else if (answer.status !== 201 && answer.status !== 200) throw refusal(answer.status);
    const url = webUrl(content?.html_url);
    if (!url)
      throw new AppError('unavailable', 'feedback.github.failed', { params: { status: answer.status } });
    return `${url}?raw=true`;
  }
}
