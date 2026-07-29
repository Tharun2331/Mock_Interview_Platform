import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Navigate, useLocation, useNavigate } from "react-router";
import { toast } from "sonner";
import { confirmSignUp, signIn, signOut } from "aws-amplify/auth";
import { ConfirmSignupSchema, type ConfirmSignupInput } from "@repo/shared";

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
import { errorMessage } from "@/lib/errors";

// Credentials handed over from the signup page via router state.
type PendingCredentials = { email: string; password: string };

function isPendingCredentials(value: unknown): value is PendingCredentials {
  return (
    typeof value === "object" &&
    value !== null &&
    "email" in value &&
    typeof value.email === "string" &&
    "password" in value &&
    typeof value.password === "string"
  );
}

// Cognito rejects re-confirming an already-CONFIRMED user with this exact error.
// It means confirmation already succeeded, so we can safely proceed to sign-in.
function isAlreadyConfirmed(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.name === "NotAuthorizedException" &&
    error.message.includes("Current status is CONFIRMED")
  );
}

export function Confirm() {
  const navigate = useNavigate();
  const { state } = useLocation();

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ConfirmSignupInput>({
    resolver: zodResolver(ConfirmSignupSchema),
    mode: "onTouched",
  });

  // no email/password to confirm against, so send the user back to sign up.
  if (!isPendingCredentials(state)) {
    return <Navigate to="/signup" replace />;
  }

  const onSubmit = handleSubmit(async ({ code }) => {
    try {
      await confirmSignUp({ username: state.email, confirmationCode: code });
    } catch (error) {
      // A prior attempt may have already confirmed the account (then failed at
      // sign-in). If so, don't block — fall through and sign in. Any other
      // error (e.g. a wrong/expired code) is surfaced so the user can retry.
      if (!isAlreadyConfirmed(error)) {
        toast.error(errorMessage(error, "Confirmation failed. Check the code."));
        return;
      }
    }

    try {
      // Clear any stale session (common in dev) so signIn doesn't throw
      // UserAlreadyAuthenticatedException, then sign in fresh.
      await signOut();
      await signIn({ username: state.email, password: state.password });
      navigate("/form");
    } catch (error) {
      toast.error(
        errorMessage(error, "Signed up, but sign-in failed. Try logging in.")
      );
    }
  });

  return (
    <div className="flex min-h-screen w-full items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Confirm your email</CardTitle>
          <CardDescription>
            Enter the 6-digit code we sent to {state.email}.
          </CardDescription>
        </CardHeader>

        <form onSubmit={onSubmit} noValidate>
          <CardContent>
            <FieldGroup>
              <Field data-invalid={!!errors.code}>
                <FieldLabel htmlFor="code">Confirmation code</FieldLabel>
                <Input
                  id="code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="123456"
                  aria-invalid={!!errors.code}
                  {...register("code")}
                />
                <FieldError errors={errors.code ? [errors.code] : undefined} />
              </Field>
            </FieldGroup>
          </CardContent>

          <CardFooter className="mt-6">
            <Button type="submit" className="w-full" disabled={isSubmitting}>
              {isSubmitting ? "Confirming…" : "Confirm and continue"}
            </Button>
          </CardFooter>
        </form>
      </Card>
    </div>
  );
}
