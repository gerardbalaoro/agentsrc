import { render, useApp, useInput, useWindowSize } from "ink";
import type { Key } from "ink";
import { useEffect, useReducer, useRef, useState } from "react";

import type { HarnessId } from "#harness/ids.ts";
import { createAddForm, discoverAdditions } from "#interactive/add.ts";
import type { AddForm } from "#interactive/add.ts";
import { applyBatch, errorMessage, prepareBatch } from "#interactive/batch.ts";
import type { Batch, BatchAction } from "#interactive/batch.ts";
import { detailLayout, detailLines, entryActions, targetActions } from "#interactive/details.ts";
import { formInput, movement } from "#interactive/input.ts";
import { availableHarnesses, readInventory } from "#interactive/inventory.ts";
import type { EntryKind, Inventory } from "#interactive/inventory.ts";
import { selectEntries } from "#interactive/selection.ts";
import { SessionView, pageLines } from "#interactive/view.tsx";
import type { Page } from "#interactive/view.tsx";

interface ManagerProps {
  initialGlobal: boolean;
  cwd: string;
}

/** Runs in an alternate screen; domain operations never write over the renderer. */
export async function launchManager(initialGlobal: boolean, cwd = process.cwd()) {
  const app = render(<Manager initialGlobal={initialGlobal} cwd={cwd} />, {
    alternateScreen: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });

  try {
    await app.waitUntilExit();
  } finally {
    app.unmount();
  }
}

