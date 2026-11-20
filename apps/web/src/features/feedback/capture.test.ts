import { afterEach, describe, expect, it } from 'vitest';
import { dataUrlBytes, mask, redactedSnapshot } from './capture';

/**
 * The screenshot is drawn from the masked copy `redactedSnapshot` makes, so whatever isn't in its
 * markup can't be in the picture.  These pages carry values in every place a value can hide:
 * text, attributes, form fields, and pictures.
 */

const SECRETS = [
  'Ada Lovelace',
  'Analytical Engine',
  '42,000.17',
  'ada@example.com',
  'grace@navy.example',
  'typed-into-a-field',
  'a-long-note-in-a-textarea',
  'Chosen option',
  'Card title value',
  'Comment about payroll',
  'Hidden in a title',
  'Named by a label',
  'Described by alt text',
  'rec00000000000001',
  'Rio remembered this',
];

function page(): void {
  document.body.innerHTML = `
    <div id="root">
      <header class="rio-shell__header">
        <a class="rio-shell__brand" href="/">Riosoma</a>
        <span class="rio-shell__org">Signed in as ada@example.com</span>
      </header>
      <main>
        <div class="rio-db-view-switcher__name" title="Hidden in a title">Projects</div>
        <div role="grid" aria-label="Named by a label">
          <div role="row">
            <div role="columnheader">Name</div>
            <div role="columnheader">Budget</div>
          </div>
          <div class="rio-grid__row" role="row" data-record-id="rec00000000000001">
            <div role="gridcell"><div class="rio-grid__content">Ada Lovelace</div></div>
            <div role="gridcell"><span><b>42,000.17</b></span></div>
            <div role="gridcell"><a href="/db/tbl/viw/rec00000000000001">Analytical Engine</a></div>
          </div>
        </div>
        <div class="rio-kanban-card"><h4 class="rio-kanban-card__title">Card title value</h4></div>
        <p class="rio-comments__body">Comment about payroll</p>
        <form>
          <label>Search <input type="search" value="typed-into-a-field" placeholder="Search"></label>
          <textarea>a-long-note-in-a-textarea</textarea>
          <select><option>Chosen option</option></select>
          <input type="checkbox" checked>
        </form>
        <img src="/files/photo.png" alt="Described by alt text">
        <svg viewBox="0 0 10 10" aria-label="Named by a label"><title>Hidden in a title</title><path d="M0 0h10v10H0z"></path></svg>
        <div data-private>Rio remembered this</div>
        <p>Contact grace@navy.example about it</p>
      </main>
    </div>
    <div class="rio-modal-overlay rio-feedback-overlay"><div role="dialog">Send feedback dialog text</div></div>
  `;
  (document.querySelector('input[type="search"]') as HTMLInputElement).value = 'typed-into-a-field';
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('the screenshot’s page copy', () => {
  it('carries no cell text, record name, field value, input value, or email address', () => {
    page();
    const { markup } = redactedSnapshot(document.body);
    for (const secret of SECRETS) expect(markup, secret).not.toContain(secret);
  });

  it('keeps the places and labels around the values, so the picture still says where it was', () => {
    page();
    const { markup } = redactedSnapshot(document.body);
    expect(markup.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(markup).toContain('<foreignObject');
    expect(markup).toContain('Riosoma');
    expect(markup).toContain('Projects');
    expect(markup).toContain('Budget');
    expect(markup).toContain('Contact');
    // The masked text keeps its shape: "Ada Lovelace" becomes "xxx xxxxxxxx", blurred.
    expect(markup).toContain('xxx xxxxxxxx');
    expect(markup).toContain('blur(');
  });

  it('leaves out the feedback dialog, every attribute, and every link', () => {
    page();
    const { markup } = redactedSnapshot(document.body);
    expect(markup).not.toContain('Send feedback dialog text');
    expect(markup).not.toMatch(/\shref=|\stitle=|aria-|data-|\salt=|\ssrc=|\splaceholder=/);
    // The icon still draws.
    expect(markup).toContain('d="M0 0h10v10H0z"');
  });

  it('masks letters, digits, and punctuation alike, keeping the spaces', () => {
    expect(mask('Ada, 42 @ home.')).toBe('xxxx xx x xxxxx');
  });

  it('measures a data URL’s bytes without decoding it', () => {
    expect(dataUrlBytes(`data:image/png;base64,${btoa('12345')}`)).toBe(5);
    expect(dataUrlBytes(`data:image/png;base64,${btoa('123456')}`)).toBe(6);
  });
});
