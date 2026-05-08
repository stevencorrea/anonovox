import { betterAuth } from "better-auth";
import { dash } from "@better-auth/infra";
import { organization } from "better-auth/plugins";
import { APIError } from "@better-auth/core/error";
import { ensureOrgMembership, handleEntraAccountCreated, handleEntraAccountUpdated } from "./org";
import { pgPool } from "./db";
import { sendVerificationEmail, sendInvitationEmail } from "./mailer";

const APP_BASE_URL = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";

function getTrustedOrigins(): string[] {
  const origins = new Set<string>([
    `http://localhost:${process.env.PORT ?? 3000}`,
    "http://localhost:3000",
    "https://anonovox.com"
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

function getEmailDomain(email: string): string | null {
  const [, domain] = email.trim().toLowerCase().split("@");
  return domain || null;
}

export const auth = betterAuth({
  baseURL: APP_BASE_URL,
  database: pgPool,
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
      console.log("[auth] Sending verification email", {
        email: user.email,
        callbackUrl: url,
      });
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
      organizationHooks: {
        beforeCreateInvitation: async ({ invitation, organization }) => {
          const inviteDomain = getEmailDomain(invitation.email);
          const orgDomain = organization.slug?.trim().toLowerCase();
          if (!inviteDomain || !orgDomain || inviteDomain !== orgDomain) {
            throw new APIError("BAD_REQUEST", {
              message: `Invitations are limited to @${orgDomain ?? "your workspace domain"}`,
            });
          }
        },
      },
    }),
  ],
  databaseHooks: {
    user: {
      create: {
        after: async (user) => {
          if (!user.email) return;
          await ensureOrgMembership({
            id: user.id,
            email: user.email,
          });
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
