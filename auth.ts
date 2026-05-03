import { betterAuth } from "better-auth";
import { Pool } from "pg";
import { dash } from "@better-auth/infra";
import { organization } from "better-auth/plugins";
import { ensureOrgMembership, handleEntraAccountCreated, handleEntraAccountUpdated } from "./org";
import { sendVerificationEmail, sendInvitationEmail } from "./mailer";

export const auth = betterAuth({
  baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
  database: new Pool({
    connectionString: process.env.DATABASE_URL,
  }),
  emailAndPassword: {
    enabled: true,
  },
  socialProviders: {
    microsoft: {
      clientId: process.env.MICROSOFT_CLIENT_ID ?? "",
      clientSecret: process.env.MICROSOFT_CLIENT_SECRET ?? "",
      tenantId: process.env.MICROSOFT_TENANT_ID ?? "common",
      mapProfileToUser: (profile) => ({
        name: profile.name,
        email: profile.email ?? profile.preferred_username,
        image: profile.picture,
        emailVerified: true,
      }),
    },
  },
  emailVerification: {
    sendOnSignUp: true,
    sendVerificationEmail: async ({ user, url }) => {
      await sendVerificationEmail(user.email, url);
    },
  },
  trustedOrigins: [
    `http://localhost:${process.env.PORT ?? 3000}`,
    process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
    "https://aliana-nonepiscopalian-dissidently.ngrok-free.dev",
    "https://anonovox.onrender.com",
    "https://anonovox.com",
  ],
  plugins: [
    dash(),
    organization({
      creatorRole: "owner",
      sendInvitationEmail: async (data) => {
        const baseUrl = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
        const acceptUrl = `${baseUrl}/api/auth/organization/accept-invitation?id=${data.invitation.id}`;
        await sendInvitationEmail(
          data.email,
          data.inviter.name ?? data.inviter.email,
          data.organization.name,
          acceptUrl,
        );
      },
    }),
  ],
  databaseHooks: {
    user: {
      create: {
        after: async (user) => {
          await ensureOrgMembership(user);
        },
      },
    },
    account: {
      create: {
        after: async (account) => {
          await handleEntraAccountCreated(account);
        },
      },
      update: {
        after: async (account) => {
          await handleEntraAccountUpdated(account);
        },
      },
    },
  },
});
