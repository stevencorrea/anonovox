import { betterAuth } from "better-auth";
import { Database } from "bun:sqlite";
import { dash } from "@better-auth/infra";

export const auth = betterAuth({
  baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
  database: new Database("database.sqlite"),
  emailAndPassword: {
    enabled: true,
  },
  trustedOrigins: [
    process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
    "https://aliana-nonepiscopalian-dissidently.ngrok-free.dev",
    "https://anonovox.onrender.com",
    "https://anonovox.com",
  ],
  plugins: [dash()],
});
