import { Fragment } from 'react';
import { useLingui } from '@lingui/react/macro';
import {
  faBold,
  faCode,
  faFileCode,
  faItalic,
  faHeading,
  faLink,
  faListCheck,
  faListOl,
  faListUl,
  faQuoteLeft,
  faStrikethrough,
} from '@fortawesome/free-solid-svg-icons';
import { Icon, type IconDefinition } from '@riosoma/icons';
import { Separator, Toolbar, Tooltip, TooltipTrigger } from '@riosoma/ui';
import { useEditorState, type Editor } from '@tiptap/react';
import { ToggleButton } from 'react-aria-components';
import { comboText, isAppleDevice, parseCombo } from '../../shortcuts/registry';

interface Tool {
  id: string;
  label: string;
  /** The accessible name, when it adds the visible abbreviation to the label */
  name?: string;
  /** The heading level displayed beside its icon */
  level?: number;
  icon?: IconDefinition;
  /** The editor's own shortcut, written the way the shortcut registry writes combinations */
  combo?: string;
  active: boolean;
  disabled?: boolean;
  /** An icon that points one way, turned around in a right-to-left layout */
  mirror?: boolean;
  run: () => void;
}

/** The combination as `aria-keyshortcuts` spells it, such as `Control+Shift+8`. */
function ariaKeys(combo: string, apple: boolean): string {
  const parts = parseCombo(combo);
  return [
    ...(parts.mod ? [apple ? 'Meta' : 'Control'] : []),
    ...(parts.alt ? ['Alt'] : []),
    ...(parts.shift ? ['Shift'] : []),
    parts.key.length === 1 ? parts.key.toUpperCase() : parts.key,
  ].join('+');
}

function ToolButton({ tool, apple }: { tool: Tool; apple: boolean }) {
  const { t } = useLingui();
  const { label } = tool;
  const keys = tool.combo ? comboText(tool.combo, apple) : '';
  const shortcut = tool.combo ? ariaKeys(tool.combo, apple) : null;
  return (
    <TooltipTrigger>
      <ToggleButton
        // React Aria doesn't pass aria-keyshortcuts through, so it goes on the button directly.
        ref={(button) => {
          if (button && shortcut) button.setAttribute('aria-keyshortcuts', shortcut);
        }}
        className="rio-rich-text__tool"
        aria-label={tool.name ?? label}
        data-mirror={tool.mirror ? '' : undefined}
        isSelected={tool.active}
        isDisabled={tool.disabled}
        onChange={() => tool.run()}
      >
        {tool.icon && <Icon icon={tool.icon} />}
        {tool.level && (
          <span className="rio-rich-text__tool-text" aria-hidden="true">
            {tool.level}
          </span>
        )}
      </ToggleButton>
      <Tooltip>{keys ? t({ id: 'fields.richText.withKeys', message: `${label} (${keys})` }) : label}</Tooltip>
    </TooltipTrigger>
  );
}

export interface RichTextToolbarProps {
  editor: Editor;
  /** Whether the link bar is open */
  linking: boolean;
  onLink: () => void;
}

/**
 * The formats, one tab stop for the whole row: the arrow keys move between tools.  Each tool
 * applies to the selection and puts the focus back in the text.
 */
