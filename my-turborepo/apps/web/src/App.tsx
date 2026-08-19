import "../styles/globals.css"
import { Form } from "./pages/form";
import { BrowserRouter, Routes, Route, Navigate  } from "react-router";
import { Result } from "./pages/result";
import { Interview } from "./pages/interview";
import {Signup} from "./pages/signup";
import { SignIn } from "./pages/signin";
import { Confirm } from "./pages/confirm";
import { Callback } from "./pages/callback";
import { Toaster } from "sonner";
import { AppShell } from "./components/layout/AppShell";
import { RequireAuth } from "./components/layout/RequireAuth";
import { RedirectIfAuthenticated } from "./components/layout/RedirectIfAuthenticated";
import { AuthProvider } from "./lib/auth";


export function App() {

  return (
    <BrowserRouter>
    <AuthProvider>
    <Routes>
    <Route path="/" element={<Navigate to="/signup" replace />} />

    {/* Signed-in users are bounced to /form so they never see a sign-in form
        they cannot use — clicking Google here throws UserAlreadyAuthenticated. */}
    <Route element={<RedirectIfAuthenticated />}>
      <Route path="/signup" element={<Signup />} />
      <Route path="/signin" element={<SignIn />} />
    </Route>

    {/* Deliberately unguarded: /confirm completes sign-in via autoSignIn() and
        must stay reachable to verify a code, and /callback must stay mounted to
        finish the hosted-UI code exchange. */}
    <Route path="/confirm" element={<Confirm />} />
    <Route path="/callback" element={<Callback />} />

    <Route element={<RequireAuth />}>
      <Route element={<AppShell />}>
        <Route path="/form" element={<Form />} />
        <Route path="/interview" element={<Interview />} />
        <Route path="/results" element={<Result />} />
      </Route>
    </Route>
    {/* Unknown paths resolve at "/" instead of being laundered through the
        protected tree, so an unauthenticated 404 no longer presents as a
        failed auth check. "/" then routes by session state. */}
    <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    <Toaster duration={3000} position= "top-center" />
    </AuthProvider>
    </BrowserRouter>
  );
}

export default App;
