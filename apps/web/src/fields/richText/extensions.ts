import { mergeAttributes, Node, wrappingInputRule, type AnyExtension } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { safeLinkHref } from './markdown';

/**
 * The editor's formats, and only those Markdown can store: underline and horizontal rules are left
 * out, since neither has a place in the stored text.  Pasted HTML is read through these, so it
 * keeps what they know and drops everything else: styles, images, scripts, and tables turn into
 * plain paragraphs or disappear.
 */

export interface RichTextExtensionOptions {
  /** The accessible name for a checklist item's checkbox, from the item's text */
  checkboxLabel: (text: string) => string;
}

/** An address has a scheme a link may open, or none, in which case the web or mail is implied. */
function mayAutoLink(address: string): boolean {
  return /^(?:https?|mailto):/i.test(address) || !/^[a-z][a-z0-9+.-]*:/i.test(address);
}

const TaskList = Node.create({
  name: 'taskList',
  group: 'block list',
  content: 'taskItem+',
  parseHTML() {
    return [
      { tag: 'ul[data-type="taskList"]', priority: 51 },
      { tag: 'ul.contains-task-list', priority: 51 },
    ];
  },
  renderHTML({ HTMLAttributes }) {
    return ['ul', mergeAttributes(HTMLAttributes, { 'data-type': 'taskList' }), 0];
  },
  addCommands() {
    return {
      toggleTaskList:
        () =>
        ({ commands }) =>
          commands.toggleList(this.name, 'taskItem'),
    };
  },
  addKeyboardShortcuts() {
    return { 'Mod-Shift-9': () => this.editor.commands.toggleTaskList() };
  },
});

const TaskItem = Node.create<Pick<RichTextExtensionOptions, 'checkboxLabel'>>({
  name: 'taskItem',
  content: 'paragraph block*',
  defining: true,
  addOptions() {
    return { checkboxLabel: (text: string) => text };
  },
  addAttributes() {
    return {
      checked: {
        default: false,
        keepOnSplit: false,
        parseHTML: (element) => {
          const flag = element.getAttribute('data-checked');
          if (flag !== null) return flag === '' || flag === 'true';
          return element.querySelector('input[type="checkbox"]')?.hasAttribute('checked') ?? false;
        },
        renderHTML: (attributes) => ({ 'data-checked': attributes.checked === true ? 'true' : 'false' }),
      },
    };
  },
  parseHTML() {
    return [
      { tag: 'li[data-type="taskItem"]', priority: 51 },
      { tag: 'li.task-list-item', priority: 51 },
    ];
  },
  renderHTML({ node, HTMLAttributes }) {
    return [
      'li',
      mergeAttributes(HTMLAttributes, { 'data-type': 'taskItem' }),
      ['label', ['input', { type: 'checkbox', checked: node.attrs.checked === true ? 'checked' : null }]],
      ['div', 0],
    ];
  },
  addKeyboardShortcuts() {
    return {
      Enter: () => this.editor.commands.splitListItem(this.name),
      Tab: () => this.editor.commands.sinkListItem(this.name),
      'Shift-Tab': () => this.editor.commands.liftListItem(this.name),
    };
  },
  addNodeView() {
    return ({ node, getPos, editor }) => {
      const item = document.createElement('li');
      item.dataset.type = 'taskItem';
      const box = document.createElement('span');
      box.className = 'rio-rich-text__check';
      box.contentEditable = 'false';
      const input = document.createElement('input');
      input.type = 'checkbox';
      const content = document.createElement('div');
      content.className = 'rio-rich-text__task';
      box.append(input);
      item.append(box, content);
      const show = (current: typeof node) => {
        const checked = current.attrs.checked === true;
        input.checked = checked;
        item.dataset.checked = String(checked);
        input.disabled = !editor.isEditable;
        input.setAttribute('aria-label', this.options.checkboxLabel(current.textContent.trim()));
      };
      show(node);
      // Checking a box leaves the caret where it was.
      input.addEventListener('mousedown', (event) => event.preventDefault());
      input.addEventListener('change', () => {
        const position = getPos();
        if (!editor.isEditable || typeof position !== 'number') {
          input.checked = !input.checked;
          return;
        }
        // Into the text, so leaving it saves the change like any other.
        editor
          .chain()
          .focus(undefined, { scrollIntoView: false })
          .command(({ tr }) => {
            const current = tr.doc.nodeAt(position);
            if (!current) return false;
            tr.setNodeMarkup(position, undefined, { ...current.attrs, checked: input.checked });
            return true;
          })
          .run();
      });
      return {
        dom: item,
        contentDOM: content,
        update: (updated) => {
          if (updated.type !== node.type) return false;
          show(updated);
          return true;
        },
      };
    };
  },
  addInputRules() {
    return [
      wrappingInputRule({
        find: /^\s*(\[([( |x])?\])\s$/,
        type: this.type,
        getAttributes: (match) => ({ checked: match[match.length - 1] === 'x' }),
      }),
    ];
  },
});

export function richTextExtensions({ checkboxLabel }: RichTextExtensionOptions): AnyExtension[] {
  return [
    StarterKit.configure({
      underline: false,
      horizontalRule: false,
      link: {
        // Links open from the link bar while editing, and as ordinary links everywhere else.
        openOnClick: false,
        autolink: false,
        linkOnPaste: true,
        defaultProtocol: 'https',
        isAllowedUri: (address) => safeLinkHref(address) !== null,
        shouldAutoLink: mayAutoLink,
        HTMLAttributes: { target: '_blank', rel: 'noopener noreferrer nofollow', class: null },
      },
    }),
    TaskList,
    TaskItem.configure({ checkboxLabel }),
  ];
}
