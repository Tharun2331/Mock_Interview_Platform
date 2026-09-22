import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import { createServer, type Server } from "node:http";
import { connect as netConnect } from "node:net";
import {
  BedrockRuntimeClient,
  InvokeModelWithBidirectionalStreamCommand,
} from "@aws-sdk/client-bedrock-runtime";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { SendMessageBatchCommand, SQSClient } from "@aws-sdk/client-sqs";
import { mockClient } from "aws-sdk-client-mock";
import { ITEM_TYPE, SORT_KEY, sessionPk, type PlanResponse } from "@repo/shared";
import WebSocket from "ws";
import { INTERVIEW_TOOL_NAMES } from "../../lib/constants";
import {
  FakeSonicStream,
  inbound,
  settle,
  tapOutbound,
  type OutboundTap,
} from "../helpers/sonicStream";
import { resetCognitoStub, setTokenRejected } from "../helpers/cognitoStub";

// The live interview transport, end to end over a real WebSocket.
//
// Everything below the route is mocked at the AWS leaf — DynamoDB, SQS and the
// Bedrock bidirectional stream — so the REAL SonicConversation, the REAL
// ExchangeBuffer and the REAL tool dispatcher all run. Stubbing lib/sonic
// instead would delete the thing most worth testing here: that a Sonic event
// arriving on the stream produces the right frame on the socket and the right
// row in DynamoDB.

const ddb = mockClient(DynamoDBDocumentClient);
const sqs = mockClient(SQSClient);
const bedrock = mockClient(BedrockRuntimeClient);

const { attachInterviewSocket } = await import("../../routes/interview");

const SESSION_ID = "01J000000000000000000000";
const USER_ID = "user-1";
const TABLE = "prepilot-sessions-test";

const PLAN: PlanResponse = {
  focusAreas: [
    { area: "Kafka", evidence: "order-service consumers", source: "github" },
    { area: "Postgres", evidence: "order-service persistence", source: "github" },
  ],
  questionMix: { behavioural: 2, technical: 3, roleSpecific: 1 },
  startingDifficulty: "mid",
  targetMinutes: 20,
  reasoning: "single-service distributed work",
};

const META = {
  PK: sessionPk(SESSION_ID),
  SK: SORT_KEY.META,
  type: ITEM_TYPE.SESSION_META,
  sessionId: SESSION_ID,
  userId: USER_ID,
  status: "in_progress",
  createdAt: "2026-09-16T10:00:00.000Z",
  role: "Backend Engineer",
  plan: PLAN,
  questionCount: 6,
};

let sonicStreams: FakeSonicStream[] = [];
let server: Server | null = null;
let wss: ReturnType<typeof attachInterviewSocket> | null = null;
let clients: WebSocket[] = [];

afterAll(() => {
  ddb.restore();
  sqs.restore();
  bedrock.restore();
});

beforeEach(() => {
  ddb.reset();
  sqs.reset();
  bedrock.reset();
  resetCognitoStub();
  sonicStreams = [];
  clients = [];

  // A fresh inbound stream per Sonic connection.
  bedrock.on(InvokeModelWithBidirectionalStreamCommand).callsFake(() => {
    const stream = new FakeSonicStream();
    sonicStreams.push(stream);
    return { body: stream };
  });

  // Catch-all FIRST, specific matcher second — reversed, the catch-all
  // swallows everything.
  ddb.on(UpdateCommand).resolves({});
  // startInterview: the only Update that asks for the item back.
  ddb.on(UpdateCommand, { ReturnValues: "ALL_NEW" }).resolves({
    Attributes: META,
  });
  // loadGapAnalysis and loadCompanyIntel — absent is the common case.
  ddb.on(GetCommand).resolves({});
  ddb.on(PutCommand).resolves({});
  sqs.on(SendMessageBatchCommand).resolves({ Successful: [], Failed: [] });
});

