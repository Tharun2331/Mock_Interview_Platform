import express from "express";
import cors from "cors";
import { PreInterviewBody } from "./types";
import axios from "axios";

const app = express();
const corsOptions = {
  origin: "http://localhost:3000"
}
app.use(cors(corsOptions));
app.use(express.json());

app.post("/api/v1/pre-interview", async (req,res) => {
  const {success,data} = PreInterviewBody.safeParse(req.body);
  if (!success) {
    res.status(411).json({
      message: "Incorrect body"
    });
    return
  }
  const githubUrl = data.github?.endsWith("/") ? data.github?.slice(0, -1) : data.github ;

  const githubUsername = githubUrl.split("/").pop();


  const userRepos = await axios.get(`https://api.github.com/users/${githubUsername}/repos`)
  const filteredUseRepos = userRepos.data.map((x: any) => ({
    description: x.description,
    name: x.name,
    fullName: x.full_name,
    startCount: x.stargazers_count
  }))

console.log(filteredUseRepos)
})

app.listen(8000);