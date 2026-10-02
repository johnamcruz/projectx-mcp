/** The slice of `@ngrok/ngrok` this server uses. */
export interface NgrokSdk {
  forward(config: { addr: string; authtoken: string; domain?: string }): Promise<{ url(): string | null }>;
  disconnect(): Promise<void>;
}

export interface Tunnel {
  url: string;
  close(): Promise<void>;
}

/** `@ngrok/ngrok` is an optional dependency, so load it only when a tunnel is requested. */
async function loadNgrok(): Promise<NgrokSdk> {
  try {
    return (await import("@ngrok/ngrok")) as unknown as NgrokSdk;
  } catch {
    throw new Error("NGROK_AUTHTOKEN is set but @ngrok/ngrok is not installed. Run `npm install @ngrok/ngrok`.");
  }
}

/**
 * Expose the local HTTP endpoint at a public HTTPS URL through ngrok.
 * Returns undefined when NGROK_AUTHTOKEN is not set.
 */
export async function startNgrokTunnel(
  env: Record<string, string | undefined>,
  addr: string,
  load: () => Promise<NgrokSdk> = loadNgrok,
): Promise<Tunnel | undefined> {
  const authtoken = env.NGROK_AUTHTOKEN?.trim();
  if (!authtoken) return undefined;
  const domain = env.NGROK_DOMAIN?.trim() || undefined;
  const ngrok = await load();
  const listener = await ngrok.forward({ addr, authtoken, ...(domain && { domain }) });
  const url = listener.url();
  if (!url) throw new Error("ngrok did not return a public URL");
  return { url, close: () => ngrok.disconnect() };
}
