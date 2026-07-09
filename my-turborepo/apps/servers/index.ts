import express from "express";
import cors from "cors";
import { PreInterviewBody } from "@repo/shared";
import axios from "axios";
import { planRouter } from "./routes/plan";

const app = express();
const corsOptions = {
  origin: "http://localhost:3000"
}
app.use(cors(corsOptions));
app.use(express.json());
app.use("/api/v1/plan", planRouter);

app.post("/api/v1/pre-interview", async (req,res) => {
  const {success,data} = PreInterviewBody.safeParse(req.body);
  if (!success) {
    res.status(411).json({
      message: "Incorrect body"
    });
    return
  }
  const githubUrl = data.gitHub?.endsWith("/") ? data.gitHub?.slice(0, -1) : data.gitHub ;

  const githubUsername = githubUrl.split("/").pop();


  try {
    const userRepos = await axios.get(`https://api.github.com/users/${githubUsername}/repos`)
    const filteredUseRepos = userRepos.data.map((x: any) => ({
      description: x.description,
      name: x.name,
      fullName: x.full_name,
      starCount: x.stargazers_count
    }))

    res.json({ repos: filteredUseRepos })
  } catch (e) {
    res.status(500).json({ message: "Failed to fetch GitHub repos" })
  }
})

app.listen(8000);