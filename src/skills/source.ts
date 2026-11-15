import path from "node:path";

import { UsageError } from "#errors.ts";
import { isLocalPath, resolveLocalPath } from "#util/local-path.ts";

/**
 * Source strings, parsed as `skills add` parses them (skills.sh 1.8.1, `source-parser.ts`).
 */

export type SourceType = "local" | "github" | "gitlab" | "git" | "download" | "well-known";

export interface ParsedSource {
  type: SourceType;
  /** The clone or download URL, or the absolute path of a local source. */
  url: string;
  ref?: string;
  /** A path inside the source. */
  subpath?: string;
  /** A skill named in the source string, as in `owner/repo@skill`. */
  skillFilter?: string;
}

const DefaultGitHubHost = "github.com";

// Common shorthands that skills.sh maps to their canonical repository.
const SourceAliases = new Map([
  ["coinbase/agentWallet", "coinbase/agentic-wallet-skills"],
  ["vercel-labs/vercel-skills", "vercel-labs/agent-skills"],
]);

/** Parses a source string. A relative local path resolves against `cwd`. */
export function parseSource(input: string, options: { cwd: string }): ParsedSource {
  if (isLocalPath(input)) {
    return { type: "local", url: resolveLocalPath(input, options.cwd) };
  }

  const fragment = parseFragment(input);
  const body = SourceAliases.get(fragment.input) ?? fragment.input;
  const withFragment = { ...fragment, input: body };

  return parseRemote(withFragment, options);
}

/** True for a full 40-character commit SHA. */
export function isCommitSha(ref: string) {
  return /^[0-9a-f]{40}$/iu.test(ref);
}

/** `owner/repo` (or `group/subgroup/repo`) of a Git source, or `undefined`. */
export function getOwnerRepo(parsed: ParsedSource) {
  if (parsed.type === "local" || parsed.type === "download" || parsed.type === "well-known") {
    return;
  }

  const ssh = /^git@[^:]+:(?<repoPath>.+)$/u.exec(parsed.url)?.groups?.repoPath;

  if (ssh !== undefined) {
    return toRepoPath(ssh);
  }

  const isUrl = /^(?:ssh|https?):\/\//u.test(parsed.url);

  if (!isUrl) {
    return;
  }

  const url = toUrl(parsed.url);

  return url === undefined ? undefined : toRepoPath(url.pathname.slice(1));
}

/** The `source` that a skills lock records for the source. */
export function getLockSource(parsed: ParsedSource) {
  const isSsh = parsed.url.startsWith("git@") || parsed.url.startsWith("ssh://");

  // An SSH URL stays as it is: as `owner/repo` it would be restored over HTTPS.
  if (isSsh) {
    return parsed.url;
  }

  if (/^https?:\/\//u.test(parsed.url) && getHostname(parsed.url) !== DefaultGitHubHost) {
    return parsed.url;
  }

  return getOwnerRepo(parsed) ?? parsed.url;
}

/** The `sourceType` that a skills lock records. A plain URL is downloaded. */
export function getLockSourceType(parsed: ParsedSource) {
  return parsed.type === "well-known" ? "download" : parsed.type;
}

/**
 * The `sourceUrl` that a skills lock records. The local lock keeps it only for Git and GitLab
 * sources, whose `source` alone cannot be cloned again. The global lock always keeps it.
 */
export function getLockSourceUrl(parsed: ParsedSource, lockKind: "project" | "global") {
  if (lockKind === "global" || parsed.type === "download" || parsed.type === "well-known") {
    return parsed.url;
  }

  return parsed.type === "git" || parsed.type === "gitlab" ? parsed.url : undefined;
}

/**
 * The source as a manifest records it: `owner/repo` for GitHub, a URL for other remotes, and a
 * path relative to the manifest for a local source.
 */
export function toManifestSource(parsed: ParsedSource, manifestDir: string) {
  if (parsed.type === "local") {
    const relative = path.relative(manifestDir, parsed.url).split(path.sep).join("/");

    if (path.isAbsolute(relative)) {
      return relative;
    }

    return relative.startsWith("../") || relative === ".." ? relative : `./${relative}`;
  }

  if (parsed.type === "github") {
    return getOwnerRepo(parsed) ?? parsed.url;
  }

  return parsed.url;
}

