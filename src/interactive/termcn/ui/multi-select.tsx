/* oxlint-disable anti-slop/require-readable-spacing, eslint/no-shadow, eslint/no-unused-vars -- TermCN registry conventions; see ../README.md. */
import { Box, Text } from "ink";
import React, { useState } from "react";

import { useInteraction } from "#interactive/termcn/hooks/use-interaction.tsx";
import { useUnicode } from "#interactive/termcn/hooks/use-unicode.ts";
import { resolveTerminalSymbol } from "#interactive/termcn/lib/terminal-symbols.ts";

export interface MultiSelectOption<T = string> {
  value: T;
  label: string;
  hint?: string;
  disabled?: boolean;
}

export interface MultiSelectProps<T = string> {
  options: MultiSelectOption<T>[];
  value?: T[];
  defaultValue?: T[];
  onValueChange?: (values: T[]) => void;
  onChange?: (values: T[]) => void;
  onSubmit?: (values: T[]) => void;
  cursor?: string;
  activeIndex?: number;
  onActiveIndexChange?: (index: number) => void;
  accentColor?: string;
  selectionColor?: string;
  checkmark?: string;
  height?: number;
  label?: string;
  id?: string;
  autoFocus?: boolean;
  isActive?: boolean;
  disabled?: boolean;
  "aria-label"?: string;
}

export const MultiSelect = <T = string,>({
  options,
  value: controlledValue,
  defaultValue = [],
  onValueChange,
  onChange,
  onSubmit,
  cursor,
  activeIndex: controlledIndex,
  onActiveIndexChange,
  accentColor,
  selectionColor,
  checkmark,
  height,
  label,
  id,
  autoFocus = false,
  isActive = true,
  disabled = false,
  "aria-label": ariaLabel,
}: MultiSelectProps<T>) => {
  const unicode = useUnicode();
  const resolvedCursor = cursor ?? resolveTerminalSymbol(unicode, "›", ">");
  const resolvedCheckmark = checkmark ?? resolveTerminalSymbol(unicode, "◉", "[x]");
  const [internalIndex, setInternalIndex] = useState(0);
  const activeIndex = controlledIndex ?? internalIndex;

  function setActiveIndex(next: number) {
    (onActiveIndexChange ?? setInternalIndex)(next);
  }
  const [internalSelected, setInternalSelected] = useState<T[]>(defaultValue);

  const selected = controlledValue ?? internalSelected;

  const scrollOffset = (() => {
    if (!height) {
      return 0;
    }
    const half = Math.floor(height / 2);
    const maxOffset = options.length - height;
    const offset = activeIndex - half;
    if (offset < 0) {
      return 0;
    }
    if (offset > maxOffset) {
      return Math.max(0, maxOffset);
    }
    return offset;
  })();

  const visibleOptions = height ? options.slice(scrollOffset, scrollOffset + height) : options;

  function moveFocus(direction: number) {
    let next = activeIndex + direction;
    while (next >= 0 && next < options.length && options[next]?.disabled) {
      next += direction;
    }
    if (next >= 0 && next < options.length) {
      setActiveIndex(next);
    }
  }

  const { isFocused } = useInteraction(
    (input, key) => {
      if (key.upArrow || key.downArrow) {
        moveFocus(key.upArrow ? -1 : 1);
      } else if (input === " ") {
        const opt = options[activeIndex];
        if (!opt || opt.disabled) {
          return;
        }
        const isSelected = selected.includes(opt.value);
        const next = isSelected
          ? selected.filter((v) => v !== opt.value)
          : [...selected, opt.value];
        if (controlledValue === undefined) {
          setInternalSelected(next);
        }
        (onValueChange ?? onChange)?.(next);
      } else if (key.return) {
        onSubmit?.(selected);
      } else if (key.home) {
        const firstEnabled = options.findIndex((option) => !option.disabled);
        if (firstEnabled !== -1) {
          setActiveIndex(firstEnabled);
        }
      } else if (key.end) {
        const lastEnabled = options.findLastIndex((option) => !option.disabled);
        if (lastEnabled !== -1) {
          setActiveIndex(lastEnabled);
        }
      }
    },
    { autoFocus, disabled, id, isActive }
  );

  return (
    <Box
      aria-role="listbox"
      aria-state={{ disabled, multiselectable: true }}
      flexDirection="column"
    >
      <Text aria-label={ariaLabel ?? label ?? "Multi select"} bold={Boolean(label)}>
        {label ?? ""}
      </Text>
      {visibleOptions.map((opt, visibleIdx) => {
        const idx = scrollOffset + visibleIdx;
        const isActive = idx === activeIndex;
        const isSelected = selected.includes(opt.value);
        const icon = isSelected ? resolvedCheckmark : resolveTerminalSymbol(unicode, "○", "[ ]");

        return (
          <Box
            key={idx}
            aria-label={opt.hint ? `${opt.label}: ${opt.hint}` : opt.label}
            aria-role="option"
            aria-state={{ disabled: opt.disabled, selected: isSelected }}
            gap={1}
          >
            <Text aria-hidden color={isActive ? accentColor : undefined}>
              {isActive ? resolvedCursor : " "}
            </Text>
            <Text
              aria-hidden
              color={isSelected ? selectionColor : undefined}
              dimColor={opt.disabled}
            >
              {icon}
            </Text>
            <Text
              aria-hidden
              color={isActive ? accentColor : undefined}
              bold={isActive}
              dimColor={opt.disabled}
            >
              {opt.label}
            </Text>
            {opt.hint && (
              <Text aria-hidden dimColor>
                {opt.hint}
              </Text>
            )}
          </Box>
        );
      })}
    </Box>
  );
};
