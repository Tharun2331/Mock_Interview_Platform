import { describe, expect, it } from "bun:test";
import { Router } from "express";
import { RequireAdmin } from "../../lib/adminAuth";
import { config } from "../../lib/config";
import { MESSAGES } from "../../lib/messages";
import { mount, type MountedApp } from "../helpers/testApp";

// The one authorisation check the whole admin surface rests on.
//
// Exercised through a real Express mount rather than by calling the middleware
// with fake req/res objects, because the thing being tested is a CHAIN: the guard
// reads a claim that only AuthMiddleware writes, and its behaviour when that
// middleware is absent is as important as its behaviour when it is present. A
// hand-rolled `next` spy proves the branch and not the wiring.
//
// `stubAuth` in the helper stands in for AuthMiddleware and writes the same
// `req.user` shape from the same claim. The guard itself is real.

const ADMIN_PATH = "/api/v1/admin";

// A router that answers only if the guard let the request through, so a passing
// request is distinguishable from a refused one by status alone.
function probeRouter(): Router {
  const router = Router();
  router.get("/probe", (_req, res) => {
    res.json({ reached: true });
  });
  return router;
}

async function probe(args: {
  user: Parameters<typeof mount>[0]["user"];
  withGuard?: boolean;
}): Promise<{ app: MountedApp; status: number; body: unknown }> {
  const app = await mount({
    path: ADMIN_PATH,
    router: probeRouter(),
    user: args.user,
    middleware: args.withGuard === false ? [] : [RequireAdmin],
  });

  const response = await fetch(`${app.url}${ADMIN_PATH}/probe`);
  return { app, status: response.status, body: await response.json() };
}

describe("RequireAdmin", () => {
  it("lets a member of the admin group through", async () => {
    const { app, status, body } = await probe({
      user: {
        id: "admin-1",
        username: "admin@example.com",
        groups: [config.adminGroupName],
      },
    });

    expect(status).toBe(200);
    expect(body).toEqual({ reached: true });
    await app.close();
  });

  it("returns 404 — not 403 — to an authenticated non-admin", async () => {
    // The whole point, and the test that stops someone "fixing" this to a 403
    // because it reads as more correct. A 403 confirms the route exists, which
    // tells any signed-in candidate that there is an admin API here and what its
    // path is. A 404 is byte-identical to what an unrouted path returns, so
    // probing /admin teaches nothing that probing /adminn does not.
    const { app, status, body } = await probe({
      user: { id: "candidate-1", username: "c@example.com", groups: [] },
    });

    expect(status).toBe(404);
    expect(body).toEqual({ message: MESSAGES.NOT_FOUND });
    await app.close();
  });

  it("does not answer 401 to a non-admin", async () => {
    // A 401 would be worse than a 403: it invites the client to refresh a token
    // that is already perfectly valid and retry forever.
    const { app, status } = await probe({
      user: { id: "candidate-1", username: "c@example.com", groups: [] },
    });

    expect(status).not.toBe(401);
    expect(status).not.toBe(403);
    await app.close();
  });

  it("refuses when no user is attached at all", async () => {
    // What a mounting mistake looks like: RequireAdmin placed before
    // AuthMiddleware, so no token has been verified and `req.user` is undefined.
    // Refusing everything is the correct failure — safe, and identical to the
    // non-admin response so it leaks nothing either.
    const { app, status, body } = await probe({ user: null });

    expect(status).toBe(404);
    expect(body).toEqual({ message: MESSAGES.NOT_FOUND });
    await app.close();
  });

  it("gives a non-admin the identical response a missing route gives", async () => {
    // Asserted as an equality between two responses rather than as a status
    // number, because the property that matters is indistinguishability. If the
    // refusal ever grows a distinguishing body or header, this fails.
    const app = await mount({
      path: ADMIN_PATH,
      router: probeRouter(),
      user: { id: "candidate-1", username: "c@example.com", groups: [] },
      middleware: [RequireAdmin],
    });

    const refused = await fetch(`${app.url}${ADMIN_PATH}/probe`);
    const refusedBody = await refused.text();

    // A path the router does not define, reached by the same non-admin.
    const absent = await fetch(`${app.url}${ADMIN_PATH}/not-a-route`);

    expect(refused.status).toBe(absent.status);
    expect(refusedBody).toEqual(await absent.text());
    await app.close();
  });

  it("is not satisfied by a group whose name merely contains the admin group", async () => {
    // `includes` on the ARRAY, never a substring test on a joined string. A claim
    // of ["administrators-readonly"] must not pass a check for "admins", and a
    // future refactor to `groups.join(",").includes(...)` would let it.
    const { app, status } = await probe({
      user: {
        id: "nearly-1",
        username: "n@example.com",
        groups: [
          `${config.adminGroupName}-readonly`,
          `not-${config.adminGroupName}`,
        ],
      },
    });

    expect(status).toBe(404);
    await app.close();
  });

  it("passes a member who is also in other groups", async () => {
    const { app, status } = await probe({
      user: {
        id: "admin-2",
        username: "a2@example.com",
        groups: ["beta-testers", config.adminGroupName, "something-else"],
      },
    });

    expect(status).toBe(200);
    await app.close();
  });

  it("reaches the handler with no guard mounted, proving the probe is honest", async () => {
    // A control. Without this, every assertion above could be passing because the
    // probe route was unreachable for some unrelated reason rather than because
    // the guard refused it.
    const { app, status } = await probe({
      user: { id: "candidate-1", username: "c@example.com", groups: [] },
      withGuard: false,
    });

    expect(status).toBe(200);
    await app.close();
  });
});
