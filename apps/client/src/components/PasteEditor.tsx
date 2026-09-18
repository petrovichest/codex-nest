import { PasteBlocks } from "./PasteBlocks";
import "../styles/pasted-text.css";
import {
  type ChangeEvent,
  type Ref,
  type TextareaHTMLAttributes,
  useLayoutEffect,
  useRef,
} from "react";
import {
  isInlinePaste,
  samePastedText,
  pastedText,
  rebasePastedText,
  replacePasteRanges,
  type MessagePresentation,
  type PastedText,
} from "@codexnest/protocol";
import { clipboardText } from "../pasted-text";
import { useI18n } from "../i18n";

type Snapshot = MessagePresentation & { selection?: [number, number] };

export function usePasteEditor(
  value: MessagePresentation,
  onChange: (value: MessagePresentation) => void,
  identity?: unknown,
) {
  const current = useRef<Snapshot>(value);
  const callback = useRef(onChange);
  callback.current = onChange;
  const history = useRef<Snapshot[]>([]);
  const future = useRef<Snapshot[]>([]);
  useLayoutEffect(() => {
    current.current = value;
    history.current = [];
    future.current = [];
    // A different composer session starts a separate undo history.
  }, [identity]);
  useLayoutEffect(() => {
    if (current.current.input !== value.input || !samePastedText(current.current, value)) {
      current.current = value;
      history.current = [];
      future.current = [];
    }
  });
  function commit(next: Snapshot, selection?: [number, number]) {
    if (next.input === current.current.input && samePastedText(next, current.current)) return;
    history.current.push({ ...current.current, selection });
    if (history.current.length > 100) history.current.shift();
    future.current = [];
    current.current = next;
    callback.current(presentation(next));
  }
  function change(input: string, selection?: [number, number]) {
    const before = current.current;
    let pastes: PastedText;
    if (
      selection &&
      input.startsWith(before.input.slice(0, selection[0])) &&
      input.endsWith(before.input.slice(selection[1])) &&
      input.length >= before.input.length - (selection[1] - selection[0])
    ) {
      pastes = {
        ...pastedText(before),
        inlinePastes: replacePasteRanges(
          before.inlinePastes,
          selection[0],
          selection[1],
          input.length - before.input.length + selection[1] - selection[0],
        ),
      };
    } else pastes = rebasePastedText(before.input, input, before);
    commit({ input, ...pastedText(pastes) }, selection);
  }
  function paste(data: Pick<DataTransfer, "getData">, start: number, end: number): number | null {
    const { text, plain } = clipboardText(data);
    if (!text) return null;
    const before = current.current;
    const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
    if (!isInlinePaste(plain) || /[\r\n\u2028\u2029]/u.test(text)) {
      commit(
        {
          ...before,
          pasteBlocks: [...(before.pasteBlocks ?? []), { id, text }],
          selection: [start, end],
        },
        [start, end],
      );
      return start;
    }
    const input = before.input.slice(0, start) + text + before.input.slice(end);
    const inlinePastes = [
      ...replacePasteRanges(before.inlinePastes, start, end, text.length),
      { id, start, end: start + text.length },
    ].sort((a, b) => a.start - b.start);
    commit(
      { ...before, input, inlinePastes, selection: [start + text.length, start + text.length] },
      [start, end],
    );
    return start + text.length;
  }
  function undo(redo = false): Snapshot | undefined {
    const source = redo ? future : history;
    const target = redo ? history : future;
    const next = source.current.pop();
    if (!next) return undefined;
    target.current.push(current.current);
    current.current = next;
    callback.current(presentation(next));
    return next;
  }
  return {
    change,
    paste,
    undo,
    blocks: (pasteBlocks: NonNullable<PastedText["pasteBlocks"]>) =>
      commit({ ...current.current, pasteBlocks }),
    value,
  };
}

function presentation(value: Snapshot): MessagePresentation {
  return { input: value.input, ...pastedText(value) };
}

type Props = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value"> & {
  ref?: Ref<HTMLTextAreaElement>;
  editor: ReturnType<typeof usePasteEditor>;
  pasteEnabled?: boolean;
};

