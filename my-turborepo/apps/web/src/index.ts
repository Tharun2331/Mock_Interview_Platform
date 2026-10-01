import { serve } from "bun";
import { fileURLToPath } from "node:url";
import index from "./index.html";

const WORKLET_FILE = fileURLToPath(
  new URL("./lib/audio/pcmCaptureWorklet.js", import.meta.url),
);

const server = serve({
  routes: {
    // The microphone AudioWorklet, served as a real script from this origin so
    // the production CSP needs no blob: allowance. build.ts copies the same file
    // into dist/. Registered before the catch-all so it is not swallowed by it.
    "/pcm-capture.worklet.js": () =>
      new Response(Bun.file(WORKLET_FILE), {
        headers: { "content-type": "text/javascript; charset=utf-8" },
      }),

    // Serve index.html for all unmatched routes.
    "/*": index,

    "/api/hello": {
      async GET(req) {
        return Response.json({
          message: "Hello, world!",
          method: "GET",
        });
      },
      async PUT(req) {
        return Response.json({
          message: "Hello, world!",
          method: "PUT",
        });
      },
    },

    "/api/hello/:name": async (req) => {
      const name = req.params.name;
      return Response.json({
        message: `Hello, ${name}!`,
      });
    },
  },

  development: process.env.NODE_ENV !== "production" && {
    // Enable browser hot reloading in development
    hmr: true,

    // Echo console logs from the browser to the server
    console: true,
  },
});

console.log(`🚀 Server running at ${server.url}`);