export function Manager({ initialGlobal, cwd }: ManagerProps) {
  const { exit } = useApp();
  const { columns, rows } = useWindowSize();
  const [global, setGlobal] = useState(initialGlobal);
  const [inventory, setInventory] = useState<Inventory>();
  const [tab, setTab] = useState<EntryKind>("skills");
  const [cursor, setCursor] = useState(0);
  const [selected, select] = useReducer(selectEntries, new Set<string>());
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [harness, setHarness] = useState<HarnessId>();
  const [page, setPage] = useState<Page>({ kind: "browse" });

  const history = useRef<Page[]>([]);

  const tabViews = useRef<Record<EntryKind, { cursor: number; query: string }>>({
    skills: { cursor: 0, query: "" },
    mcp: { cursor: 0, query: "" },
  });

  const [message, setMessage] = useState("Loading inventory…");
  const [busy, setBusy] = useState(true);
  const running = useRef(false);
  const mounted = useRef(true);

  const visible =
    inventory?.items.filter(
      (item) =>
        item.kind === tab &&
        `${item.name} ${item.source}`.toLowerCase().includes(query.toLowerCase()) &&
        (!harness || item.harnesses.includes(harness))
    ) ?? [];

  const index = Math.min(cursor, Math.max(0, visible.length - 1));
  const focused = visible[index];
  const marked = inventory?.items.filter((item) => selected.has(item.id)) ?? [];
  const height = Math.max(8, rows - 10);

  useEffect(() => {
    mounted.current = true;

    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    let active = true;
    running.current = true;
    setBusy(true);

    async function load() {
      try {
        const next = await readInventory(global, cwd);

        if (active) {
          setInventory(next);
          setMessage(
            next.warnings.at(-1) ?? "Space marks entries; Enter inspects the focused entry."
          );
        }
      } catch (error) {
        if (active) {
          setMessage(errorMessage(error));
        }
      } finally {
        if (active) {
          running.current = false;
          setBusy(false);
        }
      }
    }

    void load();

    return () => {
      active = false;
    };
  }, [global, cwd]);

  async function task(label: string, work: () => Promise<void>) {
    if (running.current) {
      return;
    }

    running.current = true;
    setBusy(true);
    setMessage(label);

    try {
      await work();
    } catch (error) {
      if (mounted.current) {
        setMessage(errorMessage(error));
      }
    } finally {
      if (mounted.current) {
        running.current = false;
        setBusy(false);
      }
    }
  }

  function open(next: Page) {
    history.current.push(page);
    setPage(next);
  }

  async function preview(
    action: BatchAction,
    items = marked.length ? marked : visible.slice(index, index + 1)
  ) {
    if (!inventory) {
      return;
    }

    await task("Preparing batch; fetching and resolving sources…", async () => {
      const batch = await prepareBatch(inventory, action, items);

      if (mounted.current) {
        const next = { kind: "preview", batch, offset: 0 } as const;

        if (page.kind === "preview") {
          setPage(next);
        } else {
          open(next);
        }

        setMessage(
          batch.problems.length
            ? "Resolve every blocked entry before applying."
            : "Review the plan. Enter applies; Escape returns without changes."
        );
      }
    });
  }

  async function apply(batch: Batch) {
    await task("Applying batch…", async () => {
      const results = await applyBatch(batch, (event) => {
        if (mounted.current) {
          setMessage(event.text);
        }
      });

      if (!mounted.current) {
        return;
      }

      if (batch.action !== "sync") {
        select({
          kind: "completed",
          ids: results.filter((result) => result.status === "success").map((result) => result.id),
        });
      }

      history.current = [];
      setPage({ kind: "results", results, offset: 0 });
      const next = await readInventory(global, cwd);

      if (mounted.current) {
        setInventory(next);

        // A partially completed import can become a managed entry with a new inventory id.
        for (const result of results.filter((item) => item.status === "failed")) {
          const previous = batch.entries.find((entry) => entry.item.id === result.id)?.item;

          const replacement = next.items.find(
            (item) => item.kind === previous?.kind && item.name === previous.name
          );

          if (
            previous &&
            selected.has(previous.id) &&
            replacement &&
            replacement.id !== result.id
          ) {
            select({ kind: "completed", ids: [result.id] });
            select({ kind: "all", ids: [replacement.id] });
          }
        }

        setMessage(
          batch.action === "sync"
            ? "Scope sync finished. Review the results above."
            : "Completed entries are unmarked. Failed entries remain selected for retry."
        );
      }
    });
  }

  function switchTab(next: EntryKind) {
    tabViews.current[tab] = { cursor, query };
    setTab(next);
    setCursor(tabViews.current[next].cursor);
    setQuery(tabViews.current[next].query);
    setSearching(false);
  }

  function quit() {
    if (running.current) {
      setMessage("An operation is running. Wait for its result before exiting.");

      return;
    }

    exit();
  }

  function escape() {
    if (searching) {
      setSearching(false);
    } else if (page.kind !== "browse") {
      setPage(history.current.pop() ?? { kind: "browse" });
      setMessage("");
    } else if (query) {
      setQuery("");
      setCursor(0);
    } else {
      select({ kind: "clear" });
    }
  }

  async function submitForm(form: AddForm) {
    if (!inventory) {
      return;
    }

    await task("Discovering source…", async () => {
      const additions = await discoverAdditions(form, inventory.workspace, cwd);

      if (form.kind === "skills") {
        open({
          kind: "discover",
          cursor: 0,
          items: additions,
          selected: new Set(additions.length === 1 ? additions.map((item) => item.id) : []),
        });
        setMessage("Space marks skills; A marks all. Enter previews the selected additions.");
      } else {
        const batch = await prepareBatch(inventory, "add", additions);
        open({ kind: "preview", batch, offset: 0 });
        setMessage("Enter applies this addition; Escape cancels.");
      }
    });
  }

  function selectSkills(ids: string[]) {
    if (page.kind === "discover") {
      setPage({ ...page, selected: new Set(ids) });
    }
  }

  function submitSkills() {
    if (page.kind === "discover" && !busy) {
      void preview(
        "add",
        page.items.filter((item) => page.selected.has(item.id))
      );
    }
  }

  function editField(value: string) {
    if (page.kind === "form") {
      const fields = page.form.fields.map((field, fieldIndex) =>
        fieldIndex === page.form.index ? { ...field, value } : field
      );

      setPage({ kind: "form", form: { ...page.form, fields } });
    }
  }

  function documentInput(
    input: string,
    key: Key,
    document: Exclude<Page, { kind: "browse" | "form" | "discover" | "actions" }>
  ) {
    if (document.kind === "details") {
      const actions = entryActions(document.item);

      if (key.return || input === "m") {
        open({ kind: "actions", items: [document.item], index: 0, batch: false, hidden: 0 });

        return;
      }

      const action = actions.find((item) => item.key === input);

      if (action) {
        void preview(action.action, [document.item]);

        return;
      }

      const layout = detailLayout(columns, height);
      const delta = movement(key, layout.rows);

      if (delta) {
        setPage({
          ...document,
          offset: Math.max(
            0,
            Math.min(
              detailLines(document.item, layout.width).length - layout.rows,
              document.offset + delta
            )
          ),
        });
      }

      return;
    }

    if (document.kind === "preview") {
      if (key.return && !document.batch.problems.length) {
        void apply(document.batch);

        return;
      }

      if (input === "e" && document.batch.problems.length) {
        void preview(
          document.batch.action,
          document.batch.entries.filter((entry) => !entry.problem).map((entry) => entry.item)
        );

        return;
      }
    }

    const delta = movement(key, height);

    if (delta) {
      setPage({
        ...document,
        offset: Math.max(
          0,
          Math.min(pageLines(document, columns - 6).length - height + 2, document.offset + delta)
        ),
      });
    }
  }

  function search(value: string) {
    setQuery(value);
    setCursor(0);
  }

  function switchScope() {
    select({ kind: "scope" });
    tabViews.current = { skills: { cursor: 0, query: "" }, mcp: { cursor: 0, query: "" } };
    setInventory(undefined);
    setCursor(0);
    setQuery("");
    setHarness(undefined);
    setGlobal((value) => !value);
    setMessage("Switching scope; selection cleared.");
  }

  function filterHarness() {
    const choices: (HarnessId | undefined)[] = [undefined, "claude-code", "codex", "opencode"];
    setHarness(choices[(choices.indexOf(harness) + 1) % choices.length]);
    setCursor(0);
  }

  async function refresh() {
    await task("Refreshing inventory…", async () => {
      const next = await readInventory(global, cwd);
      setInventory(next);
      setMessage(next.warnings.at(-1) ?? "Inventory refreshed.");
    });
  }

  function add() {
    if (!inventory) {
      return;
    }

    open({ kind: "form", form: createAddForm(tab, availableHarnesses(inventory.workspace)) });
    setMessage("Tab moves between fields. Enter on the last field continues. Escape cancels.");
  }

  function sync() {
    if (!inventory) {
      return;
    }

    const items = inventory.items.filter((item) => item.declared || item.managed);
    void preview("sync", items);
  }

  function browseInput(input: string, key: Key) {
    if (searching) {
      return;
    }

    const delta = movement(key, Math.max(1, Math.floor((height - 1) / 2)));

    if (delta) {
      setCursor(Math.max(0, Math.min(visible.length - 1, index + delta)));

      return;
    }

    if (key.tab || key.leftArrow || key.rightArrow) {
      switchTab(tab === "skills" ? "mcp" : "skills");

      return;
    }

    if (key.return && focused) {
      open({ kind: "details", item: focused, offset: 0 });
      setMessage("");

      return;
    }

    const shortcuts = {
      q: quit,
      g: switchScope,
      "1": () => switchTab("skills"),
      "2": () => switchTab("mcp"),
      " ": () => {
        if (focused) {
          select({ kind: "toggle", id: focused.id });
        }
      },
      A: () => select({ kind: "all", ids: visible.map((item) => item.id) }),
      c: () => select({ kind: "clear" }),
      "/": () => setSearching(true),
      "?": () => open({ kind: "help", offset: 0 }),
      m: () => {
        const items = marked.length ? marked : visible.slice(index, index + 1);

        if (items.length) {
          const hidden = marked.filter((item) => !visible.includes(item)).length;
          open({ kind: "actions", items, index: 0, batch: marked.length > 0, hidden });
        }
      },
      h: filterHarness,
      f: () => {
        void refresh();
      },
      a: add,
      s: sync,
      u: () => {
        void preview("update");
      },
      r: () => {
        void preview("repair");
      },
      d: () => {
        void preview("remove");
      },
      i: () => {
        void preview("import");
      },
    };

    const shortcut = Object.entries(shortcuts).find(([name]) => name === input)?.[1];
    shortcut?.();
  }

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      quit();

      return;
    }

    if (busy) {
      return;
    }

    if (key.escape) {
      escape();

      return;
    }

    switch (page.kind) {
      case "actions": {
        const actions = targetActions(page.items);

        const action = key.return
          ? actions[page.index]
          : actions.find((item) => item.key === input);

        if (action) {
          void preview(action.action, page.items);
        } else if (key.upArrow || key.downArrow) {
          const delta = key.upArrow ? -1 : 1;
          setPage({ ...page, index: (page.index + delta + actions.length) % actions.length });
        }

        return;
      }

      case "form": {
        if (!(key.tab || key.upArrow || key.downArrow || key.return)) {
          return;
        }

        const next = formInput(page.form, key);

        if (next.submit) {
          void submitForm(next.form);
        } else {
          setPage({ kind: "form", form: next.form });
        }

        return;
      }

      case "discover": {
        if (input === "A") {
          selectSkills(page.items.map((item) => item.id));
        }

        return;
      }

      case "browse": {
        browseInput(input, key);

        return;
      }

      default: {
        documentInput(input, key, page);
      }
    }
  });

  return (
    <SessionView
      actions={{
        search,
        finishSearch: () => setSearching(false),
        editField,
        selectSkills,
        focusSkill: (skillCursor) => {
          if (page.kind === "discover") {
            setPage({ ...page, cursor: skillCursor });
          }
        },
        submitSkills,
      }}
      state={{
        global,
        root: inventory?.workspace.scope.root ?? cwd,
        columns,
        rows,
        height,
        tab,
        harness,
        query,
        searching,
        visible,
        focused,
        marked,
        selected,
        index,
        page,
        busy,
        message,
      }}
    />
  );
}