export function PasteTextarea({
  ref,
  editor,
  pasteEnabled = true,
  onChange,
  onPaste,
  onKeyDown,
  onScroll,
  ...props
}: Props) {
  const field = useRef<HTMLTextAreaElement | null>(null);
  const mirror = useRef<HTMLDivElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const selection = useRef<[number, number] | undefined>(undefined);
  const inputType = useRef("");
  const { t } = useI18n();
  const { input, inlinePastes } = editor.value;
  const latestEditor = useRef(editor);
  latestEditor.current = editor;
  function restore(next: Snapshot | undefined) {
    if (!next) return;
    requestAnimationFrame(() =>
      field.current?.setSelectionRange(
        ...(next.selection ?? [next.input.length, next.input.length]),
      ),
    );
  }
  useLayoutEffect(() => {
    const textarea = field.current;
    if (!textarea) return;
    const beforeInput = (event: Event) => {
      const inputEvent = event as InputEvent;
      inputType.current = inputEvent.inputType;
      if (inputEvent.inputType === "historyUndo" || inputEvent.inputType === "historyRedo") {
        event.preventDefault();
        restore(latestEditor.current.undo(inputEvent.inputType === "historyRedo"));
      } else selection.current = [textarea.selectionStart, textarea.selectionEnd];
    };
    textarea.addEventListener("beforeinput", beforeInput);
    return () => textarea.removeEventListener("beforeinput", beforeInput);
  }, []);
  useLayoutEffect(() => {
    const textarea = field.current;
    const surface = mirror.current;
    if (!textarea || !surface) return;
    const sync = () => {
      const style = getComputedStyle(textarea);
      for (const property of [
        "font",
        "letter-spacing",
        "word-spacing",
        "line-height",
        "padding",
        "border-width",
        "box-sizing",
        "text-indent",
        "tab-size",
        "text-align",
        "direction",
      ])
        surface.style.setProperty(property, style.getPropertyValue(property));
      surface.style.width = `${textarea.clientWidth}px`;
    };
    sync();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(sync);
    observer?.observe(textarea);
    return () => observer?.disconnect();
  }, [input, inlinePastes]);
  let cursor = 0;
  const fragments = (inlinePastes ?? []).flatMap((range) => {
    const before = input.slice(cursor, range.start);
    cursor = range.end;
    return [
      before,
      <mark
        className="paste-inline"
        key={`${range.id}:${range.start}`}
        title={t("Вставленный текст")}
      >
        {input.slice(range.start, range.end)}
      </mark>,
    ];
  });
  return (
    <div className="paste-input">
      <div className="paste-input-layer" ref={layer} aria-hidden="true">
        <div className="paste-input-mirror" ref={mirror}>
          {fragments}
          {input.slice(cursor)}
          {"\n"}
        </div>
      </div>
      <textarea
        {...props}
        ref={(node) => {
          field.current = node;
          if (typeof ref === "function") ref(node);
          else if (ref) ref.current = node;
        }}
        value={input}
        onChange={(event: ChangeEvent<HTMLTextAreaElement>) => {
          let replaced = selection.current;
          const removed = input.length - event.currentTarget.value.length;
          if (replaced && replaced[0] === replaced[1] && removed > 0) {
            if (inputType.current.endsWith("Backward"))
              replaced = [replaced[0] - removed, replaced[1]];
            else if (inputType.current.endsWith("Forward"))
              replaced = [replaced[0], replaced[1] + removed];
          }
          editor.change(event.currentTarget.value, replaced);
          selection.current = undefined;
          onChange?.(event);
        }}
        onPaste={(event) => {
          onPaste?.(event);
          if (!pasteEnabled || event.defaultPrevented || props.readOnly || props.disabled) return;
          const start = event.currentTarget.selectionStart;
          const end = event.currentTarget.selectionEnd;
          const caret = editor.paste(event.clipboardData, start, end);
          if (caret === null) return;
          event.preventDefault();
          selection.current = undefined;
          requestAnimationFrame(() => field.current?.setSelectionRange(caret, caret));
        }}
        onKeyDown={(event) => {
          if (
            !props.readOnly &&
            !props.disabled &&
            (event.ctrlKey || event.metaKey) &&
            !event.altKey &&
            !event.nativeEvent.isComposing &&
            (event.key.toLowerCase() === "z" || event.key.toLowerCase() === "y")
          ) {
            event.preventDefault();
            restore(editor.undo(event.shiftKey || event.key.toLowerCase() === "y"));
            return;
          }
          onKeyDown?.(event);
        }}
        onScroll={(event) => {
          if (mirror.current)
            mirror.current.style.transform = `translate(${-event.currentTarget.scrollLeft}px, ${-event.currentTarget.scrollTop}px)`;
          onScroll?.(event);
        }}
      />
    </div>
  );
}

export function PasteMessageEditor({
  value,
  onValueChange,
  identity,
  ...props
}: Omit<Props, "editor"> & {
  value: MessagePresentation;
  onValueChange(value: MessagePresentation): void;
  identity: string;
}) {
  const editor = usePasteEditor(value, onValueChange, identity);
  return (
    <>
      <PasteBlocks
        blocks={value.pasteBlocks}
        onChange={editor.blocks}
        disabled={props.disabled || props.readOnly}
      />
      <PasteTextarea {...props} editor={editor} />
    </>
  );
}
