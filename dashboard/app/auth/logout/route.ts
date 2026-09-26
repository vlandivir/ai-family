import { NextResponse, type NextRequest } from "next/server";
import { serverAuth } from "@/lib/supabase";

export async function POST(request: NextRequest) {
  const supabase = await serverAuth();
  await supabase.auth.signOut();
  return NextResponse.redirect(new URL("/", request.url), { status: 303 });
}