/** Rejects a path with a `..` segment, which could leave the source. */
export function sanitizeSubpath(subpath: string) {
  const segments = subpath.replaceAll("\\", "/").split("/");

  if (segments.includes("..")) {
    throw new UsageError(`The path ${subpath} leaves the source. A path cannot contain "..".`);
  }

  return subpath;
}

/** The GitHub host that `GH_HOST` selects, as the GitHub CLI reads it. */
export function getGitHubHost() {
  const configured = process.env.GH_HOST?.trim();

  if (!configured) {
    return DefaultGitHubHost;
  }

  try {
    const parsed = new URL(`https://${configured}`);

    const isPlainHost =
      !parsed.username &&
      !parsed.password &&
      !parsed.port &&
      parsed.pathname === "/" &&
      !parsed.search &&
      !parsed.hash;

    return isPlainHost ? parsed.hostname : DefaultGitHubHost;
  } catch {
    return DefaultGitHubHost;
  }
}

export function isGitHubHost(host: string) {
  const normalized = host.toLowerCase();

  return normalized === DefaultGitHubHost || normalized === getGitHubHost().toLowerCase();
}

interface Fragment {
  input: string;
  ref?: string;
  skillFilter?: string;
}

function parseRemote(fragment: Fragment, options: { cwd: string }): ParsedSource {
  const { input } = fragment;
  const prefixed = /^(?<prefix>github|gitlab):(?<rest>.+)$/u.exec(input)?.groups;

  if (prefixed?.prefix !== undefined && prefixed.rest !== undefined) {
    const expanded =
      prefixed.prefix === "github" ? prefixed.rest : `https://gitlab.com/${prefixed.rest}`;

    return parseSource(appendFragment(expanded, fragment), options);
  }

  // A raw file or a release asset is downloaded, not cloned as its repository.
  if (isHostedArtifactUrl(input)) {
    return { type: "download", url: input };
  }

  return (
    parseEnterpriseUrl(fragment) ??
    parseGitHubSshTree(input) ??
    parseGitHubUrl(fragment) ??
    parseGitLabTree(fragment) ??
    parseGitLabUrl(fragment) ??
    parseMirroredUrl(fragment) ??
    parseAzureUrl(fragment) ??
    parseShorthand(fragment) ??
    parseOtherUrl(fragment)
  );
}

/** `#ref` and `#ref@skill` after a Git source. */
function parseFragment(input: string): Fragment {
  const hashIndex = input.indexOf("#");

  if (hashIndex === -1) {
    return { input };
  }

  const body = input.slice(0, hashIndex);
  const fragment = input.slice(hashIndex + 1);

  // Other URLs keep their fragment, so a plain web URL means what it says.
  if (!fragment || !looksLikeGitSource(body)) {
    return { input };
  }

  const atIndex = fragment.indexOf("@");

  if (atIndex === -1) {
    return { input: body, ref: decodePart(fragment) };
  }

  const ref = fragment.slice(0, atIndex);
  const skillFilter = fragment.slice(atIndex + 1);

  return {
    input: body,
    ref: ref ? decodePart(ref) : undefined,
    skillFilter: skillFilter ? decodePart(skillFilter) : undefined,
  };
}

function looksLikeGitSource(input: string) {
  if (/^(?:github:|gitlab:|git@)/u.test(input) || /^ssh:\/\/.+\.git(?:$|[/?])/iu.test(input)) {
    return true;
  }

  if (/^https?:\/\//u.test(input)) {
    const url = toUrl(input);

    if (url && isGitHubHost(url.host)) {
      return /^\/[^/]+\/[^/]+(?:\.git)?(?:\/tree\/[^/]+(?:\/.*)?)?\/?$/u.test(url.pathname);
    }

    if (url?.hostname === "gitlab.com") {
      return /^\/.+?\/[^/]+(?:\.git)?(?:\/-\/tree\/[^/]+(?:\/.*)?)?\/?$/u.test(url.pathname);
    }

    if (url && (matchMirroredPath(url.pathname) || getAzureGitIndex(url.pathname) !== -1)) {
      return true;
    }
  }

  if (/^https?:\/\/.+\.git(?:$|[/?])/iu.test(input)) {
    return true;
  }

  return isShorthandLike(input) && /^[^/]+\/[^/]+(?:\/.+|@.+)?$/u.test(input);
}

