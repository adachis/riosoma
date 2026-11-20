/**
 * Rich text's Markdown subset.  The reader and writer live in the contracts package, where the
 * server's Word documents read rich text the same way the editor does.
 */
export {
  canonicalDoc,
  docToMarkdown,
  editorDoc,
  markdownLine,
  markdownToDoc,
  parseInline,
  parseMarkdown,
  printMarkdown,
  safeLinkHref,
} from '@riosoma/contracts';
export type {
  HeadingLevel,
  RichBlock,
  RichBreak,
  RichBulletList,
  RichCodeBlock,
  RichDoc,
  RichHeading,
  RichInline,
  RichList,
  RichListItem,
  RichMark,
  RichOrderedList,
  RichParagraph,
  RichQuote,
  RichTaskItem,
  RichTaskList,
  RichText,
} from '@riosoma/contracts';
