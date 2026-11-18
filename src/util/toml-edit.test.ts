import { expect, test } from "bun:test";

import { parseToml, removeTomlValue, setTomlValue } from "#util/toml-edit.ts";

const Manifest = `# shared tools
agents = ["codex"]

[skills]
# pinned on purpose
pdf = { source = "anthropics/skills", ref = "v1.2.0" }

# the team tracker
[mcp.linear]
url = "https://mcp.linear.app/mcp"
`;

test("a new server becomes its own section when the parent table is implicit", () => {
  const server = { command: "node", args: ["./db.js"], env: { TOKEN: "${TOKEN}" } };
  const text = setTomlValue(Manifest, ["mcp", "db"], server, { sectionDepth: 2 });

  expect(text).toBe(`${Manifest}
[mcp.db]
command = "node"
args = ["./db.js"]
env = {TOKEN = "\${TOKEN}"}
`);
});

test("a new server in a file with no parent table gets no empty parent header", () => {
  const text = setTomlValue(
    `model = "x"\n`,
    ["mcp_servers", "db"],
    { command: "node" },
    {
      sectionDepth: 2,
    }
  );

  expect(text).toBe(`model = "x"\n\n[mcp_servers.db]\ncommand = "node"\n`);
});

test("a new server is written into an empty file", () => {
  const text = setTomlValue("", ["mcp", "db"], { url: "https://x.test" }, { sectionDepth: 2 });

  expect(text).toBe(`[mcp.db]\nurl = "https://x.test"\n`);
});

test("a skill is added under the existing skills table and comments stay", () => {
  const text = setTomlValue(Manifest, ["skills", "house-style"], "./skills/house-style", {
    sectionDepth: 1,
  });

  expect(text).toContain("# pinned on purpose");
  expect(text).toContain(`house-style = "./skills/house-style"`);
  expect(parseToml(text, "agents.toml").skills).toEqual({
    "house-style": "./skills/house-style",
    pdf: { ref: "v1.2.0", source: "anthropics/skills" },
  });
});

test("a table-valued skill stays inline under the skills table", () => {
  const skill = { ref: "main", source: "vercel-labs/agent-skills" };
  const text = setTomlValue(Manifest, ["skills", "frontend.design"], skill, { sectionDepth: 1 });

  expect(text).not.toContain("[skills.");
  expect(parseToml(text, "agents.toml").skills).toMatchObject({ "frontend.design": skill });
});

test("an inherited server is disabled with false", () => {
  const text = setTomlValue(Manifest, ["mcp", "context7"], false, { sectionDepth: 2 });

  expect(text).toContain("# the team tracker");
  expect(parseToml(text, "agents.toml").mcp).toEqual({
    context7: false,
    linear: { url: "https://mcp.linear.app/mcp" },
  });
});

test("an existing server is replaced as a whole", () => {
  const text = setTomlValue(
    Manifest,
    ["mcp", "linear"],
    { command: "linear-mcp" },
    {
      sectionDepth: 2,
    }
  );

  expect(text).toContain("# shared tools");
  expect(parseToml(text, "agents.toml").mcp).toEqual({ linear: { command: "linear-mcp" } });
});

test("removing a server keeps the rest of the file", () => {
  const text = removeTomlValue(Manifest, ["mcp", "linear"]);

  expect(text).toContain("# pinned on purpose");
  expect(parseToml(text, "agents.toml")).toEqual({
    agents: ["codex"],
    skills: { pdf: { ref: "v1.2.0", source: "anthropics/skills" } },
  });
});

test("removing a key that is absent changes nothing", () => {
  expect(removeTomlValue(Manifest, ["mcp", "absent"])).toBe(Manifest);
  expect(removeTomlValue(Manifest, ["nothing", "absent"])).toBe(Manifest);
});
