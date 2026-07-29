import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Link, useNavigate } from "react-router";
import { toast } from "sonner";
import { signIn, signInWithRedirect } from "aws-amplify/auth";
import { SigninSchema, type SignInInput } from "@repo/shared";

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
import { GoogleIcon } from "@/components/GoogleIcon";
import { errorMessage } from "@/lib/errors";

// Cognito throws this when a session already exists (common in dev after a
// hot reload). It means the user is effectively signed in, so we can proceed.
function isAlreadyAuthenticated(error: unknown): boolean {
  return error instanceof Error && error.name === "UserAlreadyAuthenticatedException";
}

export function SignIn() {
  const navigate = useNavigate();
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<SignInInput>({
    resolver: zodResolver(SigninSchema),
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
        toast.info("Please confirm your email to finish signing in.");
        navigate("/confirm", {
          state: { email: values.email, password: values.password },
        });
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
      toast.error(errorMessage(error, "Sign-in failed. Check your credentials."));
    }
  });

  // Kicks off the Cognito hosted-UI redirect to Google. On return, the browser
  // lands on /callback where Amplify finishes the token exchange.
  async function handleGoogle() {
    try {
      await signInWithRedirect({ provider: "Google" });
    } catch (error) {
      toast.error(errorMessage(error, "Google sign-in failed. Please try again."));
    }
  }

  return (
    <div className="flex min-h-screen w-full items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Welcome back</CardTitle>
          <CardDescription>
            Sign in to continue practising interviews.
          </CardDescription>
        </CardHeader>

        <CardContent>
          <Button
            type="button"
            variant="outline"
            className="w-full"
            onClick={handleGoogle}
          >
            <GoogleIcon className="size-4" />
            Continue with Google
          </Button>

          <div className="mt-6 flex items-center gap-3">
            <Separator className="flex-1" />
            <span className="text-muted-foreground text-xs">
              or sign in with email
            </span>
            <Separator className="flex-1" />
          </div>
        </CardContent>

        <form onSubmit={onSubmit} noValidate>
          <CardContent>
            <FieldGroup>
              <Field data-invalid={!!errors.email}>
                <FieldLabel htmlFor="email">Email</FieldLabel>
                <Input
                  id="email"
                  type="email"
                  autoComplete="email"
                  placeholder="you@example.com"
                  aria-invalid={!!errors.email}
                  {...register("email")}
                />
                <FieldError errors={errors.email ? [errors.email] : undefined} />
              </Field>

              <Field data-invalid={!!errors.password}>
                <FieldLabel htmlFor="password">Password</FieldLabel>
                <Input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  placeholder="••••••••"
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
              {isSubmitting ? "Signing in…" : "Sign in"}
            </Button>
            <p className="text-muted-foreground text-sm">
              Don&apos;t have an account?{" "}
              <Link to="/signup" className="text-primary underline-offset-4 hover:underline">
                Sign up
              </Link>
            </p>
          </CardFooter>
        </form>
      </Card>
    </div>
  );
}
