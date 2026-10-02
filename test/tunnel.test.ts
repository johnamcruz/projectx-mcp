import { describe, expect, it, vi } from "vitest";
import { startNgrokTunnel, type NgrokSdk } from "../src/tunnel.js";

const fakeNgrok = (url: string | null = "https://abc.ngrok.app") => {
  const sdk = { forward: vi.fn(async () => ({ url: () => url })), disconnect: vi.fn(async () => {}) };
  return { sdk, load: async () => sdk as NgrokSdk };
};

describe("ngrok tunnel", () => {
  it("does nothing without NGROK_AUTHTOKEN", async () => {
    const { sdk, load } = fakeNgrok();
    expect(await startNgrokTunnel({ NGROK_AUTHTOKEN: "  " }, "127.0.0.1:8787", load)).toBeUndefined();
    expect(sdk.forward).not.toHaveBeenCalled();
  });

  it("forwards the local address and closes the tunnel", async () => {
    const { sdk, load } = fakeNgrok();
    const tunnel = await startNgrokTunnel({ NGROK_AUTHTOKEN: "tok" }, "127.0.0.1:8787", load);
    expect(sdk.forward).toHaveBeenCalledWith({ addr: "127.0.0.1:8787", authtoken: "tok" });
    expect(tunnel?.url).toBe("https://abc.ngrok.app");
    await tunnel?.close();
    expect(sdk.disconnect).toHaveBeenCalled();
  });

  it("requests a reserved domain when NGROK_DOMAIN is set", async () => {
    const { sdk, load } = fakeNgrok();
    await startNgrokTunnel({ NGROK_AUTHTOKEN: "tok", NGROK_DOMAIN: "me.ngrok.app" }, "127.0.0.1:8787", load);
    expect(sdk.forward).toHaveBeenCalledWith({ addr: "127.0.0.1:8787", authtoken: "tok", domain: "me.ngrok.app" });
  });

  it("fails when ngrok returns no URL", async () => {
    const { load } = fakeNgrok(null);
    await expect(startNgrokTunnel({ NGROK_AUTHTOKEN: "tok" }, "127.0.0.1:8787", load)).rejects.toThrow(/public URL/);
  });
});
