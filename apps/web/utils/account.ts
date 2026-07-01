import { cookies } from "next/headers";
import { auth } from "@/utils/auth";
import { redirect } from "next/navigation";
import prisma from "@/utils/prisma";
import {
  LAST_EMAIL_ACCOUNT_COOKIE,
  parseLastEmailAccountCookieValue,
} from "@/utils/cookies";
import { buildLoginRedirectUrl, buildRedirectUrl } from "@/utils/redirect";

export async function redirectToEmailAccountPath(
  path: `/${string}`,
  searchParams?: Record<string, string | string[] | undefined>,
) {
  const session = await auth();
  const userId = session?.user.id;
  if (!userId) {
    redirect(buildLoginRedirectUrl(buildRedirectUrl(path, searchParams)));
  }

  const lastEmailAccountId = await getLastEmailAccountFromCookie(userId);

  let emailAccountId = lastEmailAccountId;

  // If no last account or it doesn't exist, fall back to first account
  if (!emailAccountId) {
    const emailAccount = await prisma.emailAccount.findFirst({
      where: { userId },
    });
    emailAccountId = emailAccount?.id ?? null;
  }

  // Signed in but no mailbox connected yet (possible with email/password
  // signup, which doesn't create an EmailAccount) — send them to add one.
  if (!emailAccountId) {
    redirect("/accounts");
  }

  const redirectUrl = buildRedirectUrl(
    `/${emailAccountId}${path}`,
    searchParams,
  );

  redirect(redirectUrl);
}

async function getLastEmailAccountFromCookie(
  userId: string,
): Promise<string | null> {
  try {
    const cookieStore = await cookies();
    const cookieValue = cookieStore.get(LAST_EMAIL_ACCOUNT_COOKIE)?.value;
    return parseLastEmailAccountCookieValue({ userId, cookieValue });
  } catch {
    return null;
  }
}
