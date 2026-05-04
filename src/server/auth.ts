import { betterAuth } from "better-auth";
import { Pool } from "pg";
import { dash } from "@better-auth/infra";
import { organization } from "better-auth/plugins";
import { ensureOrgMembership, handleEntraAccountCreated, handleEntraAccountUpdated } from "./org";
import { sendVerificationEmail, sendInvitationEmail } from "./mailer";

const APP_BASE_URL = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";

function getTrustedOrigins(): string[] {
  const origins = new Set<string>([
    `http://localhost:${process.env.PORT ?? 3000}`,
    "http://localhost:3000",
  ]);

  const configured = [
    APP_BASE_URL,
    ...(process.env.ADDITIONAL_TRUSTED_ORIGINS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  ];

  for (const value of configured) {
    try {
      origins.add(new URL(value).origin);
    } catch {
      console.warn("[auth] Ignoring invalid trusted origin:", value);
    }
  }

  return [...origins];
}

export const auth = betterAuth({
  baseURL: APP_BASE_URL,
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
  trustedOrigins: getTrustedOrigins(),
  plugins: [
    dash(),
    organization({
      creatorRole: "owner",
      sendInvitationEmail: async (data) => {
        const acceptUrl = `${APP_BASE_URL}/accept-invitation?id=${data.invitation.id}`;
        await sendInvitationEmail(
          data.email,
          data.inviter.user.name ?? data.inviter.user.email,
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
          await handleEntraAccountCreated({
            userId: account.userId,
            providerId: account.providerId,
            idToken: account.idToken,
          });
        },
      },
      update: {
        after: async (account) => {
          await handleEntraAccountUpdated({
            userId: account.userId,
            providerId: account.providerId,
            idToken: account.idToken,
          });
        },
      },
    },
  },
});