// Teardown is sequenced, not fire-and-forget, and that ordering is load
// bearing. The route's shutdown awaits `sonic.close()`, which holds the closing
// sequence open for 300ms before the stream ends — so a test that merely calls
// socket.close() and moves on leaves its hard-stop timer (targetMinutes + a
// minute's grace) armed. Thirty-four of those keep the process alive long after
// the last assertion, which is exactly how this file first appeared to hang.
afterEach(async () => {
  await Promise.all(
    clients.map(
      (client) =>
        new Promise<void>((resolve) => {
          if (client.readyState === WebSocket.CLOSED) return resolve();
          client.once("close", () => resolve());
          client.close();
          // A socket rejected at the handshake never opens, so it never fires
          // 'close' either.
          setTimeout(resolve, 300);
        })
    )
  );

  // Long enough for the route's shutdown to finish awaiting sonic.close().
  await settle(350);
  for (const stream of sonicStreams) stream.end();

  // Closing the server clears the heartbeat interval; without it the process
  // holds a 30s timer per test file.
  if (wss !== null) wss.close();

  if (server !== null) {
    const closing = server;
    // `close()` alone waits for every connection to end, and an upgraded socket
    // under Bun's node:http keeps it waiting forever — the callback simply
    // never fires and the whole file hangs after its FIRST test. Tearing the
    // connections down explicitly is what lets it complete; the race is a
    // backstop so a runtime that still withholds the callback cannot wedge the
    // suite either way.
    closing.closeAllConnections?.();
    await Promise.race([
      new Promise<void>((resolve) => closing.close(() => resolve())),
      settle(300),
    ]);
  }

  wss = null;
  server = null;
});

async function listen(): Promise<number> {
  server = createServer();
  wss = attachInterviewSocket(server);
  await new Promise<void>((resolve) => server?.listen(0, resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected an AddressInfo");
  }
  return address.port;
}

/**
 * A WebSocket handshake sent by hand, so the raw HTTP response is readable.
 *
 * Returns whatever the server wrote before the socket closed — the status line
 * for a refusal, or "" when the route destroyed the socket without answering.
 */
function rawUpgrade(
  port: number,
  options: { path?: string; query?: string; protocol?: string | null }
): Promise<string> {
  const path = options.path ?? "/api/v1/interview";
  const query =
    options.query === undefined ? `?sessionId=${SESSION_ID}` : options.query;
  const protocol =
    options.protocol === undefined ? "bearer.token-abc" : options.protocol;

  return new Promise((resolve) => {
    const socket = netConnect(port, "127.0.0.1", () => {
      socket.write(
        [
          `GET ${path}${query} HTTP/1.1`,
          `Host: 127.0.0.1:${port}`,
          "Upgrade: websocket",
          "Connection: Upgrade",
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
          "Sec-WebSocket-Version: 13",
          ...(protocol === null ? [] : [`Sec-WebSocket-Protocol: ${protocol}`]),
          "",
          "",
        ].join("\r\n")
      );
    });

    let received = "";
    const finish = () => {
      socket.destroy();
      resolve(received);
    };

    socket.on("data", (chunk: Buffer) => {
      received += chunk.toString();
    });
    socket.on("close", () => resolve(received));
    socket.on("error", () => resolve(received));
    // A destroyed socket may close with nothing at all, which is itself the
    // assertion for the wrong-path case.
    setTimeout(finish, 1000);
  });
}

type Connected = {
  socket: WebSocket;
  events: Record<string, unknown>[];
  binary: Buffer[];
  waitFor: (type: string, ms?: number) => Promise<Record<string, unknown>>;
};

function connect(
  port: number,
  options: {
    path?: string;
    sessionId?: string | null;
    protocol?: string | null;
  } = {}
): Connected {
  const path = options.path ?? "/api/v1/interview";
  const sessionId =
    options.sessionId === undefined ? SESSION_ID : options.sessionId;
  const query = sessionId === null ? "" : `?sessionId=${sessionId}`;
  const protocol =
    options.protocol === undefined ? "bearer.token-abc" : options.protocol;

  const socket =
    protocol === null
      ? new WebSocket(`ws://127.0.0.1:${port}${path}${query}`)
      : new WebSocket(`ws://127.0.0.1:${port}${path}${query}`, [protocol]);

  clients.push(socket);

  const events: Record<string, unknown>[] = [];
  const binary: Buffer[] = [];

  socket.on("message", (data: Buffer, isBinary: boolean) => {
    if (isBinary) binary.push(data);
    else events.push(JSON.parse(data.toString()) as Record<string, unknown>);
  });

  const waitFor = async (type: string, ms = 3000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const found = events.find((event) => event.type === type);
      if (found !== undefined) return found;
      await settle(10);
    }
    throw new Error(
      `never saw "${type}"; saw ${JSON.stringify(events.map((e) => e.type))}`
    );
  };

  return { socket, events, binary, waitFor };
}

