export const HELP_REQUEST = 'rio-help-request';
export interface HelpRequest {
  id: string;
  section?: string;
}

export function requestHelp(topic: HelpRequest): void {
  document.dispatchEvent(new CustomEvent<HelpRequest>(HELP_REQUEST, { detail: topic }));
}
