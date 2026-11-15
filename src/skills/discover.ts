import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";

import { UsageError } from "#errors.ts";
import { isInside } from "#lock/hash.ts";
import type { SkillFile } from "#lock/hash.ts";
import { Ui } from "#ui.ts";
import { parseJson } from "#util/json-edit.ts";
import { readText } from "#util/read-text.ts";

/**
 * Finds the skills inside a fetched source, as skills.sh 1.8.1 does (`skills.ts`,
 * `plugin-manifest.ts`, `skills-sh-config.ts`, `frontmatter.ts` and `sanitize.ts`).
 */

/** A skill found in a source. */
export interface DiscoveredSkill {
  /** The `name` in the frontmatter. */
  name: string;
  description: string;
  /** The skill's directory. */
  dir: string;
  /** The plugin that groups the skill, from a Claude plugin manifest. */
  pluginName?: string;
}

const MaxNameLength = 255;
const SkippedDirs = new Set(["node_modules", ".git", "dist", "build", "__pycache__"]);
const RootDepth = 1;
const ContainerDepth = 3;
const FallbackDepth = 5;

/**
 * The project skill directories of every harness that skills.sh knows, searched during discovery.
 * A source repository that has its own skills installed keeps them in one of these.
 */
const AgentSkillDirs = [
  ".adal/skills",
  ".agents/skills",
  ".aider-desk/skills",
  ".augment/skills",
  ".autohand/skills",
  ".bob/skills",
  ".claude/skills",
  ".cline/skills",
  ".codeartsdoer/skills",
  ".codebuddy/skills",
  ".codemaker/skills",
  ".codestudio/skills",
  ".codex/skills",
  ".commandcode/skills",
  ".continue/skills",
  ".cortex/skills",
  ".crush/skills",
  ".devin/skills",
  ".factory/skills",
  ".forge/skills",
  ".github/skills",
  ".goose/skills",
  ".grok/skills",
  ".hermes/skills",
  ".iflow/skills",
  ".inferencesh/skills",
  ".jazz/skills",
  ".junie/skills",
  ".kilo/skills",
  ".kilocode/skills",
  ".kimchi/skills",
  ".kiro/skills",
  ".kode/skills",
  ".lingma/skills",
  ".mcpjam/skills",
  ".minimax/skills",
  ".moxby/skills",
  ".mux/skills",
  ".neovate/skills",
  ".ona/skills",
  ".opencode/skills",
  ".openhands/skills",
  ".pi/skills",
  ".pochi/skills",
  ".posit/assistant/skills",
  ".qoder/skills",
  ".qwen/skills",
  ".reasonix/skills",
  ".roo/skills",
  ".rovodev/skills",
  ".tabnine/agent/skills",
  ".terramind/skills",
  ".tinycloud/skills",
  ".trae/skills",
  ".vibe/skills",
  ".windsurf/skills",
  ".zcode/skills",
  ".zencoder/skills",
  "agent/skills",
  "data/skills",
];

const FrontmatterSchema = z.looseObject({
  description: z.string(),
  metadata: z
    .looseObject({ internal: z.union([z.boolean(), z.string(), z.number()]).optional() })
    .optional()
    .catch(undefined),
  name: z.string(),
});

const ManifestPathSchema = z.string().startsWith("./");

const PluginSchema = z.looseObject({
  name: z.string().optional(),
  skills: z.array(z.string()).optional(),
});

const MarketplaceSchema = z.looseObject({
  metadata: z.looseObject({ pluginRoot: z.string().optional() }).optional(),
  plugins: z
    .array(PluginSchema.extend({ source: z.union([z.string(), z.looseObject({})]).optional() }))
    .optional(),
});

const SkillsShConfigSchema = z.looseObject({ paths: z.array(z.string().catch("")) });

const SourceLockSchema = z.looseObject({ skills: z.record(z.string(), z.json()) });

/**
 * A skill name as a directory name: lowercase, every run of characters other than `a-z`, `0-9`,
 * `.` and `_` turned into one `-`, no leading or trailing `.` or `-`, at most 255 characters.
 */
