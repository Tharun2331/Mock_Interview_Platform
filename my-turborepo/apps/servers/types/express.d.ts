export {};

declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        username: string;
        scopes: string[];
        // Cognito group memberships, from the `cognito:groups` claim on the
        // access token. Always an array — an absent claim means no groups, which
        // is the common case, and a `string[] | undefined` here would make every
        // membership check carry a null guard for a distinction nobody acts on.
        //
        // This is the only input to `RequireAdmin`. It is authorisation data
        // taken straight off a verified token, so it is exactly as trustworthy
        // as `id` is and no more — nothing may write to it after the verifier.
        groups: string[];
      };
    }
  }
}
