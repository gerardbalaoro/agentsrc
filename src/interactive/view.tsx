import { stripVTControlCharacters } from "node:util";

import { Box, Text } from "ink";
import wrapAnsi from "wrap-ansi";

import type { HarnessId } from "#harness/ids.ts";
import type { AddForm } from "#interactive/add.ts";
import type { Batch, BatchResult } from "#interactive/batch.ts";
import { detailLayout, detailLines, targetActions } from "#interactive/details.ts";
import type { EntryKind, InventoryItem } from "#interactive/inventory.ts";
import { terminalWidth, truncateToTerminalWidth } from "#interactive/termcn/lib/terminal-text.ts";
import { FormField } from "#interactive/termcn/ui/form-field.tsx";
import { MultiSelect } from "#interactive/termcn/ui/multi-select.tsx";
import { TextInput } from "#interactive/termcn/ui/text-input.tsx";

export type Page =
  | { kind: "browse" }
  | { kind: "preview"; batch: Batch; offset: number }
  | { kind: "results"; results: BatchResult[]; offset: number }
  | { kind: "details"; item: InventoryItem; offset: number }
  | { kind: "actions"; items: InventoryItem[]; index: number; batch: boolean; hidden: number }
  | { kind: "help"; offset: number }
  | { kind: "form"; form: AddForm }
  | { kind: "discover"; items: InventoryItem[]; selected: Set<string>; cursor: number };

type DocumentPage = Exclude<Page, { kind: "browse" | "form" | "discover" | "actions" }>;

export interface ViewState {
  global: boolean;
  root: string;
  columns: number;
  rows: number;
  height: number;
  tab: EntryKind;
  harness: HarnessId | undefined;
  query: string;
  searching: boolean;
  visible: InventoryItem[];
  focused: InventoryItem | undefined;
  marked: InventoryItem[];
  selected: ReadonlySet<string>;
  index: number;
  page: Page;
  busy: boolean;
  message: string;
}

export interface ViewActions {
  search: (value: string) => void;
  finishSearch: () => void;
  editField: (value: string) => void;
  focusSkill: (index: number) => void;
  selectSkills: (ids: string[]) => void;
  submitSkills: () => void;
}

const StatusLabels = {
  ok: "synced",
  missing: "missing",
  modified: "modified",
  untracked: "unmanaged",
  unsupported: "unsupported",
};

const StatusColors = {
  ok: "green",
  missing: "yellow",
  modified: "yellow",
  untracked: undefined,
  unsupported: "red",
} as const;

interface Shortcut {
  key: string;
  description: string;
}

