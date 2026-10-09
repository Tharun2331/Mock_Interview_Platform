import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import express from "express";
import { requireAllowedOrigin } from "../../lib/originCheck";
import { serve, type MountedApp } from "../helpers/testApp";

// setup.ts leaves CORS_ORIGIN blank, so the allowlist is the local web app.
const ALLOWED = "http://localhost:3000";

let app: MountedApp;

beforeAll(async () => {
  const server = express();
  server.use(requireAllowedOrigin);
  server.all("/thing", (_req, res) => {
    res.status(200).json({ ok: true });
  });
  app = await serve(server);
});

afterAll(() => app.close());

const send = (method: string, origin?: string) =>
  fetch(`${app.url}/thing`, {
    method,
    headers: origin === undefined ? {} : { Origin: origin },
  });

describe("requireAllowedOrigin", () => {
  it("lets the web app's own origin change state", async () => {
    expect((await send("POST", ALLOWED)).status).toBe(200);
  });

  // The CSRF case: a page on another origin — even a sibling on the same
  // site, which SameSite treats as friendly — triggers a request that would
  // carry the candidate's cookie.
  it("refuses a state-changing request from another origin", async () => {
    expect((await send("POST", "https://other.tharunsekar.xyz")).status).toBe(
      403,
    );
    expect((await send("DELETE", "https://evil.example")).status).toBe(403);
  });

  // Sandboxed frames and some redirects send the literal "null".
  it("refuses an opaque origin", async () => {
    expect((await send("POST", "null")).status).toBe(403);
  });

  it("lets safe methods through from anywhere", async () => {
    expect((await send("GET", "https://evil.example")).status).toBe(200);
  });

  // Not a browser acting for a candidate, so no candidate's cookie.
  it("lets a request with no Origin through", async () => {
    expect((await send("POST")).status).toBe(200);
  });
});
