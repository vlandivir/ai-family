import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

export async function serverAuth() {
  const cookieStore = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() { return cookieStore.getAll(); },
        setAll(values) {
          try {
            for (const { name, value, options } of values) cookieStore.set(name, value, options);
          } catch {
            // Server Components cannot write cookies; proxy refreshes them.
          }
        },
      },
    },
  );
}
