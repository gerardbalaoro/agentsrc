export type Transport = (url: string, init: RequestInit) => Promise<Response>;

export async function request(
  provider: string,
  url: string,
  headers: RequestInit["headers"],
  init: RequestInit,
  transport: Transport
) {
  let response: Response;

  try {
    response = await transport(url, {
      ...init,
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(25_000),
    });
  } catch {
    throw new Error(
      `${provider}: request failed or timed out.${init.method === "POST" ? " Reset claims may have succeeded; retry with the same credit and request IDs." : " Check your connection and try again."}`
    );
  }

  if (response.status === 401 || response.status === 403) {
    throw new Error(`${provider}: Sign in with the provider CLI again (HTTP ${response.status}).`);
  }

  if (!response.ok) {
    throw new Error(
      `${provider}: request failed (HTTP ${response.status})${response.status === 429 ? "; try again later" : ""}.`
    );
  }

  try {
    return await response.json();
  } catch {
    throw new Error(`${provider}: invalid JSON response.`);
  }
}