/** Connects, waits for `ready`, and hands back the client plus the Sonic
 *  stream behind it. */
async function startInterviewSocket(): Promise<
  Connected & { stream: FakeSonicStream; outbound: OutboundTap }
> {
  const port = await listen();
  const client = connect(port);
  await client.waitFor("ready");

  const stream = sonicStreams[0];
  if (stream === undefined) throw new Error("no Sonic stream was opened");

  const body = bedrock.commandCalls(InvokeModelWithBidirectionalStreamCommand)[0]
    ?.args[0].input.body;

  return { ...client, stream, outbound: tapOutbound(body) };
}

/** Drives one complete exchange through the real ExchangeBuffer: the
 *  interviewer asks, the candidate answers, the interviewer asks again and
 *  ends its turn — which is the boundary that closes the first exchange. */
async function playExchange(
  stream: FakeSonicStream,
  args: { question: string; answer: string; nextQuestion?: string }
): Promise<void> {
  stream.push(inbound.contentStart({ role: "ASSISTANT", type: "TEXT" }));
  stream.push(inbound.textOutput(args.question));
  stream.push(inbound.contentEnd({ type: "AUDIO", stopReason: "END_TURN" }));
  await settle();

  stream.push(
    inbound.contentStart({ role: "USER", type: "TEXT", generationStage: "FINAL" })
  );
  stream.push(inbound.textOutput(args.answer));
  await settle();

  stream.push(inbound.contentStart({ role: "ASSISTANT", type: "TEXT" }));
  stream.push(inbound.textOutput(args.nextQuestion ?? "And after that?"));
  stream.push(inbound.contentEnd({ type: "AUDIO", stopReason: "END_TURN" }));
  await settle(30);
}

function answerWrites(): Record<string, unknown>[] {
  return ddb
    .commandCalls(PutCommand)
    .map((call) => call.args[0].input.Item as Record<string, unknown>)
    .filter((item) => String(item?.SK ?? "").startsWith("ANSWER#"));
}

// The handshake is authenticated BEFORE a socket exists, so a rejected caller
// never reaches handleConnection and never causes a billable Sonic stream to be
// allocated. That is the property each of these pins.
describe("the upgrade handshake", () => {
  it("accepts a valid handshake and reports the session", async () => {
    const client = await startInterviewSocket();
    const ready = await client.waitFor("ready");

    expect(ready).toMatchObject({
      type: "ready",
      sessionId: SESSION_ID,
      targetRole: "Backend Engineer",
      targetMinutes: PLAN.targetMinutes,
    });
  });

  // Driven over a raw socket rather than through `ws`, because Bun's WebSocket
  // client collapses every rejection into "Connection ended" and would let a
  // handshake that ACCEPTED look the same as one that refused.
  //
  // What is asserted is that the connection never upgrades — no "101 Switching
  // Protocols" — and that nothing was allocated behind it. Deliberately NOT the
  // 401 status line: `refuse()` writes one, but Bun's node:http shim does not
  // flush writes to a raw upgrade socket, so no client can read it. See the
  // note on `refuse` in routes/interview.ts; asserting text the runtime cannot
  // deliver would pin a wish rather than the behaviour.
  it("refuses a handshake carrying no session id", async () => {
    const port = await listen();

    const response = await rawUpgrade(port, { query: "" });

    expect(response).not.toContain("101");
    expect(sonicStreams).toHaveLength(0);
  });

  // A browser WebSocket cannot set headers, so the token rides in the
  // subprotocol. No subprotocol means no credential.
  it("refuses a handshake carrying no bearer subprotocol", async () => {
    const port = await listen();

    const response = await rawUpgrade(port, { protocol: null });

    expect(response).not.toContain("101");
    expect(sonicStreams).toHaveLength(0);
  });

  // The property that makes authenticating at upgrade worth doing: a forged or
  // expired token cannot cost a billable Sonic stream, because handleConnection
  // is never reached.
  it("refuses a token the verifier rejects, allocating nothing", async () => {
    setTokenRejected();
    const port = await listen();

    const response = await rawUpgrade(port, {});

    expect(response).not.toContain("101");
    expect(sonicStreams).toHaveLength(0);
  });

  it("drops a connection aimed at any other path", async () => {
    const port = await listen();

    const response = await rawUpgrade(port, {
      path: "/api/v1/not-the-interview",
    });

    expect(response).not.toContain("101");
    expect(sonicStreams).toHaveLength(0);
  });
});

