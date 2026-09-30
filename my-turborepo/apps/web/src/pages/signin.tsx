import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Link, useNavigate } from "react-router";
import { toast } from "sonner";
import { confirmSignIn, signIn, signInWithRedirect } from "aws-amplify/auth";
import {
  SigninSchema,
  TotpCodeSchema,
  type SignInInput,
  type TotpCodeInput,
} from "@repo/shared";

import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { AuthLayout } from "@/components/layout/AuthLayout";
import { GoogleIcon } from "@/components/GoogleIcon";
import { errorMessage, isAlreadyAuthenticated } from "@/lib/errors";
import { MESSAGES } from "@/lib/messages";

// Reached only for an account that turned on TOTP in Settings. `confirmSignIn`
// continues the SAME pending Cognito sign-in `signIn()` started, using no
// stored credentials of its own — which is why this is a second render mode
// of this page rather than a route: navigating away would mean re-mounting
// this component and losing whatever in-memory state Amplify is tracking for
// that pending sign-in.
type Step = "credentials" | "totp";

export function SignIn() {
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>("credentials");

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<SignInInput>({
    resolver: zodResolver(SigninSchema),
    mode: "onTouched",
  });

  const totpForm = useForm<TotpCodeInput>({
    resolver: zodResolver(TotpCodeSchema),
    mode: "onTouched",
  });

  const onSubmit = handleSubmit(async (values) => {
    try {
      const { nextStep } = await signIn({
        username: values.email,
        password: values.password,
      });

      // Account exists but the email was never verified — send the user
      // through the same confirmation flow as sign-up.
      if (nextStep.signInStep === "CONFIRM_SIGN_UP") {
        toast.info(MESSAGES.AUTH_NOT_CONFIRMED);
        // Email only — the password stays out of history state. Confirming from
        // this path ends at /signin rather than auto-signing in, because no
        // autoSignIn flow was started here.
        navigate("/confirm", { state: { email: values.email } });
        return;
      }

      // The password checked out; a code from their authenticator app is the
      // second factor. The pool's MFA setting is OPTIONAL, so this step only
      // appears for an account that has already enrolled in Settings.
      if (nextStep.signInStep === "CONFIRM_SIGN_IN_WITH_TOTP_CODE") {
        totpForm.reset();
        setStep("totp");
        return;
      }

      if (nextStep.signInStep === "DONE") {
        navigate("/form");
      }
    } catch (error) {
      if (isAlreadyAuthenticated(error)) {
        navigate("/form");
        return;
      }
      toast.error(errorMessage(error, MESSAGES.AUTH_SIGNIN_FAILED));
    }
  });

  const onVerifyTotp = totpForm.handleSubmit(async ({ code }) => {
    try {
      const { nextStep } = await confirmSignIn({ challengeResponse: code });
      if (nextStep.signInStep === "DONE") {
        navigate("/form");
      }
      // Any other nextStep here is a pool configuration this app does not
      // otherwise produce (a second MFA method, a further challenge) — left
      // unhandled rather than guessed at, the same way the credentials step
      // above only acts on the two outcomes it knows.
    } catch (error) {
      // A wrong or expired code. The pending sign-in survives a failed
      // attempt, so the candidate stays on this step and can retry without
      // re-entering their password.
      toast.error(errorMessage(error, MESSAGES.AUTH_CODE_INVALID));
    }
  });

  // Kicks off the Cognito hosted-UI redirect to Google. On return, the browser
  // lands on /callback where Amplify finishes the token exchange.
  async function handleGoogle() {
    try {
      await signInWithRedirect({ provider: "Google" });
    } catch (error) {
      // A session already exists (e.g. another tab signed in). Nothing is
      // wrong — send the user where the redirect would have taken them.
      if (isAlreadyAuthenticated(error)) {
        navigate("/form", { replace: true });
        return;
      }
      toast.error(errorMessage(error, MESSAGES.AUTH_GOOGLE_FAILED));
    }
  }

  // One form at a time, same reasoning as the confirm page's email-edit
  // toggle: two submit actions on screen at once leaves no clear primary.
  if (step === "totp") {
    return (
      <AuthLayout>
        <Card className="w-full">
          <CardHeader>
            <CardTitle className="font-display text-3xl font-normal">
              {MESSAGES.SIGNIN_TOTP_TITLE}
            </CardTitle>
            <CardDescription>
              {MESSAGES.SIGNIN_TOTP_DESCRIPTION}
            </CardDescription>
          </CardHeader>

          <form onSubmit={onVerifyTotp} noValidate>
            <CardContent>
              <FieldGroup>
                <Field data-invalid={!!totpForm.formState.errors.code}>
                  <FieldLabel htmlFor="totp-code">
                    {MESSAGES.SIGNIN_TOTP_CODE_LABEL}
                  </FieldLabel>
                  <Input
                    id="totp-code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    placeholder={MESSAGES.CONFIRM_CODE_PLACEHOLDER}
                    aria-invalid={!!totpForm.formState.errors.code}
                    {...totpForm.register("code")}
                  />
                  <FieldError
                    errors={
                      totpForm.formState.errors.code
                        ? [totpForm.formState.errors.code]
                        : undefined
                    }
                  />
                </Field>
              </FieldGroup>
            </CardContent>

            <CardFooter className="mt-6 flex-col gap-2">
              <Button
                type="submit"
                className="w-full"
                disabled={totpForm.formState.isSubmitting}
              >
                {totpForm.formState.isSubmitting
                  ? MESSAGES.SIGNIN_TOTP_SUBMIT_PENDING
                  : MESSAGES.SIGNIN_TOTP_SUBMIT}
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="w-full cursor-pointer text-ink-subtle hover:text-ink"
                disabled={totpForm.formState.isSubmitting}
                onClick={() => setStep("credentials")}
              >
                {MESSAGES.SIGNIN_TOTP_BACK}
              </Button>
            </CardFooter>
          </form>
        </Card>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <Card className="w-full">
        <CardHeader>
          <CardTitle className="font-display text-3xl font-normal">
            {MESSAGES.SIGNIN_TITLE}
          </CardTitle>
          <CardDescription>{MESSAGES.SIGNIN_DESCRIPTION}</CardDescription>
        </CardHeader>

        <CardContent>
          <Button
            type="button"
            variant="outline"
            className="w-full"
            onClick={handleGoogle}
          >
            <GoogleIcon className="size-4" />
            {MESSAGES.CONTINUE_WITH_GOOGLE}
          </Button>

          <div className="mt-6 flex items-center gap-3">
            <Separator className="flex-1" />
            <span className="text-xs text-ink-faint">
              {MESSAGES.SIGNIN_DIVIDER}
            </span>
            <Separator className="flex-1" />
          </div>
        </CardContent>

        <form onSubmit={onSubmit} noValidate>
          <CardContent>
            <FieldGroup>
              <Field data-invalid={!!errors.email}>
                <FieldLabel htmlFor="email">
                  {MESSAGES.FIELD_EMAIL_LABEL}
                </FieldLabel>
                <Input
                  id="email"
                  type="email"
                  autoComplete="email"
                  placeholder={MESSAGES.FIELD_EMAIL_PLACEHOLDER}
                  aria-invalid={!!errors.email}
                  {...register("email")}
                />
                <FieldError
                  errors={errors.email ? [errors.email] : undefined}
                />
              </Field>

              <Field data-invalid={!!errors.password}>
                <FieldLabel htmlFor="password">
                  {MESSAGES.FIELD_PASSWORD_LABEL}
                </FieldLabel>
                <Input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  placeholder={MESSAGES.FIELD_PASSWORD_PLACEHOLDER}
                  aria-invalid={!!errors.password}
                  {...register("password")}
                />
                <FieldError
                  errors={errors.password ? [errors.password] : undefined}
                />
              </Field>
            </FieldGroup>
          </CardContent>

          <CardFooter className="mt-6 flex-col gap-4">
            <Button type="submit" className="w-full" disabled={isSubmitting}>
              {isSubmitting
                ? MESSAGES.SIGNIN_SUBMIT_PENDING
                : MESSAGES.SIGNIN_SUBMIT}
            </Button>
            <p className="text-sm text-ink-subtle">
              {MESSAGES.SIGNIN_NO_ACCOUNT}{" "}
              <Link
                to="/signup"
                className="text-cue-ink underline-offset-4 hover:underline"
              >
                {MESSAGES.SIGNIN_SIGNUP_LINK}
              </Link>
            </p>
          </CardFooter>
        </form>
      </Card>
    </AuthLayout>
  );
}
