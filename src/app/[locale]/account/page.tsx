import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { routing } from "@/i18n/routing";
import { auth } from "@/server/auth/auth-server";
import { SignoutButton } from "./signout-button";

export default async function AccountPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("auth");

  const h = await headers();
  const session = await auth.api.getSession({ headers: h });
  if (!session) redirect(`/${locale}/signin`);

  return (
    <main className="flex min-h-screen items-start justify-center p-6 pt-12">
      <div className="w-full max-w-md">
        <h1 className="text-2xl font-semibold tracking-tight">{t("accountTitle")}</h1>
        <p className="mt-2 text-sm text-neutral-700 dark:text-neutral-300">{t("accountWelcome")}</p>
        <dl className="mt-6 grid grid-cols-1 gap-3 text-sm">
          <div>
            <dt className="text-neutral-500 dark:text-neutral-400">Email</dt>
            <dd className="break-all font-mono">{session.user.email}</dd>
          </div>
        </dl>
        <div className="mt-8">
          <SignoutButton />
        </div>
      </div>
    </main>
  );
}

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}
