/* oxlint-disable anti-slop/require-readable-spacing, eslint/complexity -- TermCN registry conventions; see ../README.md. */
import { useCursor, Box, Text } from "ink";
import React, { useEffect, useState } from "react";

import { useInteraction } from "#interactive/termcn/hooks/use-interaction.tsx";
import { useUnicode } from "#interactive/termcn/hooks/use-unicode.ts";
import { resolveBorderStyle } from "#interactive/termcn/lib/terminal-style.ts";
import { resolveTerminalSymbol } from "#interactive/termcn/lib/terminal-symbols.ts";
import {
  cursorCellOffset,
  graphemeLength,
  insertAtGrapheme,
  removeGraphemeAt,
  removeGraphemeBefore,
  sliceGraphemes,
  splitGraphemes,
  terminalWidth,
  truncateToTerminalWidth,
} from "#interactive/termcn/lib/terminal-text.ts";
import type { BorderStyle } from "#interactive/termcn/ui/types.ts";

export interface TextInputProps {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  onChange?: (value: string) => void;
  onSubmit?: (value: string) => void;
  placeholder?: string;
  mask?: string;
  showCursor?: boolean;
  highlightPastedText?: boolean;
  validate?: (value: string) => string | null;
  width?: number;
  label?: string;
  autoFocus?: boolean;
  id?: string;
  isActive?: boolean;
  disabled?: boolean;
  readOnly?: boolean;
  required?: boolean;
  "aria-label"?: string;
  cursorOrigin?: { x: number; y: number };
  bordered?: boolean;
  borderStyle?: BorderStyle;
  paddingX?: number;
  cursor?: string;
}

