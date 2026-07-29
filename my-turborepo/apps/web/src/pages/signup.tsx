import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Link, useNavigate } from "react-router";
import { toast } from "sonner";
import { signUp, signIn, signInWithRedirect } from "aws-amplify/auth";
import { SignupSchema, type SignupInput } from "@repo/shared";


import {
  Field,
  FieldDescription,
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

export function Signup() {
  const navigate = useNavigate();
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<SignupInput>({
    resolver: zodResolver(SignupSchema),
    mode: "onTouched",
  });

  const onSubmit = handleSubmit(async (values) => {
    try {
      const { nextStep } = await signUp({
        username: values.email,
        password: values.password,
        options: { userAttributes: { email: values.email } },
      });

      if (nextStep.signUpStep === "CONFIRM_SIGN_UP") {
        toast.info("We emailed you a 6-digit confirmation code.");
        // Hand the credentials to the confirm page via in-memory router state
        // (not the URL) so it can sign in once the code is verified.
        navigate("/confirm", {
          state: { email: values.email, password: values.password },
        });
        return;
      }

      if (nextStep.signUpStep === "DONE") {
        await signIn({ username: values.email, password: values.password });
        navigate("/form");
      }
    } catch (error) {
      toast.error(errorMessage(error, "Sign-up failed. Please try again."));
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
          <CardTitle>Create your account</CardTitle>
          <CardDescription>
            Sign up with your email to start practising interviews.
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
              or sign up with email
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
                  autoComplete="new-password"
                  placeholder="••••••••"
                  aria-invalid={!!errors.password}
                  {...register("password")}
                />
                <FieldDescription>
                  At least 8 characters, with upper- and lowercase letters, a
                  number, and a symbol.
                </FieldDescription>
                <FieldError
                  errors={errors.password ? [errors.password] : undefined}
                />
              </Field>

              <Field data-invalid={!!errors.confirmPassword}>
                <FieldLabel htmlFor="confirmPassword">
                  Confirm password
                </FieldLabel>
                <Input
                  id="confirmPassword"
                  type="password"
                  autoComplete="new-password"
                  placeholder="••••••••"
                  aria-invalid={!!errors.confirmPassword}
                  {...register("confirmPassword")}
                />
                <FieldError
                  errors={
                    errors.confirmPassword ? [errors.confirmPassword] : undefined
                  }
                />
              </Field>
            </FieldGroup>
          </CardContent>

          <CardFooter className="mt-6 flex-col gap-4">
            <Button type="submit" className="w-full" disabled={isSubmitting}>
              {isSubmitting ? "Creating account…" : "Create account"}
            </Button>
            <p className="text-muted-foreground text-sm">
              Already have an account?{" "}
              <Link to="/signin" className="text-primary underline-offset-4 hover:underline">
                Sign in
              </Link>
            </p>
          </CardFooter>
        </form>
      </Card>
    </div>
  );
}
