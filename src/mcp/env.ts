import { UsageError } from "#errors.ts";

/** A manifest string, split into literal text and `${VAR}` references. */
export type EnvValue = EnvPart[];

export type EnvPart = { kind: "text"; text: string } | { kind: "env"; name: string };

// `$${` is a literal `${`. `${NAME}` is a reference. Any other text is literal.
const Token = /\$\$\{|\$\{(?<name>[^}]*)\}?/gu;
const VariableName = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/** Splits a manifest string. `label` names the field in the error message. */
export function parseEnvValue(text: string, label: string): EnvValue {
  const parts: EnvValue = [];
  let literal = "";
  let position = 0;

  for (const match of text.matchAll(Token)) {
    literal += text.slice(position, match.index);
    position = match.index + match[0].length;

    if (match[0] === "$${") {
      literal += "${";
      continue;
    }

    const name = match.groups?.name ?? "";

    if (!match[0].endsWith("}") || !VariableName.test(name)) {
      throw new UsageError(
        `${label}: \`${match[0]}\` is not a valid reference. Use \`\${NAME}\`, or \`$\${\` for a literal \`\${\`.`
      );
    }

    if (literal !== "") {
      parts.push({ kind: "text", text: literal });
      literal = "";
    }

    parts.push({ kind: "env", name });
  }

  literal += text.slice(position);

  if (literal !== "") {
    parts.push({ kind: "text", text: literal });
  }

  return parts;
}

export function hasReference(value: EnvValue) {
  return value.some((part) => part.kind === "env");
}

/** The variable name, when the whole value is one reference. */
export function getReference(value: EnvValue) {
  const [part] = value;

  return value.length === 1 && part?.kind === "env" ? part.name : undefined;
}

/** Writes the value in a harness's own syntax, one part at a time. */
export function formatEnvValue(
  value: EnvValue,
  format: { reference: (name: string) => string; text: (text: string) => string }
) {
  return value
    .map((part) => (part.kind === "env" ? format.reference(part.name) : format.text(part.text)))
    .join("");
}

/** The text of a value. Call it only when `hasReference` is false. */
export function getLiteral(value: EnvValue) {
  return formatEnvValue(value, {
    reference: (name) => {
      throw new Error(`Unexpected reference to ${name} in a literal value.`);
    },
    text: (text) => text,
  });
}
