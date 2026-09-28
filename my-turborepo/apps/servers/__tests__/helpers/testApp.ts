import express, { type Express, type RequestHandler } from "express";
import type { Server } from "node:http";

// Mounts a router on a throwaway Express app and serves it on an ephemeral
// port. Deliberately NOT importing ../../index.ts: that file calls app.listen()
// and attachInterviewSocket() at module scope, so importing it would start a
// real server and a WebSocket for every test file.
//
// The consequence worth knowing: this mounts the router WITHOUT the middleware
// chain index.ts wraps it in (helmet, cors, AuthMiddleware, apiRateLimiter).
// Auth is stubbed below instead, so these tests cover handler behaviour and the
// error-to-status mapping — not the mount-time wiring. That wiring is a
// separate concern and is untested; see the note in CLAUDE.local.md.

export type TestUser = {
  id: string;
  username: string;
  scopes?: string[];
  // Cognito group memberships. Optional and defaulting to none, which is what a
  // candidate's token carries — so every existing caller keeps the behaviour it
  // had, and a test that wants the admin surface has to say so explicitly.
  //
  // Passing the real group name here is how an admin-route test is set up. That
  // means these tests exercise RequireAdmin against the same claim shape
  // AuthMiddleware produces, rather than against a second stub of the guard —
  // the guard itself is real, only the token verification is stubbed.
  groups?: string[];
};

// Stands in for AuthMiddleware. Passing `null` exercises the requireUserId()
// guard inside each handler — the 401 that fires when a token verified but
// carried no subject.
function stubAuth(user: TestUser | null): RequestHandler {
  return (req, _res, next) => {
    if (user !== null) {
      req.user = {
        id: user.id,
        username: user.username,
        scopes: user.scopes ?? [],
        groups: user.groups ?? [],
      };
    }
    next();
  };
}

export type MountedApp = {
  url: string;
  close: () => Promise<void>;
};

export function buildApp(args: {
  path: string;
  router: express.Router;
  user: TestUser | null;
  // Extra middleware mounted between the stubbed auth and the router, in order.
  //
  // Added for the admin routes, which are the first in this codebase whose
  // authorisation lives in middleware rather than in the handler. Mounting
  // `RequireAdmin` here means the tests exercise the real guard over a stubbed
  // token, which is the same split every other test in this suite uses — stub the
  // boundary that talks outside, run the real logic.
  middleware?: RequestHandler[];
}): Express {
  const app = express();
  app.use(express.json());
  app.use(
    args.path,
    stubAuth(args.user),
    ...(args.middleware ?? []),
    args.router,
  );
  return app;
}

// Listening on port 0 lets the OS pick a free port, so test files can run
// concurrently without colliding.
export async function serve(app: Express): Promise<MountedApp> {
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected an AddressInfo from a TCP server");
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

// Convenience for the common case: mount, serve, and hand back both.
export async function mount(args: {
  path: string;
  router: express.Router;
  user: TestUser | null;
  middleware?: RequestHandler[];
}): Promise<MountedApp> {
  return serve(buildApp(args));
}