function appendFragment(input: string, fragment: Fragment) {
  if (!fragment.ref && !fragment.skillFilter) {
    return input;
  }

  const ref = fragment.ref ? encodeURIComponent(fragment.ref) : "";
  const skill = fragment.skillFilter ? `@${encodeURIComponent(fragment.skillFilter)}` : "";

  return `${input}#${ref}${skill}`;
}

function isHostedArtifactUrl(input: string) {
  const url = toUrl(input);

  if (!url) {
    return false;
  }

  const host = url.hostname.toLowerCase();

  const isGitHubContentHost =
    host === "raw.githubusercontent.com" ||
    host === "codeload.github.com" ||
    host === "objects.githubusercontent.com";

  if (isGitHubContentHost) {
    return true;
  }

  if (host === "github.com") {
    return /^\/[^/]+\/[^/]+\/(?:archive\/|raw\/|releases\/(?:download\/|latest\/download\/))/u.test(
      url.pathname
    );
  }

  return host === "gitlab.com" && /\/-\/(?:archive|raw)\//u.test(url.pathname);
}

/** A GitHub Enterprise URL. It uses plain Git, because the GitHub.com shortcuts do not apply. */
function parseEnterpriseUrl(fragment: Fragment): ParsedSource | undefined {
  const url = getGitHubHost() === DefaultGitHubHost ? undefined : toHttpUrl(fragment.input);

  if (!url || !isGitHubHost(url.host) || url.host === DefaultGitHubHost) {
    return;
  }

  const [owner, rawRepo, marker, treeRef, ...rest] = url.pathname.split("/").filter(Boolean);

  if (!owner || !rawRepo) {
    return;
  }

  const repo = rawRepo.replace(/\.git$/u, "");
  const isTree = marker === "tree" && treeRef !== undefined;
  const ref = isTree ? treeRef : fragment.ref;
  const subpath = isTree && rest.length > 0 ? sanitizeSubpath(rest.join("/")) : undefined;

  return withOptional(
    { type: "git", url: `${url.protocol}//${url.host}/${owner}/${repo}.git` },
    { ref, subpath }
  );
}

/** `git@github.com:owner/repo/tree/branch[/path]` */
function parseGitHubSshTree(input: string): ParsedSource | undefined {
  const match =
    /^git@(?<host>[^:]+):(?<owner>[^/]+)\/(?<repo>[^/]+?)(?:\.git)?\/tree\/(?<ref>[^/]+)(?:\/(?<subpath>.+))?$/u.exec(
      input
    )?.groups;

  if (!match?.host || !isGitHubHost(match.host)) {
    return;
  }

  return withOptional(
    { type: "git", url: `git@${match.host}:${match.owner}/${match.repo}.git` },
    { ref: match.ref, subpath: match.subpath ? sanitizeSubpath(match.subpath) : undefined }
  );
}

/** `https://github.com/owner/repo[/tree/ref[/path]]`, matched only when github.com is the host. */
function parseGitHubUrl(fragment: Fragment): ParsedSource | undefined {
  const pathname = getPathOnHost(fragment.input, DefaultGitHubHost);

  if (pathname === undefined) {
    return;
  }

  const tree =
    /^\/(?<owner>[^/]+)\/(?<repo>[^/]+)\/tree\/(?<ref>[^/]+)(?:\/(?<subpath>.+?))?\/?$/u.exec(
      pathname
    )?.groups;

  if (tree) {
    return withOptional(
      { type: "github", url: `https://github.com/${tree.owner}/${tree.repo}.git` },
      {
        ref: tree.ref || fragment.ref,
        subpath: tree.subpath ? sanitizeSubpath(tree.subpath) : undefined,
      }
    );
  }

  const repo = /^\/(?<owner>[^/]+)\/(?<repo>[^/]+)/u.exec(pathname)?.groups;

  if (!repo?.repo) {
    return;
  }

  return withOptional(
    {
      type: "github",
      url: `https://github.com/${repo.owner}/${repo.repo.replace(/\.git$/u, "")}.git`,
    },
    { ref: fragment.ref }
  );
}