export function SessionView({ state, actions }: { state: ViewState; actions: ViewActions }) {
  if (state.columns < 48 || state.rows < 18) {
    return (
      <Box flexDirection="column">
        <Text bold color="yellow">
          More room needed
        </Text>
        <Text>Resize to at least 48 columns × 18 rows. Ctrl-C exits.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" height={state.rows} paddingX={2}>
      <SessionHeader state={state} actions={actions} />
      <Box height={state.height} flexShrink={0}>
        <PageContent state={state} actions={actions} />
      </Box>
      <SessionFooter state={state} />
    </Box>
  );
}

function SessionHeader({ state, actions }: { state: ViewState; actions: ViewActions }) {
  return (
    <>
      <Box height={1} flexShrink={0} justifyContent="space-between">
        <Text bold>Skills &amp; MCPs</Text>
        <Text>
          {state.global ? "Global" : "Project"}
          {state.page.kind === "browse" ? " · g" : ""}
        </Text>
      </Box>
      <Box height={1} flexShrink={0}>
        <Text dimColor wrap="truncate-end">
          {clean(state.root)}
        </Text>
      </Box>
      {state.page.kind === "browse" ? (
        <Box height={1} flexShrink={0} gap={3}>
          <Text
            color={state.tab === "skills" ? "cyan" : undefined}
            bold={state.tab === "skills"}
            underline={state.tab === "skills"}
            dimColor={state.tab !== "skills"}
          >
            1 Skills
          </Text>
          <Text
            color={state.tab === "mcp" ? "cyan" : undefined}
            bold={state.tab === "mcp"}
            underline={state.tab === "mcp"}
            dimColor={state.tab !== "mcp"}
          >
            2 MCPs
          </Text>
        </Box>
      ) : (
        <Box height={1} flexShrink={0} />
      )}
      <Box height={1} flexShrink={0} justifyContent="space-between">
        {state.page.kind === "browse" ? (
          <Box gap={1}>
            <Text dimColor>/</Text>
            <TextInput
              key={`${state.tab}:${state.searching}`}
              value={state.query}
              onValueChange={actions.search}
              onSubmit={actions.finishSearch}
              autoFocus={state.searching}
              isActive={state.searching && !state.busy}
              placeholder={`Search ${state.tab}`}
              bordered={false}
              paddingX={0}
              width={Math.max(12, state.columns - 30)}
              aria-label="Search entries"
            />
          </Box>
        ) : (
          <Text dimColor wrap="truncate-end">
            {state.page.kind !== "details" && "Changes are reviewed before applying"}
          </Text>
        )}
        {state.page.kind === "browse" && (
          <Text dimColor>h · {state.harness ?? "all harnesses"}</Text>
        )}
      </Box>
      <Box height={1} flexShrink={0}>
        <Text dimColor>{"─".repeat(state.columns - 4)}</Text>
      </Box>
    </>
  );
}

function SessionFooter({ state }: { state: ViewState }) {
  const hidden =
    state.marked.length - state.visible.filter((item) => state.selected.has(item.id)).length;

  const shortcuts = fitShortcuts(actionKeys(state.page, state.columns), state.columns - 4);

  return (
    <>
      <Box height={1} flexShrink={0} justifyContent="space-between">
        <Text bold color={state.marked.length ? "green" : undefined}>
          {selectionLabel(state)}
        </Text>
        <Text dimColor>{state.page.kind === "details" ? "" : `${hidden} outside view`}</Text>
      </Box>
      <Box height={1} flexShrink={0} overflow="hidden">
        <Text color={state.busy ? "yellow" : undefined} dimColor={!state.busy} wrap="truncate-end">
          {state.busy ? "Working… " : ""}
          {clean(state.message)}
        </Text>
      </Box>
      <Box height={3} flexShrink={0} paddingTop={1} flexDirection="column">
        <Text wrap="truncate-end">
          {shortcuts.map((shortcut) => `${shortcut.key} ${shortcut.description}`).join(" · ")}
        </Text>
        <Text dimColor wrap="truncate-end">
          {navigationHint(state.page)}
        </Text>
      </Box>
    </>
  );
}

function selectionLabel(state: ViewState) {
  if (state.page.kind === "details") {
    return state.marked.length ? `${state.marked.length} marked in list` : "";
  }

  return `${state.marked.length} selected`;
}

function navigationHint(page: Page) {
  if (page.kind === "details") {
    return "↑↓ scroll · enter actions";
  }

  return page.kind === "browse"
    ? "↑↓ navigate · enter details · tab switch · / search"
    : "esc back · ctrl-c exit";
}

function PageContent({ state, actions }: { state: ViewState; actions: ViewActions }) {
  const { page } = state;

  if (page.kind === "actions") {
    const target = page.batch
      ? `${page.items.length} marked ${page.items.length === 1 ? "entry" : "entries"}`
      : clean(page.items[0]?.name ?? "");

    return (
      <Box flexDirection="column" width="100%">
        <Text bold wrap="truncate-end">
          Actions for {target}
        </Text>
        {page.hidden > 0 && <Text dimColor>{page.hidden} outside this view</Text>}
        {targetActions(page.items).map((action, index) => (
          <Text key={action.key} color={index === page.index ? "cyan" : undefined}>
            {index === page.index ? "❯" : " "} {action.label} ({action.key})
          </Text>
        ))}
      </Box>
    );
  }

  if (page.kind === "browse") {
    return <InventoryView state={state} />;
  }

  if (page.kind === "form") {
    return <FormView form={page.form} state={state} onChange={actions.editField} />;
  }

  if (page.kind === "discover") {
    return (
      <Box flexDirection="column" height={state.height} width="100%">
        <Text bold color="cyan">
          Choose skills · {page.selected.size} selected
        </Text>
        <MultiSelect
          options={page.items.map((item) => ({ value: item.id, label: clean(item.name) }))}
          value={[...page.selected]}
          activeIndex={page.cursor}
          onActiveIndexChange={actions.focusSkill}
          onValueChange={actions.selectSkills}
          onSubmit={actions.submitSkills}
          autoFocus
          accentColor="cyan"
          selectionColor="green"
          isActive={!state.busy}
          height={Math.max(1, state.height - 2)}
          aria-label="Skills to add"
        />
      </Box>
    );
  }

  if (page.kind === "details") {
    return <DetailsView page={page} state={state} />;
  }

  const lines = pageLines(page, state.columns - 6);

  return (
    <Box flexDirection="column" height={state.height} width="100%">
      <Box justifyContent="space-between">
        <Text bold color="cyan">
          {pageTitle(page)}
        </Text>
        {page.kind === "preview" && (
          <Text bold color={page.batch.problems.length ? "red" : "yellow"}>
            {page.batch.problems.length ? "Blocked" : "Awaiting approval"}
          </Text>
        )}
      </Box>
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {lines.slice(page.offset, page.offset + state.height - 2).map((line, index) => (
          <Text key={index} color={lineColor(line)} wrap="truncate-end">
            {line}
          </Text>
        ))}
      </Box>
      <Text>
        ↑↓ scroll · {Math.min(lines.length, page.offset + 1)}/{lines.length}
      </Text>
    </Box>
  );
}

function DetailsView({
  page,
  state,
}: {
  page: Extract<Page, { kind: "details" }>;
  state: ViewState;
}) {
  const layout = detailLayout(state.columns, state.height);
  const lines = detailLines(page.item, layout.width);

  const configuration = (
    <Box flexDirection="column" width={layout.width}>
      {!page.item.description && <Text bold>Configuration</Text>}
      {lines.slice(page.offset, page.offset + layout.rows).map((line, index) => (
        <Box key={index} height={1} flexShrink={0}>
          <Text bold={line.kind === "heading"} color={lineColor(line.text)} wrap="truncate-end">
            <Text dimColor>{line.text.slice(0, line.labelWidth)}</Text>
            {line.text.slice(line.labelWidth)}
          </Text>
        </Box>
      ))}
    </Box>
  );

  return (
    <Box flexDirection="column" width={layout.width} height={state.height}>
      <Box justifyContent="space-between">
        <Text bold color="cyan" wrap="truncate-end">
          {clean(page.item.name)}
        </Text>
        <Text color={StatusColors[page.item.status]}>
          {page.item.kind === "skills" ? "Skill" : "MCP server"} · {StatusLabels[page.item.status]}
        </Text>
      </Box>
      <Box marginTop={1}>{configuration}</Box>
    </Box>
  );
}

function InventoryView({ state }: { state: ViewState }) {
  const count = Math.max(1, Math.floor((state.height - 1) / 2));
  const start = Math.max(0, state.index - count + 1);

  return (
    <Box flexDirection="column" height={state.height} width="100%">
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {state.visible.length ? (
          state.visible.slice(start, start + count).map((item) => {
            const focused = item.id === state.focused?.id;

            return (
              <Box key={item.id} flexDirection="column">
                <Box justifyContent="space-between">
                  <Box flexGrow={1} minWidth={0}>
                    <Text bold={focused} color={focused ? "cyan" : undefined} wrap="truncate-end">
                      {focused ? "❯" : " "}{" "}
                      <Text color={state.selected.has(item.id) ? "green" : undefined}>
                        {state.selected.has(item.id) ? "[x]" : "[ ]"}
                      </Text>{" "}
                      {clean(item.name)}
                    </Text>
                  </Box>
                  <Text color={StatusColors[item.status]} dimColor={item.status === "untracked"}>
                    {" "}
                    {StatusLabels[item.status]}
                  </Text>
                </Box>
                <Text dimColor wrap="truncate-end">
                  {"      "}
                  {item.harnesses.join(", ") || "No harnesses"} · {clean(item.origin)}
                </Text>
              </Box>
            );
          })
        ) : (
          <Box flexDirection="column">
            <Text>{state.busy ? "Loading inventory…" : "No entries match this view."}</Text>
            <Text dimColor wrap="truncate-end">
              Press a to add, / to search, or h to change the harness filter.
            </Text>
          </Box>
        )}
      </Box>
      <Text dimColor>
        {state.visible.length} shown · {state.index + Number(state.visible.length > 0)}/
        {state.visible.length}
      </Text>
    </Box>
  );
}

function FormView({
  form,
  state,
  onChange,
}: {
  form: AddForm;
  state: ViewState;
  onChange: (value: string) => void;
}) {
  const field = form.fields[form.index];

  if (!field) {
    return null;
  }

  return (
    <Box flexDirection="column" height={state.height} width="100%" gap={state.height >= 8 ? 1 : 0}>
      <Box justifyContent="space-between">
        <Text bold color="cyan">
          Add {form.kind === "skills" ? "skills" : "MCP server"}
        </Text>
        <Text dimColor>{`${field.label} · ${form.index + 1}/${form.fields.length}`}</Text>
      </Box>
      <FormField
        labelColor="cyan"
        label={field.label}
        hint={truncateToTerminalWidth(field.hint, state.columns - 6)}
      >
        <TextInput
          key={field.label}
          value={field.value}
          onValueChange={onChange}
          autoFocus
          isActive={!state.busy}
          bordered={false}
          paddingX={0}
          width={Math.min(76, state.columns - 4)}
          aria-label={field.label}
        />
      </FormField>
      {state.height >= 10 && (
        <Text>Changes are saved after you review and approve the preview.</Text>
      )}
    </Box>
  );
}

function actionKeys(page: Page, columns: number): Shortcut[] {
  if (page.kind === "actions") {
    return [
      { key: "↑↓", description: "choose" },
      { key: "enter", description: "preview" },
      { key: "esc", description: "back" },
    ];
  }

  if (page.kind === "details") {
    return [{ key: "esc", description: "back" }];
  }

  if (page.kind === "browse") {
    if (columns < 90) {
      return [
        { key: "space", description: "mark" },
        { key: "m", description: "actions" },
        { key: "?", description: "help" },
        { key: "a", description: "add" },
        { key: "q", description: "quit" },
      ];
    }

    return [
      { key: "space", description: "mark" },
      { key: "m", description: "actions" },
      { key: "u/r", description: "update/repair" },
      { key: "i/d", description: "import/remove" },
      { key: "?", description: "help" },
      { key: "a", description: "add" },
      { key: "q", description: "quit" },
    ];
  }

  if (page.kind === "preview") {
    return [
      page.batch.problems.length
        ? { key: "e", description: "keep eligible" }
        : { key: "enter", description: "apply batch" },
      { key: "esc", description: "cancel" },
    ];
  }

  if (page.kind === "form") {
    return [
      { key: "enter", description: "continue" },
      { key: "esc", description: "cancel" },
      { key: "tab", description: "next field" },
    ];
  }

  if (page.kind === "discover") {
    return [
      { key: "space", description: "mark" },
      { key: "enter", description: "preview" },
      { key: "esc", description: "back" },
      { key: "A", description: "all" },
    ];
  }

  return [
    { key: "↑↓", description: "scroll" },
    { key: "esc", description: "back" },
  ];
}

function fitShortcuts(shortcuts: Shortcut[], width: number) {
  let used = 0;

  return shortcuts.filter((shortcut) => {
    const size = terminalWidth(shortcut.key) + terminalWidth(shortcut.description) + 1;
    const total = used + size + (used ? 3 : 0);

    if (total > width) {
      return false;
    }

    used = total;

    return true;
  });
}

function clean(text: string) {
  return stripVTControlCharacters(text).replaceAll(/[\r\n\t]/gu, " ");
}

function lineColor(line: string) {
  if (line.startsWith("success · ")) {
    return "green";
  }

  if (line.startsWith("failed · ") || line.startsWith("BLOCKED:")) {
    return "red";
  }

  if (line.startsWith("! ")) {
    return "yellow";
  }
}

function pageTitle(page: DocumentPage) {
  switch (page.kind) {
    case "preview": {
      if (page.batch.action === "sync") {
        return "Preview sync · entire scope";
      }

      return `Preview ${page.batch.action} · ${page.batch.entries.length} ${page.batch.entries.length === 1 ? "entry" : "entries"}`;
    }

    case "results": {
      return "Batch results";
    }

    case "details": {
      return page.item.name;
    }

    default: {
      return "Keyboard shortcuts";
    }
  }
}

export function pageLines(page: DocumentPage, width: number) {
  if (page.kind === "details") {
    return detailLines(page.item, width).map((line) => line.text);
  }

  return documentLines(page).flatMap((line) =>
    wrapAnsi(clean(line), Math.max(1, width), { hard: true, trim: false }).split("\n")
  );
}

function documentLines(page: Exclude<DocumentPage, { kind: "details" }>) {
  if (page.kind === "results") {
    return page.results.flatMap((result) => [
      `${result.status} · ${result.name}`,
      result.message,
      "",
    ]);
  }

  if (page.kind === "help") {
    return [
      "↑↓ / PgUp / PgDn  move through entries",
      "Space             mark / unmark focused entry",
      "A                 select all matching entries",
      "c                 clear selection",
      "Tab / ←→ / 1 / 2  Skills / MCPs (selection stays)",
      "g                 switch scope (selection clears)",
      "/                 search (selection stays)",
      "h                 filter by harness",
      "Enter             inspect entry",
      "m                 actions for marked or focused entries",
      "u / r / d / i     update / repair / remove / import batch",
      "a                 add skills or an MCP server",
      "s                 preview sync for the entire scope",
      "f                 refresh inventory",
      "q / Ctrl-C        exit when no operation is running",
      "",
      "Hidden selections remain part of every batch.",
      "Imports explicitly take ownership of selected entries.",
      "Failed entries stay selected; completed entries are cleared.",
    ];
  }

  return [
    `Scope: ${page.batch.inventory.workspace.scope.root}`,
    ...page.batch.warnings.map((warning) => `! ${warning}`),
    ...page.batch.entries.flatMap((entry) => [
      "",
      `${entry.item.kind === "skills" ? "skill" : "mcp"} · ${entry.item.name}`,
      ...(entry.problem ? [`BLOCKED: ${entry.problem}`] : entry.lines.map((line) => `  ${line}`)),
    ]),
    "",
    ...(page.batch.problems.length
      ? [`${page.batch.problems.length} blocked. Nothing will be silently skipped.`]
      : [
          "Enter approves this exact prepared batch.",
          "Each entry reports its own result; failures may leave partial changes.",
        ]),
  ];
}