export function sanitizeName(name: string) {
  const sanitized = name
    .toLowerCase()
    .replaceAll(/[^a-z0-9._]+/gu, "-")
    .replaceAll(/^[.-]+|[.-]+$/gu, "");

  return sanitized.slice(0, MaxNameLength) || "unnamed-skill";
}

/** Throws unless `name` is already a valid directory name for a skill. */
export function assertSkillName(name: string, label: string) {
  if (name === "" || sanitizeName(name) !== name) {
    throw new UsageError(
      `${label} ${JSON.stringify(name)} is not a valid skill name. Use lowercase letters, digits, ".", "_" and "-", such as ${sanitizeName(name)}.`
    );
  }
}

/** Reads the YAML frontmatter of a `SKILL.md`. Only the `---` form is read. */
export function parseFrontmatter(raw: string) {
  const match = /^\u{FEFF}?---\r?\n(?<yaml>[\s\S]*?)\r?\n---\r?\n?(?<content>[\s\S]*)$/u.exec(raw);
  const yaml = match?.groups?.yaml;

  if (yaml === undefined) {
    return { content: raw, data: undefined };
  }

  const data = FrontmatterSchema.safeParse(parseYaml(yaml));

  return { content: match?.groups?.content ?? "", data: data.success ? data.data : undefined };
}

/**
 * `raw` with its frontmatter `name` set to `name`. The old value, with any continuation lines, is
 * replaced; without one, the name is added first. Everything else stays byte for byte.
 */
export function setFrontmatterName(raw: string, name: string) {
  const match =
    /^(?<open>\u{FEFF}?---(?<eol>\r?\n))(?<body>[\s\S]*?)(?<close>\r?\n---(?:\r?\n|$))/u.exec(raw);

  const groups = match?.groups;

  if (!match || groups?.open === undefined || groups.body === undefined) {
    return raw;
  }

  const nameLine = stringifyYaml({ name }).trimEnd();
  const lines = groups.body.split(/\r?\n/u);
  const index = lines.findIndex((line) => /^name\s*:/u.test(line));

  if (index === -1) {
    lines.unshift(nameLine);
  } else {
    let end = index + 1;

    while (end < lines.length && /^[ \t]/u.test(lines[end] ?? "")) {
      end += 1;
    }

    lines.splice(index, end - index, nameLine);
  }

  const head = `${groups.open}${lines.join(groups.eol)}${groups.close ?? ""}`;

  return `${head}${raw.slice(match[0].length)}`;
}

/** A renamed skill's files: its `SKILL.md` gets the new name in the frontmatter, as skills.sh installs it. */
export function renameSkillFiles(files: SkillFile[], name: string) {
  return files.map((file) => {
    if (file.path !== "SKILL.md") {
      return file;
    }

    const content = setFrontmatterName(file.content.toString("utf-8"), name);

    return { ...file, content: Buffer.from(content, "utf-8") };
  });
}

/**
 * Finds the skills under `root`, or under `subpath` inside it. When a skill in `requested` is not
 * found, the search runs again through every directory, as skills.sh does. Internal skills are
 * included when `requested` names any skill.
 */
export async function discoverSkills(
  root: string,
  options: { subpath: string | undefined; requested: string[] | undefined }
) {
  const named = (options.requested ?? []).filter((name) => name !== "*");
  const includeInternal = named.length > 0 || isInternalSkillsEnabled();
  const found = await searchSkills(root, options.subpath, { fullDepth: false, includeInternal });
  const isMissing = named.some((name) => filterSkills(found, [name]).length === 0);

  if (!isMissing) {
    return found;
  }

  return await searchSkills(root, options.subpath, { fullDepth: true, includeInternal });
}

/** The skills that `names` select: an exact name first, then a name that differs only in case or separators. */
export function filterSkills(skills: DiscoveredSkill[], names: string[]) {
  const selected = new Set(
    names.flatMap((input) => {
      const exact = skills.filter((skill) => skill.name.toLowerCase() === input.toLowerCase());

      return exact.length > 0
        ? exact
        : skills.filter((skill) => normalizeSkillName(skill.name) === normalizeSkillName(input));
    })
  );

  return skills.filter((skill) => selected.has(skill));
}