/** `https://<gitlab host>/group/repo/-/tree/ref[/path]`, on any GitLab instance. */
function parseGitLabTree(fragment: Fragment): ParsedSource | undefined {
  const match =
    /^(?<protocol>https?):\/\/(?<host>[^/]+)\/(?<repoPath>.+?)\/-\/tree\/(?<ref>[^/]+)(?:\/(?<subpath>.+))?$/u.exec(
      fragment.input
    )?.groups;

  if (!match?.repoPath || match.host === DefaultGitHubHost) {
    return;
  }

  return withOptional(
    {
      type: "gitlab",
      url: `${match.protocol}://${match.host}/${match.repoPath.replace(/\.git$/u, "")}.git`,
    },
    {
      ref: match.ref || fragment.ref,
      subpath: match.subpath ? sanitizeSubpath(match.subpath) : undefined,
    }
  );
}

/** `https://gitlab.com/group[/subgroup]/repo` */
function parseGitLabUrl(fragment: Fragment): ParsedSource | undefined {
  const pathname = getPathOnHost(fragment.input, "gitlab.com");

  const repoPath = pathname
    ? /^\/(?<repoPath>.+?)(?:\.git)?\/?$/u.exec(pathname)?.groups?.repoPath
    : undefined;

  if (!repoPath?.includes("/")) {
    return;
  }

  return withOptional(
    { type: "gitlab", url: `https://gitlab.com/${repoPath}.git` },
    { ref: fragment.ref }
  );
}

/** A proxy or mirror URL with a GitHub or GitLab repository in its path. It keeps the proxy host. */
function parseMirroredUrl(fragment: Fragment): ParsedSource | undefined {
  const url = toHttpUrl(fragment.input);
  const mirrored = url ? matchMirroredPath(url.pathname) : undefined;

  if (!url || !mirrored) {
    return;
  }

  url.pathname = `${mirrored.base}.git`;
  url.search = "";
  url.hash = "";

  return withOptional(
    { type: "git", url: url.toString() },
    {
      ref: mirrored.ref ? decodePart(mirrored.ref) : fragment.ref,
      skillFilter: fragment.skillFilter,
      subpath: mirrored.subpath ? sanitizeSubpath(decodePart(mirrored.subpath)) : undefined,
    }
  );
}

function matchMirroredPath(pathname: string) {
  const host =
    /^(?<prefix>\/(?:.*?\/)?(?:https?:\/\/?)?(?:www\.)?(?<kind>github|gitlab)\.com)(?<rest>\/.*)$/iu.exec(
      pathname
    )?.groups;

  if (!host?.prefix || !host.kind || !host.rest) {
    return;
  }

  const repo =
    host.kind.toLowerCase() === "github"
      ? /^(?<repoPath>\/[^/]+\/[^/]+?)(?:\.git)?(?:\/tree\/(?<ref>[^/]+)(?:\/(?<subpath>.+?))?)?\/?$/u.exec(
          host.rest
        )?.groups
      : /^(?<repoPath>\/[^/]+(?:\/[^/]+)*?\/[^/]+?)(?:\.git)?(?:\/-\/tree\/(?<ref>[^/]+)(?:\/(?<subpath>.+?))?)?\/?$/u.exec(
          host.rest
        )?.groups;

  if (!repo?.repoPath) {
    return;
  }

  return { base: `${host.prefix}${repo.repoPath}`, ref: repo.ref, subpath: repo.subpath };
}

/** Azure Repos on any host: `https://dev.azure.com/org/project/_git/repo?path=…&version=GB…`. */
function parseAzureUrl(fragment: Fragment): ParsedSource | undefined {
  const url = toHttpUrl(fragment.input);

  if (!url) {
    return;
  }

  const segments = url.pathname.split("/").filter(Boolean);
  const gitIndex = getAzureGitIndex(url.pathname);
  const repo = segments[gitIndex + 1]?.replace(/\.git$/u, "");

  if (gitIndex === -1 || !repo) {
    return;
  }

  const clonePath = [...segments.slice(0, gitIndex), "_git", repo]
    .map((segment) => encodeURIComponent(decodePart(segment)))
    .join("/");

  // GB is a branch and GT a tag. A commit (GC) is left out: `git clone --branch` cannot use it.
  const version = /^(?:GB|GT)(?<ref>.+)$/iu.exec(url.searchParams.get("version") ?? "")?.groups
    ?.ref;

  const pathParam = url.searchParams.get("path");

  return withOptional(
    { type: "git", url: `${url.protocol}//${url.host}/${clonePath}` },
    {
      ref: version || fragment.ref,
      skillFilter: fragment.skillFilter,
      subpath: pathParam ? sanitizeSubpath(pathParam.replace(/^\/+/u, "")) : undefined,
    }
  );
}

