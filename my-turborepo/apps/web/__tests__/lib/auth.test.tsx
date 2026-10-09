import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, cleanup, render, screen } from "@testing-library/react";
// The SHARED stub — AuthProvider asks lib/authApi's fetchMe whether anyone is
// signed in. lib/authEvents is real.
import { fetchMe, resetAuthApiStub } from "../helpers/authApiStub";

const { AuthProvider, useAuthStatus } = await import("@/lib/auth");
const { emitAuthEvent } = await import("@/lib/authEvents");

function Status() {
  return <p>status: {useAuthStatus()}</p>;
}

function renderProvider() {
  return render(
    <AuthProvider>
      <Status />
    </AuthProvider>,
  );
}

beforeEach(() => {
  resetAuthApiStub();
});

afterEach(cleanup);

// The session is an httpOnly cookie page script cannot read (ADR-0011), so the
// provider's only way to know is to ask the server.
describe("AuthProvider", () => {
  it("is loading until the server answers", () => {
    fetchMe.mockImplementationOnce(() => new Promise(() => {}));
    renderProvider();

    expect(screen.getByText("status: loading")).toBeDefined();
  });

  it("is signed in when /auth/me answers", async () => {
    renderProvider();

    expect(await screen.findByText("status: authenticated")).toBeDefined();
  });

  it("is signed out when there is no session", async () => {
    fetchMe.mockImplementationOnce(async () => {
      throw new Error("401");
    });
    renderProvider();

    expect(await screen.findByText("status: unauthenticated")).toBeDefined();
  });

  // Sign-in pages announce success; the guards must see it before navigating.
  it("follows a sign-in", async () => {
    fetchMe.mockImplementationOnce(async () => {
      throw new Error("401");
    });
    renderProvider();
    await screen.findByText("status: unauthenticated");

    act(() => emitAuthEvent("signedIn"));

    expect(screen.getByText("status: authenticated")).toBeDefined();
  });

  // The fourth auth condition: a refresh failed partway through a session.
  it("treats a session that expired mid-use as signed out", async () => {
    renderProvider();
    await screen.findByText("status: authenticated");

    act(() => emitAuthEvent("expired"));

    expect(screen.getByText("status: unauthenticated")).toBeDefined();
  });

  // A sign-in that settles while the bootstrap read is still in flight must
  // not be overwritten by that read's older answer.
  it("lets an event win over a slower bootstrap answer", async () => {
    let answer: (value: never) => void = () => {};
    fetchMe.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          answer = reject;
        }),
    );
    renderProvider();

    act(() => emitAuthEvent("signedIn"));
    await act(async () => answer(new Error("401") as never));

    expect(screen.getByText("status: authenticated")).toBeDefined();
  });
});