/** Removes terminal escape sequences and collapses line breaks, for untrusted text in output. */
export function sanitizeMetadata(value: string) {
  return stripTerminalEscapes(value)
    .replaceAll(/[\r\n]+/gu, " ")
    .trim();
}

interface SearchOptions {
  fullDepth: boolean;
  includeInternal: boolean;
}

/**
 * Candidate directories are found in priority order. They are read in parallel, then kept in that
 * order, so the first skill of a name wins, as in skills.sh.
 */
async function searchSkills(root: string, subpath: string | undefined, options: SearchOptions) {
  const searchPath = subpath ? path.join(root, subpath) : root;

  if (!isInside(path.resolve(root), path.resolve(searchPath))) {
    throw new UsageError(`The path ${subpath} leaves the source.`);
  }

  const [lockedNames, plugins] = await Promise.all([
    readSourceLockNames(root),
    readPlugins(searchPath),
  ]);

  const groupings = getPluginGroupings(searchPath, plugins);
  const reads = new Map<string, Promise<DiscoveredSkill | undefined>>();

  const read = (dir: string) => {
    const key = path.resolve(dir);
    const pending = reads.get(key) ?? readSkill(dir, options.includeInternal);
    reads.set(key, pending);

    return pending;
  };

  const isInstalledCopy = (skill: DiscoveredSkill) => {
    const relative = path.relative(root, skill.dir).split(path.sep).join("/");

    const isInAgentDir = AgentSkillDirs.some(
      (dir) => relative === dir || relative.startsWith(`${dir}/`)
    );

    return (
      isInAgentDir &&
      (lockedNames.has(normalizeSkillName(skill.name)) ||
        lockedNames.has(normalizeSkillName(path.basename(skill.dir))))
    );
  };

  const skills: DiscoveredSkill[] = [];

  const keep = async (dirs: string[]) => {
    const found = await Promise.all(dirs.map(read));

    for (const skill of found) {
      const isNew = skill !== undefined && skills.every((kept) => kept.name !== skill.name);

      if (isNew && !isInstalledCopy(skill)) {
        const pluginName = groupings.get(path.resolve(skill.dir));
        skills.push(pluginName === undefined ? skill : { ...skill, pluginName });
      }
    }
  };

  // A path that points at a skill installs that skill alone.
  if (await hasSkillFile(searchPath)) {
    await keep([searchPath]);

    if (skills.length > 0 && !options.fullDepth) {
      return skills;
    }
  }

  const containers = [
    "skills",
    "skills/.curated",
    "skills/.experimental",
    "skills/.system",
    ...AgentSkillDirs,
  ].map((dir) => path.join(searchPath, dir));

  // The source root is searched one level deep, so `examples/x/SKILL.md` is not found there.
  const candidates = await Promise.all([
    findChildSkillDirs(searchPath, RootDepth),
    ...[...containers, ...(await getSkillsShDirs(searchPath))].map((dir) =>
      findChildSkillDirs(dir, ContainerDepth)
    ),
    ...getPluginSkillDirs(searchPath, plugins).map((dir) => findChildSkillDirs(dir, RootDepth)),
  ]);

  await keep(candidates.flat());

  if (skills.length === 0 || options.fullDepth) {
    await keep(await findAllSkillDirs(searchPath, 0));
  }

  return skills;
}

/** Sub-directories of `dir` that hold a `SKILL.md`. The search stops below a skill. */
async function findChildSkillDirs(dir: string, maxDepth: number, depth = 1): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);

  const found = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const child = path.join(dir, entry.name);

        if (await hasSkillFile(child)) {
          return [child];
        }

        const canDescend = depth < maxDepth && !SkippedDirs.has(entry.name);

        return canDescend ? await findChildSkillDirs(child, maxDepth, depth + 1) : [];
      })
  );

  return found.flat();
}

/** Every directory with a `SKILL.md`, up to five levels deep. */
async function findAllSkillDirs(dir: string, depth: number): Promise<string[]> {
  if (depth > FallbackDepth) {
    return [];
  }

  const [isSkill, entries] = await Promise.all([
    hasSkillFile(dir),
    readdir(dir, { withFileTypes: true }).catch(() => []),
  ]);

  const children = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && !SkippedDirs.has(entry.name))
      .map((entry) => findAllSkillDirs(path.join(dir, entry.name), depth + 1))
  );

  return [...(isSkill ? [dir] : []), ...children.flat()];
}