export const TextInput = ({
  value: controlledValue,
  defaultValue = "",
  onValueChange,
  onChange,
  onSubmit,
  placeholder = "",
  mask,
  showCursor = true,
  highlightPastedText = false,
  validate,
  width = 40,
  label,
  autoFocus = false,
  id,
  isActive = true,
  disabled = false,
  readOnly = false,
  required = false,
  "aria-label": ariaLabel,
  cursorOrigin,
  bordered = true,
  borderStyle = "round",
  paddingX = 1,
  cursor,
}: TextInputProps) => {
  const unicode = useUnicode();
  const resolvedCursor = cursor ?? resolveTerminalSymbol(unicode, "█", "|");
  const [internalValue, setInternalValue] = useState(defaultValue);
  const [cursorOffset, setCursorOffset] = useState(() =>
    graphemeLength(controlledValue ?? defaultValue)
  );
  const [cursorWidth, setCursorWidth] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const { setCursorPosition } = useCursor();

  const value = controlledValue ?? internalValue;
  const valueLength = graphemeLength(value);

  useEffect(() => {
    if (cursorOffset > valueLength) {
      setCursorOffset(valueLength);
    }
  }, [cursorOffset, valueLength]);

  const setValue = (next: string) => {
    const changeHandler = onValueChange ?? onChange;
    if (changeHandler) {
      changeHandler(next);
    } else {
      setInternalValue(next);
    }
  };

  const { isFocused } = useInteraction(
    (input, key) => {
      if (
        key.upArrow ||
        key.downArrow ||
        (key.ctrl && input === "c") ||
        key.tab ||
        (key.shift && key.tab)
      ) {
        return;
      }

      if (key.return) {
        const err = validate ? validate(value) : null;
        if (err) {
          setError(err);
          return;
        }
        setError(null);
        onSubmit?.(value);
        return;
      }

      if (key.escape) {
        return;
      }

      let nextOffset = cursorOffset;
      let nextValue = value;
      let nextCursorWidth = 0;

      if (key.ctrl && input === "u" && !readOnly) {
        nextOffset = 0;
        nextValue = "";
      } else if (key.ctrl || key.meta) {
        return;
      } else if (key.leftArrow) {
        if (showCursor) {
          nextOffset = Math.max(0, nextOffset - 1);
        }
      } else if (key.rightArrow) {
        if (showCursor) {
          nextOffset = Math.min(valueLength, nextOffset + 1);
        }
      } else if (key.home) {
        nextOffset = 0;
      } else if (key.end) {
        nextOffset = valueLength;
      } else if (!readOnly && key.backspace) {
        const result = removeGraphemeBefore(value, cursorOffset);
        nextValue = result.value;
        nextOffset = result.cursor;
      } else if (!readOnly && key.delete) {
        const result = removeGraphemeAt(value, cursorOffset);
        nextValue = result.value;
        nextOffset = result.cursor;
      } else if (!readOnly && input) {
        const pasted = input.replaceAll(/[\r\n\t]/gu, " ");
        nextValue = insertAtGrapheme(value, cursorOffset, pasted);
        const insertedLength = graphemeLength(pasted);
        nextOffset = cursorOffset + insertedLength;

        if (insertedLength > 1) {
          nextCursorWidth = insertedLength;
        }
      }

      setCursorOffset(nextOffset);
      setCursorWidth(nextCursorWidth);

      if (nextValue !== value) {
        setValue(nextValue);
      }
    },
    { autoFocus, disabled, id, isActive }
  );

  const displayValue = mask ? mask.repeat(valueLength) : value;
  const useNativeCursor = Boolean(cursorOrigin && showCursor && isFocused);
  useEffect(() => {
    setCursorPosition(
      useNativeCursor && cursorOrigin
        ? {
            x: cursorOrigin.x + cursorCellOffset(displayValue, cursorOffset),
            y: cursorOrigin.y,
          }
        : undefined
    );
    return () => setCursorPosition(undefined);
  }, [cursorOffset, cursorOrigin, displayValue, setCursorPosition, useNativeCursor]);

  const pasteWidth = highlightPastedText ? cursorWidth : 0;

  const renderValue = () => {
    const available = Math.max(1, width - paddingX * 2 - (bordered ? 2 : 0));
    if (!value && placeholder) {
      if (showCursor && isFocused && !useNativeCursor) {
        const placeholderGraphemes = splitGraphemes(placeholder);
        return (
          <Text>
            <Text inverse>{placeholderGraphemes[0] ?? " "}</Text>
            {truncateToTerminalWidth(placeholderGraphemes.slice(1).join(""), available - 1)}
          </Text>
        );
      }
      return <Text>{truncateToTerminalWidth(placeholder, available)}</Text>;
    }

    if (!showCursor || !isFocused || useNativeCursor) {
      return <Text>{truncateToTerminalWidth(displayValue, available)}</Text>;
    }

    const cursorChar =
      cursorOffset < graphemeLength(displayValue)
        ? sliceGraphemes(displayValue, cursorOffset, cursorOffset + 1)
        : resolvedCursor;
    let start = 0;
    while (
      start < cursorOffset &&
      terminalWidth(sliceGraphemes(displayValue, start, cursorOffset)) + terminalWidth(cursorChar) >
        available
    ) {
      start += 1;
    }
    const before = sliceGraphemes(displayValue, start, Math.max(start, cursorOffset - pasteWidth));
    const highlighted = sliceGraphemes(
      displayValue,
      Math.max(start, cursorOffset - pasteWidth),
      cursorOffset
    );
    const used = terminalWidth(before + highlighted + cursorChar);
    const after = truncateToTerminalWidth(
      sliceGraphemes(displayValue, cursorOffset + 1),
      available - used
    );

    return (
      <Text>
        {before}
        {highlighted && <Text inverse>{highlighted}</Text>}
        <Text inverse>{cursorChar}</Text>
        {after}
      </Text>
    );
  };

  return (
    <Box flexDirection="column">
      {label && <Text bold>{label}</Text>}
      {bordered ? (
        <Box
          aria-label={
            ariaLabel ??
            `${label ?? "Text input"}: ${
              mask ? `${valueLength} characters` : value || "empty"
            }${error ? `. Error: ${error}` : ""}`
          }
          aria-role="textbox"
          aria-state={{ disabled, readonly: readOnly, required }}
          borderStyle={resolveBorderStyle(borderStyle, unicode)}
          width={width}
          paddingX={paddingX}
        >
          {renderValue()}
        </Box>
      ) : (
        <Box
          aria-label={
            ariaLabel ??
            `${label ?? "Text input"}: ${
              mask ? `${valueLength} characters` : value || "empty"
            }${error ? `. Error: ${error}` : ""}`
          }
          aria-role="textbox"
          aria-state={{ disabled, readonly: readOnly, required }}
          width={width}
          paddingX={paddingX}
        >
          {renderValue()}
        </Box>
      )}
      {error && <Text>{error}</Text>}
    </Box>
  );
};
