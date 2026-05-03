import { createAuthClient } from "better-auth/client";
import { sentinelClient } from "@better-auth/infra/client";
import { organizationClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({
  plugins: [sentinelClient(), organizationClient()],
});