async function readSkill(dir: string, includeInternal: boolean) {
  const file = path.join(dir, "SKILL.md");
  const label = sanitizeMetadata(file);
  let parsed: ReturnType<typeof parseFrontmatter>;

  try {
    parsed = parseFrontmatter(await readFile(file, "utf-8"));
  } catch (error) {
    const reason = error instanceof Error ? error.message : "it cannot be read";
    Ui.warn(`Skipped ${label}: ${sanitizeMetadata(reason)}`);

    return;
  }

  if (parsed.data === undefined) {
    Ui.warn(`Skipped ${label}: the frontmatter needs a "name" and a "description".`);

    return;
  }

  const name = sanitizeMetadata(parsed.data.name);
  const description = sanitizeMetadata(parsed.data.description);

  if (!name || !description) {
    Ui.warn(`Skipped ${label}: the frontmatter "name" or "description" is empty.`);

    return;
  }

  // skills.sh accepts "true" and "1" besides true: the spec types metadata values as strings.
  const internal = parsed.data.metadata?.internal;
  const isInternal = internal === true || internal === "true" || internal === "1";

  if (isInternal && !includeInternal) {
    return;
  }

  const skill: DiscoveredSkill = { description, dir, name };

  return skill;
}

function isInternalSkillsEnabled() {
  const value = process.env.INSTALL_INTERNAL_SKILLS;

  return value === "1" || value === "true";
}

async function hasSkillFile(dir: string) {
  try {
    const stats = await stat(path.join(dir, "SKILL.md"));

    return stats.isFile();
  } catch {
    return false;
  }
}

/** Skills in the source's own `skills-lock.json`: skills it has installed, not ones it publishes. */
async function readSourceLockNames(root: string) {
  const value = await readJsonFile(path.join(root, "skills-lock.json"));
  const result = SourceLockSchema.safeParse(value);
  const names = result.success ? Object.keys(result.data.skills) : [];

  return new Set(names.map(normalizeSkillName));
}

/** The extra skill directories that the source's `skills.sh.json` names in `paths`. */
async function getSkillsShDirs(root: string) {
  const result = SkillsShConfigSchema.safeParse(
    await readJsonFile(path.join(root, "skills.sh.json"))
  );

  const paths = result.success ? result.data.paths : [];

  const normalized = paths.flatMap((entry) => {
    // A backslash is not a separator on POSIX, so it is refused instead of read as one on Windows.
    if (!entry.startsWith("./") || entry.includes("\\")) {
      return [];
    }

    const clean = path.posix.normalize(entry).replace(/\/+$/u, "");
    const isOutside = clean === "." || clean === "" || clean === ".." || clean.startsWith("../");

    return isOutside || path.posix.isAbsolute(clean) ? [] : [clean];
  });

  return [...new Set(normalized)].map((entry) => path.join(root, entry));
}

interface Plugin {
  base: string;
  name: string | undefined;
  skills: string[];
}

/** The plugins that `.claude-plugin/marketplace.json` and `.claude-plugin/plugin.json` declare. */
async function readPlugins(root: string): Promise<Plugin[]> {
  const [marketplaceValue, pluginValue] = await Promise.all([
    readJsonFile(path.join(root, ".claude-plugin/marketplace.json")),
    readJsonFile(path.join(root, ".claude-plugin/plugin.json")),
  ]);

  const marketplace = MarketplaceSchema.safeParse(marketplaceValue);
  const plugin = PluginSchema.safeParse(pluginValue);
  const pluginRoot = marketplace.data?.metadata?.pluginRoot;
  const isValidRoot = pluginRoot === undefined || ManifestPathSchema.safeParse(pluginRoot).success;
  const listed = isValidRoot ? (marketplace.data?.plugins ?? []) : [];

  const fromMarketplace = listed.flatMap((entry) => {
    const source = entry.source ?? "";

    // A remote plugin is not part of this source.
    if (entry.source !== undefined && !ManifestPathSchema.safeParse(source).success) {
      return [];
    }

    const base = path.join(root, pluginRoot ?? "", ManifestPathSchema.parse(source || "./"));

    return [{ base, name: entry.name, skills: entry.skills ?? [] }];
  });

  const fromPlugin = plugin.success
    ? [{ base: root, name: plugin.data.name, skills: plugin.data.skills ?? [] }]
    : [];

  return [...fromMarketplace, ...fromPlugin].filter((entry) =>
    isInside(path.resolve(root), path.resolve(entry.base))
  );
}

