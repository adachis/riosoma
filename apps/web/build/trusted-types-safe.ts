interface SafeConstruction {
  module: string;
  sha256: string;
  sinks: string[];
  reason: string;
}

/** Source changes invalidate each construction proof and require another review. */
export const safeConstructions: SafeConstruction[] = [
  {
    module: '/node_modules/parse5/dist/tokenizer/index.js',
    sha256: 'a34011375a5e05d75adfe6754373e8b5a486aa7334f306d7df9cc6ef6cebeba2',
    sinks: ['possible document.write'],
    reason:
      'The preprocessor and entity decoder append to tokenizer buffers.  Neither receiver is a browser Document.',
  },
  {
    module: '/node_modules/parse5/dist/parser/index.js',
    sha256: 'aea0f192547ab31397499d28fff0905eaf507f3805800a3da665eadd3775723a',
    sinks: ['possible document.write'],
    reason:
      'The parser constructs its own Tokenizer.  Its write method appends input to an inert tokenizer buffer.',
  },
  {
    module: '/node_modules/parse5/dist/index.js',
    sha256: '40588f3496c59345bc65d86563c42ab8246f1b2edc8d3e8e9535b921d6a45a07',
    sinks: ['possible document.write'],
    reason:
      'The parser constructs its own Tokenizer.  Its write method appends input to an inert tokenizer buffer.',
  },
  {
    module: '/node_modules/dompurify/dist/purify.es.mjs',
    sha256: '1a06b721ad8b46d6174b21f22ea70290aaf3e5a81d65af3b7178113953f7c9b1',
    sinks: ['dynamic setAttribute', 'innerHTML', 'parseFromString'],
    reason:
      'The private rio-sanitizer capability supplies dirtyPayload and emptyHTML to the inert parser.  Attribute writes pass DOMPurify checks, including its Trusted Types attribute conversion.  Only the central sanitizer supplies that private capability.',
  },
  {
    module: '/node_modules/react-dom/cjs/react-dom-client.production.js',
    sha256: 'e933c8af7791f9a7c3a726711f1d9e1f6e57426601e6c940ccc01db02df3579c',
    sinks: ['possible script.src'],
    reason:
      'The instance.src assignment is exclusively inside commitHostMount case img.  Script elements cannot reach that branch, and the adapter guards generic attribute and HTML dispatch.',
  },
  {
    module: '/apps/web/src/features/celebrations/engine.ts',
    sha256: '105670fdbe4841e0178114a30f731a7bfef958cd05a789ac928480d2c6bd4696',
    sinks: ['possible document.write'],
    reason:
      'The store is CelebrationStore, whose write method saves celebration memory.  It is never a browser Document.',
  },
  {
    module: '/node_modules/zrender/lib/graphic/helper/parseText.js',
    sha256: 'd62f6f4b274883c2b26c18523289b6274c111c0d3cd6eb56ebb1069e11dc63ef',
    sinks: ['possible script.text'],
    reason:
      'The text fields belong to plain layout results and rich text tokens.  They are never HTMLScriptElement instances.',
  },
  {
    module: '/node_modules/zrender/lib/graphic/Text.js',
    sha256: '8056b228a3861c9f576b14680e3d6d3a59424de267beccf1ac778b4b666f84f5',
    sinks: ['possible script.text'],
    reason:
      'The text fields belong to canvas text style objects.  They are never HTMLScriptElement instances.',
  },
  {
    module: '/node_modules/echarts/lib/label/labelStyle.js',
    sha256: '71295f2ab6d7b75a2b98999c9c898d230d8a16c25ad3b2689c25c10ee09f3ff6',
    sinks: ['possible script.text'],
    reason:
      'The text fields belong to ZRender label style objects.  They are never HTMLScriptElement instances.',
  },
  {
    module: '/node_modules/echarts/lib/core/echarts.js',
    sha256: '39a2d76d0defda468a8c405894b5c4bd9a54d695182bf466523d386179723159',
    sinks: ['dynamic setAttribute'],
    reason:
      'modelUtil.setAttribute is a three-argument chart helper, not Element.setAttribute.  Its underlying DOM attribute dispatch is adapted separately.',
  },
  {
    module: '/apps/web/src/shell/FeatureErrorDialog.tsx',
    sha256: '65d4458c20ec4c8dc00916b3efa9eb42780be7c4697d91959f44fa9c2a24c3df',
    sinks: ['dynamic setAttribute'],
    reason:
      'The attribute name comes exclusively from the literal inert and aria-hidden tuple.  It cannot be src, srcdoc, or text.',
  },
  {
    module: '/apps/web/src/features/feedback/capture.ts',
    sha256: '7b79340b73053ef2c0ecf9cb7ab84d31098e6e0d6d67746a3e06e317b7043247',
    sinks: ['dynamic setAttribute'],
    reason:
      'The copy is a div or an SVG element selected after excluding script tags.  keepsSvgAttribute rejects event-handler attributes and hyperlinks before copying.',
  },
  {
    module: '/apps/web/src/grid/view/controller.ts',
    sha256: 'c050f83e178c71d2a8e54c51c457a16bd6973264e3b7587748faf442ec46c390',
    sinks: ['possible document.write'],
    reason:
      'navigator.clipboard.write receives ClipboardItems.  It does not parse HTML into a browser Document.',
  },
  {
    module: '/node_modules/maplibre-gl/dist/maplibre-gl.mjs',
    sha256: 'e0a464034d28e5d4a345dd2715f1de78476d7d6ca69f1aedd97648b1d5def541',
    sinks: ['possible script.src', 'possible script.text'],
    reason:
      'The src receiver is the media source element created by the video loader.  The text fields belong to formatted labels, glyph runs, collision boxes, and style expressions, not script elements.',
  },
  {
    module: '/apps/web/src/features/signatures/RequestDialog.tsx',
    sha256: '0af8bc1f7c8e86f6b0e0fbc312757889234fabf88ba4ec0e8ad77fc07e4aaa70',
    sinks: ['possible script.src'],
    reason:
      'The frame ref is attached exclusively to the PDF preview iframe.  Its src property is not a script URL sink.',
  },
  {
    module: '/node_modules/prosemirror-model/dist/index.js',
    sha256: 'f204fe2221509bfcd719efd255ac8b3c3cc9951568531a8f8fbf649dff64e5f3',
    sinks: ['possible script.text'],
    reason:
      'Node, TextNode, serializer results, and schema text handlers are ProseMirror model data.  They are not browser script elements.',
  },
  {
    module: '/node_modules/prosemirror-view/dist/index.js',
    sha256: '390e54a91b42be6bccc6bb8e0e305e13c4315c725686ce22260839b8a550976d',
    sinks: ['possible script.text'],
    reason:
      'The text field belongs to CompositionViewDesc, a view descriptor rather than a browser script element.',
  },
  {
    module: '/packages/contracts/dist/markdown.js',
    sha256: '4a69fbd17b9f58f33d8246cbee5a5a385f24de661f3531cf87c41c79705371e6',
    sinks: ['possible script.text'],
    reason:
      'The text fields belong to markdown syntax nodes.  The parser constructs plain objects, not DOM elements.',
  },
  {
    module: '/node_modules/marked/lib/marked.esm.js',
    sha256: '162194ea902a9d6eca6011bb42b5732991ca650e017d0375b76f4204810c6c14',
    sinks: ['possible script.src', 'possible script.text'],
    reason:
      'The text and src fields belong to markdown tokens and the inline lexer queue.  This module tokenizes strings without constructing DOM elements.',
  },
  {
    module: '/apps/web/src/screens/database/views/summary/RecordsPanel.tsx',
    sha256: '96ec1fc334eb9ca3d4c300f97466cd469a559b009fe543a5c9f688ab9dbc37aa',
    sinks: ['possible script.text'],
    reason:
      'The text field belongs to RecordsRefusal, an Error subclass.  It is never a browser script element.',
  },
  {
    module: '/node_modules/pdfmake/build/pdfmake.js',
    sha256: '72af5e953a65e9a9e283bdcbbbb0fe86ebf5f86f1e7844ed62124a4a041519d5',
    sinks: ['possible document.write', 'possible script.src', 'possible script.text'],
    reason:
      'The remaining write calls target PDF references, streams, buffers, XML tokenizers, and decoders.  Text and src fields belong to PDF document definitions and decoder state, and iframe.src belongs to an obsolete iframe fallback.  The adapter removes both legacy document writes and all Function code generators.',
  },
  {
    module: '/packages/grid-core/src/render.ts',
    sha256: 'eb2bfb872af0470fca04e35b81b8855e53909023faca2a323bd1a5277bdc7f92',
    sinks: ['dynamic setAttribute'],
    reason:
      'The band attribute names come from the literal aria-level, aria-expanded, and aria-label entries.  The band nodes are div elements created by createBand.',
  },
  {
    module: '/node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs',
    sha256: '2734a28d3b70c4abdd89cfc3d06521eae1d3d77b5d003857748b3f73d70e66b5',
    sinks: ['possible script.text'],
    reason:
      'The text fields belong to formatted labels, glyph runs, and style expressions in a DOM-free worker.  Remote script evaluation is removed by the adapter.',
  },
  {
    module: '/node_modules/zod/v4/core/schemas.js',
    sha256: '0ee56e8afbae28eeb1060a162ad7e56f0675ee6fb83f0ae56bea2e088f6cdbc0',
    sinks: ['possible document.write'],
    reason:
      'The local doc is constructed as Zod Doc, whose write method accumulates compiler strings in an array.  It is never a browser Document, and the adapter disables its compiler.',
  },
  {
    module: '/apps/web/src/files/drawAttachments.ts',
    sha256: 'e0860c96af8cc51579877066c22a49b128de37ee2c8fe92776d4a2ca72f9a8d1',
    sinks: ['possible script.src'],
    reason:
      'The image is created with the literal img tag in the root HTMLElement ownerDocument.  Its src is an image URL, and it is never an HTMLScriptElement.',
  },
  {
    module: '/apps/web/src/grid/cells/renderers.ts',
    sha256: '33113b67dbba74c9b3b70ab3397f6a3d9a09ad01abf1025d66bb1ad9220dd7e2',
    sinks: ['possible script.src'],
    reason:
      'The picture is created with the literal img tag in the avatar HTMLElement ownerDocument.  Its src is an image URL, and it is never an HTMLScriptElement.',
  },
];
