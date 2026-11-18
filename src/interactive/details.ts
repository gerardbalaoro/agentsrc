import { stripVTControlCharacters } from "node:util";

import wrapAnsi from "wrap-ansi";

import type { BatchAction } from "#interactive/batch.ts";
import { describeEntry } from "#interactive/inventory.ts";
import type { InventoryItem } from "#interactive/inventory.ts";

interface DetailAction {
  key: string;
  label: string;
  action: BatchAction;
}

export function entryActions(item: InventoryItem): DetailAction[] {
  const kind = item.kind === "skills" ? "skill" : "server";

  if (!item.managed) {
    return [
      {
        key: "i",
        label: `Import ${kind}`,
        action: "import",
      },
    ];
  }

  return [
    {
      key: "u",
      label: `Update ${kind}`,
      action: "update",
    },
    {
      key: "r",
      label: "Repair installation",
      action: "repair",
    },
    {
      key: "d",
      label: `Remove ${kind}`,
      action: "remove",
    },
  ];
}

export function targetActions(items: InventoryItem[]) {
  const [first] = items;

  if (items.length === 1 && first) {
    return entryActions(first);
  }

  return [
    { key: "u", label: "Update marked entries", action: "update" as const },
    { key: "r", label: "Repair marked entries", action: "repair" as const },
    { key: "d", label: "Remove marked entries", action: "remove" as const },
    { key: "i", label: "Import marked entries", action: "import" as const },
  ];
}

export function detailLayout(columns: number, height: number) {
  return { width: Math.min(columns - 4, 92), rows: Math.max(1, height - 3) };
}

/** Readable configuration uses the same credential masking as previews and inspection. */
export function detailLines(item: InventoryItem, width: number) {
  const fields: [string, string | undefined][] = [];
  const { entry } = item;

  if (entry && "source" in entry) {
    fields.push(
      ["Source", entry.source],
      ["Skill path", entry.path],
      ["Revision", entry.ref],
      ["Selector", entry.skill],
      ["Install mode", entry.copy ? "Copy" : "Link"]
    );
  } else if (entry) {
    if ("package" in entry) {
      fields.push(["Package", entry.package], ["Version range", entry.version]);
    } else if ("command" in entry) {
      fields.push(["Command", entry.command]);
    } else {
      fields.push(["URL", entry.url], ["Transport", entry.transport ?? "http"]);
    }

    if ("args" in entry && entry.args?.length) {
      fields.push(["Arguments", entry.args.join(" ")]);
    }

    for (const line of describeEntry(item)) {
      if (line.startsWith("env.") || line.startsWith("headers.")) {
        const delimiter = line.indexOf(" = ");
        fields.push([
          line.slice(0, delimiter).replace("env.", "Env · ").replace("headers.", "Header · "),
          line.slice(delimiter + 3),
        ]);
      }
    }
  }

  fields.push(
    ["Harnesses", item.harnesses.join(", ") || "None"],
    ["Origin", item.origin === `shared:${item.name}` ? "Shared skills directory" : item.origin]
  );

  const lines = item.description
    ? [
        ...wrapDetail(item.description, width, true),
        { text: "", kind: "space" as const, labelWidth: 0 },
        { text: "Configuration", kind: "heading" as const, labelWidth: 0 },
      ]
    : [];

  return [
    ...lines,
    ...fields.flatMap(([label, value]) =>
      value === undefined
        ? []
        : wrapDetail(`${label.padEnd(14)} ${value}`, width).map((line, index) => ({
            ...line,
            labelWidth: index === 0 ? Math.max(label.length, 14) : 0,
          }))
    ),
    ...item.issues.flatMap((issue) => wrapDetail(`! ${issue}`, width)),
    ...(item.kind === "mcp"
      ? wrapDetail("Status describes configuration, not a live connection.", width)
      : []),
  ];
}

function wrapDetail(value: string, width: number, trim = false) {
  return wrapAnsi(
    stripVTControlCharacters(value).replaceAll(/[\r\n\t]/gu, " "),
    Math.max(1, width),
    {
      hard: true,
      trim,
    }
  )
    .split("\n")
    .map((text) => ({ text, kind: "text" as const, labelWidth: 0 }));
}
