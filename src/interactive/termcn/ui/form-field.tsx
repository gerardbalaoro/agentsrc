/* oxlint-disable anti-slop/require-readable-spacing, eslint/no-nested-ternary -- TermCN registry conventions; see ../README.md. */
import { Box, Text } from "ink";
import type { ReactNode } from "react";

import { useUnicode } from "#interactive/termcn/hooks/use-unicode.ts";
import { resolveTerminalSymbol } from "#interactive/termcn/lib/terminal-symbols.ts";

export interface FormFieldProps {
  label: string;
  labelColor?: string;
  children: ReactNode;
  error?: string;
  hint?: string;
  required?: boolean;
  gap?: number;
  errorIcon?: string;
  "aria-label"?: string;
}

export const FormField = ({
  label,
  labelColor,
  children,
  error,
  hint,
  required,
  gap = 0,
  errorIcon,
  "aria-label": ariaLabel,
}: FormFieldProps) => {
  const unicode = useUnicode();
  const resolvedErrorIcon = errorIcon ?? resolveTerminalSymbol(unicode, "✗", "x");

  return (
    <Box flexDirection="column" gap={gap} aria-role="listitem">
      <Text
        aria-label={
          ariaLabel ??
          `${label}${required ? ", required" : ""}${error ? `, error: ${error}` : hint ? `, hint: ${hint}` : ""}`
        }
      >
        {""}
      </Text>
      <Box gap={0}>
        <Text bold color={labelColor}>
          {label}
        </Text>
        {required && <Text aria-hidden> *</Text>}
      </Box>
      <Box>{children}</Box>
      {hint && !error && <Text dimColor>{hint}</Text>}
      {error && (
        <Text aria-label={`Error: ${error}`}>
          <Text aria-hidden>{resolvedErrorIcon} </Text>
          {error}
        </Text>
      )}
    </Box>
  );
};
