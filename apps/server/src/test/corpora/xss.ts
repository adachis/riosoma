/** Kept as data in sites, help, rich text, and email. */
export const xss = [
  '<script>globalThis.__corpusExecuted=1</script>',
  '<img src=x onerror="globalThis.__corpusExecuted=1">',
  '<svg onload="globalThis.__corpusExecuted=1"></svg>',
  '"><iframe srcdoc="<script>parent.__corpusExecuted=1</script>"></iframe>',
  '</textarea><input autofocus onfocus="globalThis.__corpusExecuted=1">',
  '<math><mtext><table><mglyph><style><!--</style><img src=x onerror="globalThis.__corpusExecuted=1">',
  '&lt;img src=x onerror=globalThis.__corpusExecuted=1&gt;',
  '[run](javascript:globalThis.__corpusExecuted=1)',
  '[run](JaVaScRiPt:globalThis.__corpusExecuted=1)',
  '[run](data:text/html,<script>globalThis.__corpusExecuted=1</script>)',
] as const;

export const unsafeHrefs = [
  'javascript:globalThis.__corpusExecuted=1',
  'JaVaScRiPt:globalThis.__corpusExecuted=1',
  'java\nscript:globalThis.__corpusExecuted=1',
  'data:text/html,<script>globalThis.__corpusExecuted=1</script>',
  'vbscript:msgbox(1)',
  '//example.test/escape',
] as const;
