import { describe, expect, it, mock } from "bun:test";
import axios, {
  AxiosError,
  type AxiosAdapter,
  type InternalAxiosRequestConfig,
} from "axios";
import { attachSessionRefresh } from "@/lib/sessionRefresh";

// Real axios, real interceptor, fake transport. No module mocks: the adapter
// is the network, and it answers by a script per URL.

type Answer = number; // HTTP status

function harness(script: Record<string, Answer[]>) {
  const calls: string[] = [];

  const adapter: AxiosAdapter = async (config: InternalAxiosRequestConfig) => {
    const url = config.url ?? "";
    calls.push(url);
    const status = script[url]?.shift() ?? 200;
    const response = {
      data: { url },
      status,
      statusText: String(status),
      headers: {},
      config,
    };
    if (status >= 400) {
      throw new AxiosError("failed", String(status), config, null, response);
    }
    return response;
  };

  const instance = axios.create({ adapter });
  const refresh = mock(async () => {});
  const onExpired = mock(() => {});
  attachSessionRefresh(instance, { refresh, onExpired });

  return { instance, calls, refresh, onExpired };
}

describe("attachSessionRefresh", () => {
  it("leaves a successful request alone", async () => {
    const { instance, refresh } = harness({});

    const response = await instance.get("/a");

    expect(response.status).toBe(200);
    expect(refresh).not.toHaveBeenCalled();
  });

  // The whole point: an access token that lapsed mid-session is invisible.
  it("refreshes once on a 401 and replays the request", async () => {
    const { instance, calls, refresh } = harness({ "/a": [401, 200] });

    const response = await instance.get("/a");

    expect(response.status).toBe(200);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["/a", "/a"]);
  });

  // A page that fires several calls when the token lapses sends ONE refresh.
  it("shares one refresh across concurrent 401s", async () => {
    const { instance, refresh } = harness({
      "/a": [401, 200],
      "/b": [401, 200],
      "/c": [401, 200],
    });

    const responses = await Promise.all([
      instance.get("/a"),
      instance.get("/b"),
      instance.get("/c"),
    ]);

    expect(responses.map((response) => response.status)).toEqual([
      200, 200, 200,
    ]);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  // A 401 after a successful refresh is refused for some other reason;
  // retrying again would loop forever.
  it("replays a request at most once", async () => {
    const { instance, calls, refresh } = harness({ "/a": [401, 401] });

    await expect(instance.get("/a")).rejects.toMatchObject({
      response: { status: 401 },
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["/a", "/a"]);
  });

  // The session is over: say so once, loudly, so the guards route to sign-in.
  it("reports an ended session when the refresh fails", async () => {
    const { instance, calls, refresh, onExpired } = harness({ "/a": [401] });
    refresh.mockImplementationOnce(async () => {
      throw new Error("refresh refused");
    });

    await expect(instance.get("/a")).rejects.toMatchObject({
      response: { status: 401 },
    });
    expect(onExpired).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["/a"]);
  });

  it("does not refresh on other failures", async () => {
    const { instance, refresh } = harness({ "/a": [403], "/b": [500] });

    await expect(instance.get("/a")).rejects.toBeDefined();
    await expect(instance.get("/b")).rejects.toBeDefined();
    expect(refresh).not.toHaveBeenCalled();
  });

  // The in-flight promise is released, so a token that lapses again an hour
  // later gets a refresh of its own.
  it("refreshes again for a later lapse", async () => {
    const { instance, refresh } = harness({ "/a": [401, 200, 401, 200] });

    await instance.get("/a");
    await instance.get("/a");

    expect(refresh).toHaveBeenCalledTimes(2);
  });
});
