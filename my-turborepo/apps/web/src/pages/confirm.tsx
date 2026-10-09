import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Navigate, useLocation, useNavigate } from "react-router";
import { toast } from "sonner";
import {
  ChangeEmailSchema,
  ConfirmSignupSchema,
  type ChangeEmailInput,
  type ConfirmSignupInput,
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
import { confirmSignUp } from "@/lib/authApi";
import { errorMessage } from "@/lib/errors";
import { AuthLayout } from "@/components/layout/AuthLayout";
import { MESSAGES } from "@/lib/messages";

// Handed over from the signup page via router state. Email only — the password
// is never passed here, because history state is readable by any script for the
// lifetime of the session.
type PendingSignup = { email: string };

function isPendingSignup(value: unknown): value is PendingSignup {
  return (
    typeof value === "object" &&
    value !== null &&
    "email" in value &&
    typeof value.email === "string"
  );
}

export function Confirm() {
  const navigate = useNavigate();
  const { state } = useLocation();
  const [isEditingEmail, setIsEditingEmail] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ConfirmSignupInput>({
    resolver: zodResolver(ConfirmSignupSchema),
    mode: "onTouched",
  });

  // A second form for correcting a mistyped address. Declared before the early
  // return below so hook order stays stable across renders.
  const pendingEmail = isPendingSignup(state) ? state.email : "";
  const emailForm = useForm<ChangeEmailInput>({
    resolver: zodResolver(ChangeEmailSchema),
    mode: "onTouched",
    defaultValues: { email: pendingEmail },
  });

  // No email to confirm against, so send the user back to sign up.
  if (!isPendingSignup(state)) {
    return <Navigate to="/signup" replace />;
  }

  // The address is the Cognito username, so it cannot be repointed on a pending
  // account. Hand it to the sign-up form instead, prefilled, and let the user
  // register the corrected address there.
  const onChangeEmail = emailForm.handleSubmit(({ email }) => {
    if (email.trim().toLowerCase() === state.email.trim().toLowerCase()) {
      toast.info(MESSAGES.CONFIRM_EDIT_EMAIL_UNCHANGED);
      setIsEditingEmail(false);
      return;
    }
    navigate("/signup", { replace: true, state: { email: email.trim() } });
  });

  const onSubmit = handleSubmit(async ({ code }) => {
    try {
      // An account a previous attempt already confirmed comes back as success
      // too — the server treats it as the outcome being asked for.
      await confirmSignUp(state.email, code);
    } catch (error) {
      toast.error(errorMessage(error, MESSAGES.AUTH_CONFIRM_FAILED));
      return;
    }

    // Confirmed, but not signed in. Amplify's autoSignIn rode on a session it
    // kept in the browser; the server-side equivalent would mean holding the
    // password between two requests, which it never does (ADR-0011). So the
    // candidate signs in once more, with the email already filled in.
    toast.info(MESSAGES.AUTH_SIGNED_UP_NOW_SIGN_IN);
    navigate("/signin", { replace: true, state: { email: state.email } });
  });

  return (
    <AuthLayout>
      <Card className="w-full">
        <CardHeader>
          <CardTitle className="font-display text-3xl font-normal">
            {isEditingEmail
              ? MESSAGES.CONFIRM_EDIT_EMAIL_TITLE
              : MESSAGES.CONFIRM_TITLE}
          </CardTitle>
          <CardDescription className="leading-relaxed">
            {isEditingEmail
              ? MESSAGES.CONFIRM_EDIT_EMAIL_HINT
              : MESSAGES.CONFIRM_DESCRIPTION(state.email)}
          </CardDescription>
        </CardHeader>

        {/* One form at a time: showing the code field beside an email field
            would put two submit actions on screen with no clear primary. */}
        {isEditingEmail ? (
          <form onSubmit={onChangeEmail} noValidate>
            <CardContent>
              <FieldGroup>
                <Field data-invalid={!!emailForm.formState.errors.email}>
                  <FieldLabel htmlFor="newEmail">
                    {MESSAGES.FIELD_EMAIL_LABEL}
                  </FieldLabel>
                  <Input
                    id="newEmail"
                    type="email"
                    autoComplete="email"
                    placeholder={MESSAGES.FIELD_EMAIL_PLACEHOLDER}
                    aria-invalid={!!emailForm.formState.errors.email}
                    {...emailForm.register("email")}
                  />
                  <FieldError
                    errors={
                      emailForm.formState.errors.email
                        ? [emailForm.formState.errors.email]
                        : undefined
                    }
                  />
                </Field>
              </FieldGroup>
            </CardContent>

            <CardFooter className="mt-6 flex-col gap-2">
              <Button type="submit" className="w-full">
                {MESSAGES.CONFIRM_EDIT_EMAIL_SUBMIT}
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="w-full cursor-pointer text-ink-subtle hover:text-ink"
                onClick={() => {
                  emailForm.reset({ email: state.email });
                  setIsEditingEmail(false);
                }}
              >
                {MESSAGES.CONFIRM_EDIT_EMAIL_CANCEL}
              </Button>
            </CardFooter>
          </form>
        ) : (
          <form onSubmit={onSubmit} noValidate>
            <CardContent>
              <FieldGroup>
                <Field data-invalid={!!errors.code}>
                  <FieldLabel htmlFor="code">
                    {MESSAGES.CONFIRM_CODE_LABEL}
                  </FieldLabel>
                  <Input
                    id="code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    placeholder={MESSAGES.CONFIRM_CODE_PLACEHOLDER}
                    aria-invalid={!!errors.code}
                    {...register("code")}
                  />
                  <FieldError
                    errors={errors.code ? [errors.code] : undefined}
                  />
                  <p className="text-xs leading-relaxed text-ink-subtle">
                    {MESSAGES.CONFIRM_SPAM_HINT}
                  </p>
                </Field>
              </FieldGroup>
            </CardContent>

            <CardFooter className="mt-6 flex-col gap-2">
              <Button type="submit" className="w-full" disabled={isSubmitting}>
                {isSubmitting
                  ? MESSAGES.CONFIRM_SUBMIT_PENDING
                  : MESSAGES.CONFIRM_SUBMIT}
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="w-full cursor-pointer text-ink-subtle hover:text-ink"
                disabled={isSubmitting}
                onClick={() => setIsEditingEmail(true)}
              >
                {MESSAGES.CONFIRM_EDIT_EMAIL}
              </Button>
            </CardFooter>
          </form>
        )}
      </Card>
    </AuthLayout>
  );
}
