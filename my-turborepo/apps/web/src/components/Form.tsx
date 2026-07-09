import { useState } from "react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { toast } from "sonner"
import axios from "axios";
import { BACKEND_URL } from "@/lib/config";

export  function Form() {
   const [gitHub, setGitHub] = useState("");

   const handleSubmit = async () => {
      if (!gitHub) {
        toast.warning("Please provide valid GitHub URLs")
        return;
      }
      await axios.post(`${BACKEND_URL}/api/v1/pre-interview`, {
        gitHub
      })
       
   }
  return (
    <div className="h-screen w-screen flex flex-col justify-center items-center">
     <h2 className="scroll-m-20 border-b pb-2 text-3xl font-semibold tracking-tight first:mt-0">
      AI Interview Platform
    </h2>

        <div className="p-4">
          <Input placeholder="GitHub URL " onChange={e => setGitHub(e.target.value)} />
        </div>
        <div className="flex justify-center p-4">
            <Button className="cursor-pointer" onClick={handleSubmit}> Start Interview </Button>
        </div>
        
    </div>
  )
}