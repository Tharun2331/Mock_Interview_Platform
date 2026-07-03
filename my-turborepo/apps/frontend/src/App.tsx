import { useState } from "react";
import "../styles/globals.css"
import { Form } from "./components/Form";
import { BrowserRouter, Routes, Route, Navigate  } from "react-router";
import { Result } from "./components/Result";
import { Interview } from "./components/Interview";
import { Toaster } from "sonner";

export function App() {
  const [page, SetPage] = useState<"form" | "interview" | "result">("form");

  return (
    <BrowserRouter>
    <Routes>
    <Route path="/form" element={page == "form" ? <Form />: <Navigate to = {`${page}`} /> } />
    <Route path="/interview" element={page == "interview" ? <Interview />: <Navigate to = {`${page}`} /> }/>
    <Route path="/results" element= {page == "result" ? <Result /> : <Navigate to  = {`${page}`}/>}/>
    <Route path="*" element={<Navigate to="/form" />} />
    </Routes>
    <Toaster duration={3000} position= "top-center" />
    </BrowserRouter>
  );
}

export default App;
