# TermCN Components

Copied from the [TermCN Ink registry](https://www.termcn.dev/docs/installation),
[revision 5a02dae](https://github.com/shadcn-labs/termcn/tree/5a02dae79542add57ba392d2b51785138d0c3b6e).
TermCN distributes components as source under the included MIT license.

Imports use this project’s native subpath aliases. Unicode detection uses a Node-compatible browser
check. These files keep upstream conventions and remain typechecked.

Local adaptations in `text-input.tsx` preserve Ctrl-U clearing, ignore command modifiers, start the
cursor at the existing value’s end, normalize pasted line breaks, and scroll long values
horizontally.

The retained inputs inherit the terminal foreground and background. Selection and field controls
accept optional named color accents. Theme providers, RGB palettes, and unused framed components are
omitted. Forms use borderless inputs.
