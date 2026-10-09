import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router";
import { toast } from "sonner";
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
import { LegalNotice } from "@/components/LegalNotice";
import { confirmTotpSignIn, signIn, startGoogleSignIn } from "@/lib/authApi";
import { AuthApiError, errorMessage, mfaErrorMessage } from "@/lib/errors";
import { MESSAGES } from "@/lib/messages";

// Reached only for an account that turned on TOTP in Settings. The code
// continues the SAME pending Cognito sign-in the password step started; the
// server holds that pending sign-in in an httpOnly cookie, so only the code
// travels. A second render mode of this page rather than a route, so "back"
// returns to a form that still has the email in it.
type Step = "credentials" | "totp";

// Where the server sends a Google sign-in that failed or was refused.
const GOOGLE_ERROR_PARAM = "error";
const GOOGLE_ERROR_VALUE = "google";

// Email only, from router state; the password never travels between pages.
function handedOverEmail(state: unknown): string {
  if (
    typeof state === "object" &&
    state !== null &&
    "email" in state &&
    typeof state.email === "string"
  ) {
    return state.email;
  }
  return "";
}

export function SignIn() {
  const navigate = useNavigate();
  const location = useLocation();
  const [step, setStep] = useState<Step>("credentials");
  const [searchParams, setSearchParams] = useSearchParams();

  // Said once, then removed from the URL, so a reload does not repeat it.
  //
  // Deferred a tick, because this runs on the page's FIRST render: the app's
  // <AppToaster /> sits after <Routes>, so its effect — where Sonner subscribes
  // — runs after this one, and a toast raised now is dropped with nobody
  // listening. The cleanup also stops StrictMode's double effect run from
  // showing it twice.
  useEffect(() => {
    if (searchParams.get(GOOGLE_ERROR_PARAM) !== GOOGLE_ERROR_VALUE) return;
    const timer = setTimeout(() => {
      toast.error(MESSAGES.AUTH_GOOGLE_FAILED);
      setSearchParams({}, { replace: true });
    }, 0);
    return () => clearTimeout(timer);
  }, [searchParams, setSearchParams]);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<SignInInput>({
    resolver: zodResolver(SigninSchema),
    mode: "onTouched",
    // The confirm page sends the just-confirmed address here, so only the
    // password has to be typed again.
    defaultValues: { email: handedOverEmail(location.state) },
  });

  const totpForm = useForm<TotpCodeInput>({
    resolver: zodResolver(TotpCodeSchema),
    mode: "onTouched",
  });

  const onSubmit = handleSubmit(async (values) => {
    try {
      const next = await signIn(values.email, values.password);

      // Account exists but the email was never verified — send the user
      // through the same confirmation flow as sign-up.
      if (next === "CONFIRM_SIGN_UP") {
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
      if (next === "TOTP") {
        totpForm.reset();
        setStep("totp");
        return;
      }

      navigate("/form");
    } catch (error) {
      toast.error(errorMessage(error, MESSAGES.AUTH_SIGNIN_FAILED));
    }
  });

  const onVerifyTotp = totpForm.handleSubmit(async ({ code }) => {
    try {
      const next = await confirmTotpSignIn(code);
      if (next === "DONE") {
        navigate("/form");
      }
      // Any other step here is a pool configuration this app does not
      // otherwise produce (a further challenge) — left unhandled rather than
      // guessed at, the same way the credentials step only acts on the
      // outcomes it knows.
    } catch (error) {
      // The pending sign-in lasts three minutes. Past that, a code cannot
      // help: back to the password, with the email still filled in.
      if (error instanceof AuthApiError && error.code === "SIGNIN_EXPIRED") {
        toast.error(MESSAGES.AUTH_SIGNIN_EXPIRED);
        setStep("credentials");
        return;
      }
      // A wrong code. The pending sign-in survives a failed attempt, so the
      // candidate stays on this step and can retry without re-entering their
      // password.
      toast.error(mfaErrorMessage(error, MESSAGES.AUTH_CODE_INVALID));
    }
  });

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
            onClick={startGoogleSignIn}
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
            {/* Here too, because "Continue with Google" on this page creates an
                account for someone who has never signed up. */}
            <LegalNotice className="text-center" />
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