describe("a session that cannot be interviewed", () => {
  it("reports an error when the session carries no plan", async () => {
    const { plan: _dropped, ...noPlan } = META;
    ddb.on(UpdateCommand, { ReturnValues: "ALL_NEW" }).resolves({
      Attributes: noPlan,
    });

    const port = await listen();
    const client = connect(port);
    const error = await client.waitFor("error");

    expect(String(error.message)).toContain("cannot be started");
    expect(sonicStreams).toHaveLength(0);
  });
});

describe("audio", () => {
  it("forwards a binary frame to Sonic as audio input", async () => {
    const client = await startInterviewSocket();

    client.socket.send(Buffer.from([1, 2, 3, 4]));
    await settle(50);

    expect(client.outbound.ofName("audioInput").length).toBeGreaterThan(0);
  });

  // Decoded server-side rather than forwarded as base64: the client gets raw
  // PCM it can hand straight to Web Audio, and base64 would inflate the
  // highest-frequency traffic on the socket by a third.
  it("sends Sonic's audio back as a binary frame, decoded", async () => {
    const client = await startInterviewSocket();

    client.stream.push(inbound.audioOutput(Buffer.from([9, 8, 7]).toString("base64")));
    await settle(50);

    expect(client.binary).toHaveLength(1);
    expect([...(client.binary[0] ?? [])]).toEqual([9, 8, 7]);
  });
});

describe("transcripts", () => {
  it("forwards assistant text with the role from the preceding contentStart", async () => {
    const client = await startInterviewSocket();

    client.stream.push(inbound.contentStart({ role: "ASSISTANT", type: "TEXT" }));
    client.stream.push(inbound.textOutput("Tell me about Kafka."));
    await settle(50);

    expect(client.events).toContainEqual({
      type: "transcript",
      role: "ASSISTANT",
      text: "Tell me about Kafka.",
      final: false,
    });
  });

  // The candidate's FINAL transcript arriving is the only signal Sonic gives
  // for "speech ended". Without it the client cannot tell a thinking pause from
  // a dead connection — the moment silence is most likely to read as a crash.
  it("announces that the candidate has finished on their FINAL transcript", async () => {
    const client = await startInterviewSocket();

    client.stream.push(
      inbound.contentStart({ role: "USER", type: "TEXT", generationStage: "FINAL" })
    );
    await settle(50);

    expect(client.events.some((e) => e.type === "candidateFinished")).toBe(true);
  });

  it("announces that the interviewer has started on its audio block", async () => {
    const client = await startInterviewSocket();

    client.stream.push(inbound.contentStart({ role: "ASSISTANT", type: "AUDIO" }));
    await settle(50);

    expect(client.events.some((e) => e.type === "interviewerStarted")).toBe(true);
  });

  // Sonic reports a barge-in by emitting `{"interrupted":true}` as an assistant
  // textOutput — a control signal wearing a transcript's clothes. In a measured
  // session it was shown to the candidate as something the interviewer said.
  it("never shows the barge-in sentinel as speech", async () => {
    const client = await startInterviewSocket();

    client.stream.push(inbound.contentStart({ role: "ASSISTANT", type: "TEXT" }));
    client.stream.push(inbound.textOutput('{"interrupted":true}'));
    await settle(50);

    expect(client.events.some((e) => e.type === "transcript")).toBe(false);
  });

  it("tells the client to drop queued playback on a barge-in", async () => {
    const client = await startInterviewSocket();

    client.stream.push(
      inbound.contentEnd({ type: "AUDIO", stopReason: "INTERRUPTED" })
    );
    await settle(50);

    expect(client.events.some((e) => e.type === "interrupted")).toBe(true);
  });

  // Scoped to AUDIO deliberately. Text blocks also end with END_TURN, and
  // forwarding those would tell the client the interviewer had finished
  // speaking while its audio was still playing.
  it("does not report a turn ending when only a text block closed", async () => {
    const client = await startInterviewSocket();

    client.stream.push(inbound.contentEnd({ type: "TEXT", stopReason: "END_TURN" }));
    await settle(50);

    expect(client.events.some((e) => e.type === "turnEnded")).toBe(false);
  });

  it("reports a turn ending when the interviewer's audio closes", async () => {
    const client = await startInterviewSocket();

    client.stream.push(inbound.contentEnd({ type: "AUDIO", stopReason: "END_TURN" }));
    await settle(50);

    expect(client.events.some((e) => e.type === "turnEnded")).toBe(true);
  });
});

