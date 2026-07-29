import express from "express";
import cors from "cors";
import { config } from "./lib/config";
import { planRouter } from "./routes/plan";
import { preInterviewRouter } from "./routes/preInterview";
import { AuthMiddleware } from "./lib/cognitoAuth";
const app = express();

app.use(cors({ origin: config.corsOrigin }));
app.use(express.json());

app.use("/api/v1/pre-interview", AuthMiddleware, preInterviewRouter);
app.use("/api/v1/plan", AuthMiddleware, planRouter);

app.listen(config.port);
