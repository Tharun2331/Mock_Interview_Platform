import axios from "axios";
import { password } from "bun";

export async function scrapeGithub(username: string) {
    const userRepos = await axios.get(`https://api.github.com/users/${username}/repos`, {
      proxy: {
        host: "gw.dataimpulse.com",
        port: 823,
        auth: {
          username: process.env.DATAIMPULSE_PROXY_USER!,
          password: process.env.DATAIMPULSE_PROXY_PASSWORD!,
        },
        protocol: "http"
      }
    })
    
    return userRepos.data.map((x:any) => ({
      description: x.description,
      name: x.name,
      fullName: x.full_name,
      starCount: x.stargazers_count
    }))
}