// These persist state and report it. They never decide what to ask — that
// reasoning happens inside Sonic as it generates the next turn.
describe("the tools the interviewer calls", () => {
  async function callTool(
    client: Awaited<ReturnType<typeof startInterviewSocket>>,
    toolName: string,
    content = "{}"
  ): Promise<Record<string, unknown>> {
    const before = client.outbound.ofName("toolResult").length;
    client.stream.push(
      inbound.toolUse({ toolName, toolUseId: `t-${toolName}`, content })
    );
    await settle(60);

    const results = client.outbound.ofName("toolResult");
    const latest = results[before];
    return JSON.parse(String(latest?.content ?? "{}")) as Record<string, unknown>;
  }

  it("answers logExchange with the live clock and phase", async () => {
    const client = await startInterviewSocket();

    const result = await callTool(
      client,
      INTERVIEW_TOOL_NAMES.LOG_EXCHANGE,
      JSON.stringify({
        focusArea: "Kafka",
        exchangeType: "opening",
        answerDepth: "solid",
        moveToNextFocusArea: false,
      })
    );

    // The clock rides on this result rather than only on getSessionState,
    // because this tool is called after every answer and that one is called
    // when the model thinks to — and in a measured session it did not.
    expect(result).toMatchObject({ ok: true, phase: "core" });
    expect(typeof result.remainingMinutes).toBe("number");
  });

  it("counts the exchanges it has logged", async () => {
    const client = await startInterviewSocket();

    await callTool(client, INTERVIEW_TOOL_NAMES.LOG_EXCHANGE);
    const second = await callTool(client, INTERVIEW_TOOL_NAMES.LOG_EXCHANGE);

    expect(second.exchangesLogged).toBe(2);
  });

  it("answers getSessionState without logging an exchange", async () => {
    const client = await startInterviewSocket();

    const result = await callTool(client, INTERVIEW_TOOL_NAMES.GET_SESSION_STATE);

    expect(result.exchangesLogged).toBe(0);
    expect(result.phase).toBe("core");
  });

  // Unknown tool names are the model hallucinating one. Answering with an error
  // beats throwing: the stream survives and the interviewer moves on.
  it("answers an unknown tool with an error rather than dying", async () => {
    const client = await startInterviewSocket();

    const result = await callTool(client, "summonACoffee");

    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain("summonACoffee");
    expect(client.socket.readyState).toBe(WebSocket.OPEN);
  });

  // endInterview is the one path where the interviewer ends a session early on
  // its own. It takes effect on the completionEnd that follows, so the closing
  // remarks are spoken first.
  it("shuts down after endInterview once the turn completes", async () => {
    const client = await startInterviewSocket();

    await callTool(
      client,
      INTERVIEW_TOOL_NAMES.END_INTERVIEW,
      JSON.stringify({ reason: "scopeCovered" })
    );
    client.stream.push(inbound.completionEnd("END_TURN"));

    const closed = await client.waitFor("closed");
    expect(closed.reason).toBe("interview complete");
  });

  it("does not shut down on completionEnd the interviewer did not request", async () => {
    const client = await startInterviewSocket();

    client.stream.push(inbound.completionEnd("END_TURN"));
    await settle(100);

    expect(client.events.some((e) => e.type === "closed")).toBe(false);
  });
});

