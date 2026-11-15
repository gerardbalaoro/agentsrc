/** A stand-in for the npm registry. `versions` can change while it runs. */
export function serveRegistry(packages: Record<string, { latest: string; versions: string[] }>) {
  const server = Bun.serve({
    fetch: (request) => {
      const name = decodeURIComponent(new URL(request.url).pathname.slice(1));
      const found = packages[name];

      if (found === undefined) {
        return new Response("{}", { status: 404 });
      }

      return Response.json({
        "dist-tags": { latest: found.latest },
        versions: Object.fromEntries(found.versions.map((version) => [version, {}])),
      });
    },
    port: 0,
  });

  return { packages, stop: () => server.stop(), url: `http://localhost:${server.port}` };
}