function getAzureGitIndex(pathname: string) {
  const segments = pathname.split("/").filter(Boolean);
  const index = segments.indexOf("_git");

  return index !== -1 && index < segments.length - 1 ? index : -1;
}

/**
 * `owner/repo`, `owner/repo/path`, `owner/repo@skill`, and `owner/repo@v1.2.3`. A version tag or a
 * full commit SHA after `@` is a ref; anything else after `@` names a skill.
 */
function parseShorthand(fragment: Fragment): ParsedSource | undefined {
  const { input } = fragment;

  if (!isShorthandLike(input)) {
    return;
  }

  const host = getGitHubHost();
  const type = host === DefaultGitHubHost ? "github" : "git";
  const atSkill = /^(?<owner>[^/]+)\/(?<repo>[^/@]+)@(?<skill>.+)$/u.exec(input)?.groups;

  if (atSkill?.skill !== undefined) {
    const url = `https://${host}/${atSkill.owner}/${atSkill.repo}.git`;
    const isPin = !fragment.ref && !fragment.skillFilter && isVersionPin(atSkill.skill);

    if (isPin) {
      return { ref: atSkill.skill, type, url };
    }

    return withOptional(
      { type, url },
      { ref: fragment.ref, skillFilter: fragment.skillFilter || atSkill.skill }
    );
  }

  const match = /^(?<owner>[^/]+)\/(?<repo>[^/]+)(?:\/(?<subpath>.+?))?\/?$/u.exec(input)?.groups;

  if (!match) {
    return;
  }

  return withOptional(
    { type, url: `https://${host}/${match.owner}/${match.repo}.git` },
    {
      ref: fragment.ref,
      skillFilter: fragment.skillFilter,
      subpath: match.subpath ? sanitizeSubpath(match.subpath) : undefined,
    }
  );
}

/** Any other HTTP(S) URL is downloaded. Anything else is a Git URL. */
function parseOtherUrl(fragment: Fragment): ParsedSource {
  const url = toHttpUrl(fragment.input);

  const isExcludedHost =
    url !== undefined &&
    ["github.com", "gitlab.com", "raw.githubusercontent.com"].includes(url.hostname);

  if (url && !isExcludedHost && !fragment.input.endsWith(".git")) {
    return { type: "well-known", url: fragment.input };
  }

  return withOptional({ type: "git", url: fragment.input }, { ref: fragment.ref });
}

function isShorthandLike(input: string) {
  return !input.includes(":") && !input.startsWith(".") && !input.startsWith("/");
}

/** A version tag (`v1.2.3`, `1.2`, with prerelease or build) or a full commit SHA. */
function isVersionPin(value: string) {
  return (
    /^v?\d+(?:\.\d+)+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(value) || isCommitSha(value)
  );
}

/** The path of `input` when its host is exactly `host` or `www.<host>`, with or without a scheme. */
function getPathOnHost(input: string, host: string) {
  const match = /^(?:https?:\/\/)?(?<authority>[^/?#]*)(?<pathname>[^?#]*)/iu.exec(input)?.groups;

  const hostname = (match?.authority ?? "")
    .replace(/^[^@]*@/u, "")
    .replace(/:\d*$/u, "")
    .toLowerCase();

  return hostname === host || hostname === `www.${host}` ? (match?.pathname ?? "") : undefined;
}

function toRepoPath(value: string) {
  const repoPath = value.replace(/\.git$/u, "");

  return repoPath.includes("/") ? repoPath : undefined;
}

function getHostname(value: string) {
  return toUrl(value)?.hostname;
}

function toUrl(value: string) {
  return URL.canParse(value) ? new URL(value) : undefined;
}

function toHttpUrl(value: string) {
  return /^https?:\/\//iu.test(value) ? toUrl(value) : undefined;
}

function decodePart(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Adds only the fields that have a value, as skills.sh does. */
function withOptional(
  base: Pick<ParsedSource, "type" | "url">,
  optional: Pick<ParsedSource, "ref" | "subpath" | "skillFilter">
): ParsedSource {
  const present = Object.entries(optional).filter(([, value]) => Boolean(value));

  return { ...base, ...Object.fromEntries(present) };
}