describe("recording the conversation", () => {
  it("writes a completed exchange to DynamoDB", async () => {
    const client = await startInterviewSocket();

    await playExchange(client.stream, {
      question: "Tell me about Kafka.",
      answer: "I ran consumers coordinating order state transitions.",
    });

    const written = answerWrites();
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      questionText: "Tell me about Kafka.",
      transcript: "I ran consumers coordinating order state transitions.",
    });
  });

  // The interviewer's own label, carried forward from its last logExchange.
  // Every answer was recorded as `technical` before this was wired through,
  // which made the Evaluator's per-category gating describe a world with one
  // category in it.
  it("records the question type the interviewer reported", async () => {
    const client = await startInterviewSocket();

    client.stream.push(
      inbound.toolUse({
        toolName: INTERVIEW_TOOL_NAMES.LOG_EXCHANGE,
        toolUseId: "t-1",
        content: JSON.stringify({
          focusArea: "Teamwork",
          exchangeType: "behavioural",
          answerDepth: "solid",
          moveToNextFocusArea: false,
        }),
      })
    );
    await settle(30);

    await playExchange(client.stream, {
      question: "Tell me about a disagreement.",
      answer: "I disagreed with a colleague about retries and we ran a spike.",
    });

    expect(answerWrites()[0]?.questionType).toBe("behavioural");
  });

  // Best-effort on purpose: the tool is a steering signal the model may emit
  // late, malformed, or not at all, and an unparseable input must leave the
  // previous label standing rather than throw inside a live stream.
  it("keeps the previous label when the tool input will not parse", async () => {
    const client = await startInterviewSocket();

    client.stream.push(
      inbound.toolUse({
        toolName: INTERVIEW_TOOL_NAMES.LOG_EXCHANGE,
        toolUseId: "t-1",
        content: JSON.stringify({
          focusArea: "Teamwork",
          exchangeType: "behavioural",
          answerDepth: "solid",
          moveToNextFocusArea: false,
        }),
      })
    );
    await settle(30);

    client.stream.push(
      inbound.toolUse({
        toolName: INTERVIEW_TOOL_NAMES.LOG_EXCHANGE,
        toolUseId: "t-2",
        content: "{truncated mid-gener",
      })
    );
    await settle(30);

    await playExchange(client.stream, {
      question: "And another?",
      answer: "We rewrote the retry policy after the incident review.",
    });

    expect(answerWrites()[0]?.questionType).toBe("behavioural");
  });

  // Losing one answer is bad; ending a live interview because a write failed is
  // worse.
  it("keeps the interview alive when an answer write fails", async () => {
    const client = await startInterviewSocket();
    ddb.on(PutCommand).rejects(new Error("ProvisionedThroughputExceeded"));

    await playExchange(client.stream, {
      question: "Tell me about Kafka.",
      answer: "I ran consumers for the order pipeline.",
    });

    expect(client.socket.readyState).toBe(WebSocket.OPEN);
    expect(client.events.some((e) => e.type === "closed")).toBe(false);
  });
});

