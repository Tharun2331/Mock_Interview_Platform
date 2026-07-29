import z from "zod";

// Mirrors the Cognito user pool: sign-up is by email (username_attributes = ["email"])
// and the password rules match Cognito's default policy (min 8 + upper/lower/number/symbol).
export const SignupSchema = z
  .object({
    email: z.email("Enter a valid email address."),
    password: z
      .string()
      .min(8, "Password must be at least 8 characters long.")
      .regex(/[a-z]/, "Password must contain a lowercase letter.")
      .regex(/[A-Z]/, "Password must contain an uppercase letter.")
      .regex(/[0-9]/, "Password must contain a number.")
      .regex(/[^A-Za-z0-9]/, "Password must contain a symbol."),
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwords do not match.",
    path: ["confirmPassword"],
  });

export type SignupInput = z.infer<typeof SignupSchema>;

// Cognito emails a 6-digit confirmation code after sign-up.
export const ConfirmSignupSchema = z.object({
  code: z.string().regex(/^\d{6}$/, "Enter the 6-digit code from your email."),
});

export type ConfirmSignupInput = z.infer<typeof ConfirmSignupSchema>;

// Sign-in only checks that a password was entered — Cognito verifies it.
// (The full complexity rules live on SignupSchema, where they're enforced.)
export const SigninSchema = z.object({
  email: z.email("Enter a valid email address."),
  password: z.string().min(1, "Enter your password."),
});


export type SignInInput = z.infer<typeof SigninSchema>;


