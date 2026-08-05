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
import { AuthProvider } from "./lib/auth";


export function App() {

  return (
    <BrowserRouter>
    <AuthProvider>
    <Routes>
    <Route path="/" element={<Navigate to="/signup" replace />} />
    <Route path="/signup" element={<Signup />} />
    <Route path="/signin" element={<SignIn />} />
    <Route path="/confirm" element={<Confirm />} />
    <Route path="/callback" element={<Callback />} />
    <Route element={<RequireAuth />}>
      <Route element={<AppShell />}>
        <Route path="/form" element={<Form />} />
        <Route path="/interview" element={<Interview />} />
        <Route path="/results" element={<Result />} />
      </Route>
    </Route>
    <Route path="*" element={<Navigate to="/form" replace />} />
    </Routes>
    <Toaster duration={3000} position= "top-center" />
    </AuthProvider>
    </BrowserRouter>
  );
}

export default App;
