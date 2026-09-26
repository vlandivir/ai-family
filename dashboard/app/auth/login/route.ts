import { NextResponse, type NextRequest } from "next/server";
import { serverAuth } from "@/lib/supabase";

export async function GET(request: NextRequest) {
  const supabase = await serverAuth();
  const origin = new URL(request.url).origin;
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: `${origin}/auth/callback`, queryParams: { prompt: "select_account" } },
  });
  if (error || !data.url) return NextResponse.redirect(`${origin}/?auth=error`);
  return NextResponse.redirect(data.url);
}