export function RichTextToolbar({ editor, linking, onLink }: RichTextToolbarProps) {
  const { t } = useLingui();
  const apple = isAppleDevice();
  const state = useEditorState({
    editor,
    selector: ({ editor: current }) => ({
      bold: current.isActive('bold'),
      italic: current.isActive('italic'),
      strike: current.isActive('strike'),
      code: current.isActive('code'),
      link: current.isActive('link'),
      heading1: current.isActive('heading', { level: 1 }),
      heading2: current.isActive('heading', { level: 2 }),
      heading3: current.isActive('heading', { level: 3 }),
      bulletList: current.isActive('bulletList'),
      orderedList: current.isActive('orderedList'),
      taskList: current.isActive('taskList'),
      blockquote: current.isActive('blockquote'),
      codeBlock: current.isActive('codeBlock'),
      // Formatting can't go inside a code block, where everything is code already.
      marks: current.can().toggleBold(),
    }),
  });
  const chain = () => editor.chain().focus();
  const groups: Tool[][] = [
    [
      {
        id: 'bold',
        icon: faBold,
        label: t({ id: 'fields.richText.bold', message: 'Bold' }),
        combo: 'Mod+B',
        active: state.bold,
        disabled: !state.marks,
        run: () => chain().toggleBold().run(),
      },
      {
        id: 'italic',
        icon: faItalic,
        label: t({ id: 'fields.richText.italic', message: 'Italic' }),
        combo: 'Mod+I',
        active: state.italic,
        disabled: !state.marks,
        run: () => chain().toggleItalic().run(),
      },
      {
        id: 'strike',
        icon: faStrikethrough,
        label: t({ id: 'fields.richText.strike', message: 'Strikethrough' }),
        combo: 'Mod+Shift+S',
        active: state.strike,
        disabled: !state.marks,
        run: () => chain().toggleStrike().run(),
      },
      {
        id: 'code',
        icon: faCode,
        label: t({ id: 'fields.richText.code', message: 'Inline code' }),
        combo: 'Mod+E',
        active: state.code,
        disabled: !state.marks,
        run: () => chain().toggleCode().run(),
      },
      {
        id: 'link',
        icon: faLink,
        label: t({ id: 'fields.richText.link', message: 'Link' }),
        active: state.link || linking,
        disabled: !state.marks,
        run: onLink,
      },
    ],
    [
      {
        id: 'heading1',
        icon: faHeading,
        level: 1,
        label: t({ id: 'fields.richText.heading1', message: 'Heading 1' }),
        name: t({ id: 'fields.richText.heading1.label', message: 'Heading 1 (H1)' }),
        combo: 'Mod+Alt+1',
        active: state.heading1,
        run: () => chain().toggleHeading({ level: 1 }).run(),
      },
      {
        id: 'heading2',
        icon: faHeading,
        level: 2,
        label: t({ id: 'fields.richText.heading2', message: 'Heading 2' }),
        name: t({ id: 'fields.richText.heading2.label', message: 'Heading 2 (H2)' }),
        combo: 'Mod+Alt+2',
        active: state.heading2,
        run: () => chain().toggleHeading({ level: 2 }).run(),
      },
      {
        id: 'heading3',
        icon: faHeading,
        level: 3,
        label: t({ id: 'fields.richText.heading3', message: 'Heading 3' }),
        name: t({ id: 'fields.richText.heading3.label', message: 'Heading 3 (H3)' }),
        combo: 'Mod+Alt+3',
        active: state.heading3,
        run: () => chain().toggleHeading({ level: 3 }).run(),
      },
    ],
    [
      {
        id: 'bulletList',
        icon: faListUl,
        label: t({ id: 'fields.richText.bulletList', message: 'Bulleted list' }),
        combo: 'Mod+Shift+8',
        active: state.bulletList,
        mirror: true,
        run: () => chain().toggleBulletList().run(),
      },
      {
        id: 'orderedList',
        icon: faListOl,
        label: t({ id: 'fields.richText.orderedList', message: 'Numbered list' }),
        combo: 'Mod+Shift+7',
        active: state.orderedList,
        mirror: true,
        run: () => chain().toggleOrderedList().run(),
      },
      {
        id: 'taskList',
        icon: faListCheck,
        label: t({ id: 'fields.richText.taskList', message: 'Checklist' }),
        combo: 'Mod+Shift+9',
        active: state.taskList,
        mirror: true,
        run: () => chain().toggleTaskList().run(),
      },
    ],
    [
      {
        id: 'blockquote',
        icon: faQuoteLeft,
        label: t({ id: 'fields.richText.quote', message: 'Block quote' }),
        combo: 'Mod+Shift+B',
        active: state.blockquote,
        mirror: true,
        run: () => chain().toggleBlockquote().run(),
      },
      {
        id: 'codeBlock',
        icon: faFileCode,
        label: t({ id: 'fields.richText.codeBlock', message: 'Code block' }),
        combo: 'Mod+Alt+C',
        active: state.codeBlock,
        run: () => chain().toggleCodeBlock().run(),
      },
    ],
  ];
  return (
    // Pressing a tool leaves the focus and the selection in the text, so the format lands on it.
    <div className="rio-rich-text__tools" onMouseDown={(event) => event.preventDefault()}>
      <Toolbar
        aria-label={t({ id: 'fields.richText.toolbar', message: 'Formatting' })}
        density="compact"
        className="rio-rich-text__toolbar"
      >
        {groups.map((group, index) => (
          <Fragment key={group[0]!.id}>
            {index > 0 && <Separator orientation="vertical" />}
            {group.map((tool) => (
              <ToolButton key={tool.id} tool={tool} apple={apple} />
            ))}
          </Fragment>
        ))}
      </Toolbar>
    </div>
  );
}