/** Directories that hold the skills of declared plugins. */
function getPluginSkillDirs(root: string, plugins: Plugin[]) {
  return plugins.flatMap((plugin) => [
    ...plugin.skills
      .filter((skill) => skill.startsWith("./"))
      .map((skill) => path.dirname(path.join(plugin.base, skill)))
      .filter((dir) => isInside(path.resolve(root), path.resolve(dir))),
    path.join(plugin.base, "skills"),
  ]);
}

/** Skill directory to plugin name, for plugins that list their skills. */
function getPluginGroupings(root: string, plugins: Plugin[]) {
  const pairs = plugins.flatMap((plugin) => {
    const { name } = plugin;

    if (name === undefined) {
      return [];
    }

    return plugin.skills.flatMap((skill) => {
      const dir = path.resolve(plugin.base, skill);
      const isValid = skill.startsWith("./") && isInside(path.resolve(root), dir);

      return isValid ? [[dir, name] as const] : [];
    });
  });

  return new Map(pairs);
}

async function readJsonFile(file: string) {
  const text = await readText(file);

  if (text === undefined) {
    return;
  }

  try {
    return parseJson(text, file);
  } catch {
    // An unreadable manifest is ignored, as if it were absent.
  }
}

/** A name compared without case, and with spaces and `_` as `-`. */
export function normalizeSkillName(name: string) {
  return name.toLowerCase().replaceAll(/[\s_]+/gu, "-");
}

const Escape = 0x1b;
const Bell = 0x07;
const Tab = 0x09;
const LineFeed = 0x0a;
const Backslash = 0x5c;
const Delete = 0x7f;
const FirstPrintable = 0x20;
const LastPrintable = 0x7e;
const FirstFinalByte = 0x40;
const FirstC1 = 0x80;
const LastC1 = 0x9f;

/**
 * Removes terminal escape sequences (CSI, OSC, DCS, PM, APC and two-byte escapes), C1 control
 * codes and control characters other than tab and line feed.
 */
function stripTerminalEscapes(value: string) {
  const codes = [...value].map((char) => char.codePointAt(0) ?? 0);
  const kept: number[] = [];
  let index = 0;

  while (index < codes.length) {
    const code = codes[index] ?? 0;

    if (code === Escape) {
      index = skipEscape(codes, index);
      continue;
    }

    const isControl =
      (code < FirstPrintable && code !== Tab && code !== LineFeed) || code === Delete;

    const isC1 = code >= FirstC1 && code <= LastC1;

    if (!isControl && !isC1) {
      kept.push(code);
    }

    index += 1;
  }

  return String.fromCodePoint(...kept);
}

/** The index after the escape sequence that starts at `start`. */
function skipEscape(codes: number[], start: number) {
  const kind = String.fromCodePoint(codes[start + 1] ?? 0);

  if (kind === "[") {
    const end = codes.findIndex(
      (code, index) => index > start + 1 && code >= FirstFinalByte && code <= LastPrintable
    );

    return end === -1 ? codes.length : end + 1;
  }

  if (kind === "]" || kind === "P" || kind === "^" || kind === "_") {
    const end = codes.findIndex((code, index) => {
      const isBell = kind === "]" && code === Bell;
      const isTerminator = code === Escape && codes[index + 1] === Backslash;

      return index > start + 1 && (isBell || isTerminator);
    });

    if (end === -1) {
      return start + 1;
    }

    return codes[end] === Bell ? end + 1 : end + 2;
  }

  const next = codes[start + 1] ?? 0;

  return next >= FirstPrintable && next <= LastPrintable ? start + 2 : start + 1;
}
