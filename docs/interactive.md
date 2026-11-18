# Interactive Mode

```bash
arc ui
arc ui -g
```

Use the keyboard to manage one project or your global setup. Browsing and selection do not change
manifests or installed entries. Colors use your terminal palette; set `NO_COLOR=1` to disable them.
Imports take ownership explicitly, including entries already installed by another tool.

| Key                | Action                                                                           |
| ------------------ | -------------------------------------------------------------------------------- |
| Space              | Mark or unmark the focused entry.                                                |
| Shift+A            | Mark every entry matching the current view.                                      |
| Tab, ←, →, 1, 2    | Switch between Skills and MCPs. Selection stays across tabs.                     |
| `/`                | Search. Hidden selected entries stay in the batch.                               |
| `h`                | Filter the view by harness. This does not limit batch destinations.              |
| `u`, `r`, `i`, `d` | Preview an update, repair, import, or removal for the marked or focused entries. |
| `a`                | Add skills from a source, or configure an MCP server.                            |
| `s`                | Preview synchronization of the whole scope, including orphaned managed entries.  |
| `g`                | Switch project/global scope and clear selection.                                 |
| `c`, `f`           | Clear selection or refresh inventory.                                            |
| Enter              | Inspect an entry, or approve the open batch preview.                             |
| Escape             | Close the current screen, clear search, or clear selection.                      |
| `?`, `q`           | Show help or quit.                                                               |

Press Enter to inspect an entry and use the arrow keys to scroll. Press Enter again to open its
Actions menu. From the list, press `m` to open Actions for the marked entries or the focused entry
when nothing is marked. Escape returns to the screen that opened the preview. Each tab remembers its
filter and cursor. Whole-scope sync keeps your marks.

A batch can contain both skills and MCPs. Preview lists the selected entries, affected paths,
resolved versions or hashes, and ownership changes. Use arrows or Page Up/Page Down to read long
plans. Blocked entries prevent application; press `e` to keep only eligible entries and prepare
another preview.

Files changed after preview require a refresh and a new plan. Results report each entry separately;
failed operations can leave partial changes. Successful entries are unmarked, and failed entries
stay selected. Read each failure before retrying. Wait for an active operation to finish before
quitting.

Use Tab or Shift+Tab to move between form fields, and Ctrl+U to clear a field.

MCP forms accept JSON arrays for arguments and JSON objects for environment values and headers. Use
references such as `${TOKEN}` for secrets. Literal credentials are stored as supplied.