describe("ending the interview", () => {
  it("closes when the candidate sends stop", async () => {
    const client = await startInterviewSocket();

    client.socket.send("stop");
    const closed = await client.waitFor("closed");

    expect(closed.reason).toBe("candidate ended interview");
  });

  // An abrupt end is exactly the case where the candidate's last answer would
  // otherwise be lost, and it is the one they are most likely to care about.
  it("flushes the exchange in progress before closing", async () => {
    const client = await startInterviewSocket();

    client.stream.push(inbound.contentStart({ role: "ASSISTANT", type: "TEXT" }));
    client.stream.push(inbound.textOutput("What broke in production?"));
    client.stream.push(inbound.contentEnd({ type: "AUDIO", stopReason: "END_TURN" }));
    await settle();
    client.stream.push(
      inbound.contentStart({ role: "USER", type: "TEXT", generationStage: "FINAL" })
    );
    client.stream.push(inbound.textOutput("A consumer lag alert fired at 3am."));
    await settle();

    client.socket.send("stop");
    await client.waitFor("closed");
    await settle(50);

    expect(answerWrites()[0]).toMatchObject({
      transcript: "A consumer lag alert fired at 3am.",
    });
  });

  // `evaluating`, not `complete` — the answers exist but nothing has read them
  // yet. Marking it complete would tell the results page feedback is ready when
  // the queue has not been drained, with no later transition to correct it.
  it("leaves a session with answers in evaluating", async () => {
    const client = await startInterviewSocket();

    await playExchange(client.stream, {
      question: "Tell me about Kafka.",
      answer: "I ran consumers coordinating order state transitions.",
    });

    client.socket.send("stop");
    await client.waitFor("closed");
    await settle(80);

    const statuses = ddb
      .commandCalls(UpdateCommand)
      .map((call) => call.args[0].input.ExpressionAttributeValues?.[":status"])
      .filter((value) => value !== undefined);

    expect(statuses).toContain("evaluating");
  });

  // An interview that produced nothing to score is the one case that is
  // genuinely finished.
  it("completes a session that recorded nothing", async () => {
    const client = await startInterviewSocket();

    client.socket.send("stop");
    await client.waitFor("closed");
    await settle(80);

    const statuses = ddb
      .commandCalls(UpdateCommand)
      .map((call) => call.args[0].input.ExpressionAttributeValues?.[":status"])
      .filter((value) => value !== undefined);

    expect(statuses).toContain("complete");
    expect(statuses).not.toContain("evaluating");
  });

  it("queues the recorded answer for scoring", async () => {
    const client = await startInterviewSocket();

    await playExchange(client.stream, {
      question: "Tell me about Kafka.",
      answer: "I ran consumers coordinating order state transitions.",
    });

    client.socket.send("stop");
    await client.waitFor("closed");
    await settle(80);

    expect(sqs.commandCalls(SendMessageBatchCommand)).toHaveLength(1);
  });

  // Opened BEFORE the messages, so a worker can never find an evaluation to
  // record with no rollup to record it against.
  it("opens the evaluation rollup before enqueueing", async () => {
    const client = await startInterviewSocket();

    await playExchange(client.stream, {
      question: "Tell me about Kafka.",
      answer: "I ran consumers coordinating order state transitions.",
    });

    client.socket.send("stop");
    await client.waitFor("closed");
    await settle(80);

    const rollup = ddb
      .commandCalls(PutCommand)
      .map((call) => call.args[0].input.Item as Record<string, unknown>)
      .find((item) => item?.SK === SORT_KEY.EVAL_SUMMARY);

    // The count is the answers actually enqueued, NOT the plan's questionCount
    // — an interview stopped early by the hard timer produces fewer answers
    // than it planned, and waiting for the planned number would leave the
    // session at `evaluating` forever.
    expect(rollup?.questionCount).toBe(1);
    expect(rollup?.questionCount).not.toBe(META.questionCount);
  });

  // A sign-off is not a failed answer. Scoring one produces a 0/0/0 with
  // coaching that makes no sense — five such zeros landed in one thirty-one
  // exchange session and pulled every average down with them.
  it("records a courtesy sign-off but does not queue it for scoring", async () => {
    const client = await startInterviewSocket();

    await playExchange(client.stream, {
      question: "That's all I had.",
      answer: "thank you have a good one",
    });

    client.socket.send("stop");
    await client.waitFor("closed");
    await settle(80);

    // The transcript is the durable record and the Coach reads all of it.
    expect(answerWrites()).toHaveLength(1);
    // Nothing scoreable, so the rollup is empty and the session is finished.
    const rollup = ddb
      .commandCalls(PutCommand)
      .map((call) => call.args[0].input.Item as Record<string, unknown>)
      .find((item) => item?.SK === SORT_KEY.EVAL_SUMMARY);
    expect(rollup?.questionCount).toBe(0);
  });

  // The transcript is safely written either way, and the enqueue is the one
  // step that can be retried later without the candidate repeating anything.
  it("still closes cleanly when the enqueue fails", async () => {
    const client = await startInterviewSocket();
    sqs.on(SendMessageBatchCommand).rejects(new Error("AWS.SimpleQueueService"));

    await playExchange(client.stream, {
      question: "Tell me about Kafka.",
      answer: "I ran consumers coordinating order state transitions.",
    });

    client.socket.send("stop");
    const closed = await client.waitFor("closed");

    expect(closed.reason).toBe("candidate ended interview");
    expect(answerWrites()).toHaveLength(1);
  });

  // Whatever ends first must end the other, or a closed browser tab leaves a
  // Sonic stream billing until the idle timeout.
  it("ends the Sonic stream when the socket drops", async () => {
    const client = await startInterviewSocket();

    client.socket.close();
    await settle(500);

    const sessionEnds = client.outbound.ofName("sessionEnd");
    expect(sessionEnds.length).toBeGreaterThan(0);
  });
});
